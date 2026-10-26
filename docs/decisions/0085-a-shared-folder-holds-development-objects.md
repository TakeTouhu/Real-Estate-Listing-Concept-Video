# ADR-0085 — A shared folder holds development and CI objects

Status: Accepted (GS-3, 2026-10-26). Fourth milestone of the
generation-to-preview plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`, Design 4).
Builds on: ADR-0008 (the `ObjectStorage` port and the non-production adapters),
ADR-0043 (the S3 multipart seam and its first-publish-wins completion),
ADR-0050 (composition input and output), ADR-0074 (the internal namespace and
canonical keys), ADR-0076 (the Clean Master store), ADR-0054 Decision 1
(production object storage is Google Cloud Storage).

## Context

The web app keeps every stored object in `LocalObjectStorage`, a `Map` in its
own memory. An upload is lost when the process restarts, and the worker, a
separate process, cannot see it at all.

The pipeline the plan connects needs one store that both processes see. The web
app stores the customer's photos; the worker reads them, publishes each scene's
video, the Clean Master and the customer's video; the web app then serves that
video for preview and download.

The two sides already speak two contracts, and both are built and tested:

| Side | Contract | Implemented by |
| --- | --- | --- |
| Web app | the domain's `ObjectStorage` port: put, get, delete, exists, and signed upload and download URLs | `LocalObjectStorage` (in memory) |
| Worker | a narrow S3-shaped seam: multipart create, upload part, conditional complete, abort, a streaming get, and `putObjectIfAbsent` | the dormant AWS adapter (multipart and get only, constructed nowhere) and test fakes; nothing implements `putObjectIfAbsent` outside tests |

The staging sink, the media validator, composition input and output and the
Clean Master store all take the worker's seam. Production storage is Google
Cloud Storage (ADR-0054 Decision 1), and its adapter belongs to Phase 7, not to
this plan.

## Decision 1 — A folder on disk, refused in production

`createSharedFolderStorage({ root, secret })` opens one absolute folder. Every
process that names the same folder sees the same objects, and the objects
survive a restart.

It is refused in production three ways:

- construction throws `NonProductionAdapterError` when the process's
  `NODE_ENV` is `production`, and also when the `nodeEnv` it is given is: the
  value a caller passes cannot vouch for the process it runs in;
- unlike `LocalObjectStorage` it has **no** `allowInProduction` escape hatch;
- the environment schema refuses `SHARED_STORAGE_DIR` when `NODE_ENV=production`.

The folder must be absolute, in the schema and at construction, because the
web app and the worker run from different working directories. A relative
path would name two different folders.

**Why a folder, and not a local S3 emulator.** A folder needs no new service, no
new dependency and no credential, for a developer or for CI, and a person can
look inside it. An S3 emulator would exercise the AWS adapter, but production
will not use that adapter, so the exercise would prove nothing about production.

## Decision 2 — Two views of one set of objects

The store hands out two views of the same objects. Neither contract changes, so
every caller runs unchanged; only the object it is handed differs.

- **`objectStorage`** is the `ObjectStorage` port, for the web app. Its signed
  URLs are made by the same helper as `LocalObjectStorage`'s, `signedStorageUrl`,
  which calls the one signer. So an internal-only key is refused a URL exactly as
  before (ADR-0074). The DS-4 shape test now pins the helper and both stores.
- **`objectClient`** is the S3-shaped seam, for the worker, with the one bucket
  `SHARED_FOLDER_STORAGE_BUCKET` (`shared-folder`). A call naming another bucket
  is refused (`404 NoSuchBucket`). So is a call asking for a bucket-owner check
  (`403 AccessDenied`): a folder has no owner, and the caller is told so rather
  than handed an object the check did not cover.

A photo the web app stores through the port is the object the worker reads
through the seam, at the same key, and the reverse holds too.

## Decision 3 — A key is an object, never a path; the folder is this user's

The folder holds `objects/` (one file per key, at the key's own path), `uploads/`
(one folder per multipart upload) and `staging/` (files not yet in place).

Only a canonical key is accepted (ADR-0074): no empty segment, no `.` or `..`,
no `\`, and here also no NUL. So no key can name anything outside `objects/`.
Every key the application builds is canonical, so a refusal is a defect in the
caller. A folder that holds other keys is not an object: reading it answers
"nothing stored".

The folder is readable by the user that runs the processes alone:

- the root and its three folders are created `0700`, or adopted and set to
  `0700`, only when each is a real folder (not a link to one elsewhere) that
  this user owns; otherwise opening fails (`FOLDER_NOT_PRIVATE`);
- every folder made below `objects/` is `0700`, and every stored file `0600`,
  including a file copied in with `putObjectIfAbsent`, whose copy would
  otherwise take its source's mode.

Because nobody else can write into it, anything at a key was put there by this
user. A link put inside `objects/` by hand is followed; the store never makes
one.

## Decision 4 — Object storage's guarantees, from the file system's atomic steps

- **No reader sees half an object.** Every write goes to a fresh file in
  `staging/` first. An unconditional write (`putObject`) is then renamed onto the
  key. A reader that already opened the old object keeps reading the bytes it
  opened.
- **First wins where the seam says so.** A multipart completion and
  `putObjectIfAbsent` put the staged file in place with a hard link, which the
  file system refuses when the key is taken. A losing completion is refused with
  `412 PreconditionFailed`, as S3 refuses it, so the existing sink reads the
  winner's bytes back unchanged (ADR-0043). A losing `putObjectIfAbsent` answers
  `ALREADY_EXISTS`.
- **A multipart upload is invisible until it completes.** Each part's SHA-256
  is checked as S3 checks it (`400 BadDigest`). Completion requires parts in
  ascending order, each with the tag and checksum of the part stored. It holds
  one part in memory at a time: each is read once, checked, and those same bytes
  are appended to the staged file; the staged file must then hold exactly the
  bytes appended, and a failing close fails the completion. Only the conditional
  completion (`If-None-Match: *`) exists: anything else would overwrite a
  published object, which nothing may ask for (`501`). An upload that loses
  stays until it is aborted, as on S3; aborting twice is harmless. An upload id
  the folder did not issue, or one issued for another key, is refused
  (`404 NoSuchUpload`).
- **Absence is proved, never assumed.** A key reads as "nothing stored", in
  either view, only when no file is at it **and** `objects/` is still the folder
  this store opened. The store holds that folder open for its life, so no folder
  put in its place can take its identity, even on a file system that reuses a
  freed inode number. If `objects/` was deleted or replaced, a read or a check
  rejects (`FOLDER_MISSING`) rather than answering "nothing stored", which would
  send a worker to compose again. Something at a key that is neither a file nor
  a folder, such as a device or a pipe, is refused (`NOT_AN_OBJECT`), and opening
  it never waits on a pipe. Every other failure rejects, as ADR-0043 requires of
  an adapter.
- **Bounded reads, closed files.** A stored object is streamed in chunks of at
  most 1 MiB from the open file, which is closed at its end, on cancel and on a
  failed read.
- **Cleanup is best effort.** Removing a completed or aborted upload's folder,
  or a staged file, never changes the answer: once an object is published, a
  leftover part cannot change what is stored.

The folder must be on one local file system that supports hard links, which
every macOS and Linux disk does.

## Decision 5 — A refusal names no key and no folder

A file system error's message is its full path, which contains the organization
and the key. So no such message leaves the store:

- the worker's seam rejects with `SharedFolderStorageError`, which carries an
  HTTP status in `$metadata` (the shape the sink already reads), a fixed name,
  and at most an error code, such as `InternalError (ENOENT)`;
- the web app's view throws an `AppError` with a fixed message and the code;
- a folder that cannot be opened throws `CONFIGURATION_ERROR` with the code
  only, since the web app opens the folder inside a request and the message
  reaches its logs.

The store's own codes are `FOLDER_NOT_PRIVATE`, `FOLDER_MISSING`,
`NOT_AN_OBJECT` and `SHORT_WRITE`.

## Decision 6 — The web app takes it when `SHARED_STORAGE_DIR` is set

`createObjectStorage(env)` in `apps/web/src/lib/property.ts` returns the shared
folder when `SHARED_STORAGE_DIR` names one, and otherwise `LocalObjectStorage`,
as before. `PropertyServices.storage` is now typed as the port. The services
are built once per process, so the folder is opened, and held, once.

Nothing in the worker uses storage yet. GS-9's pipeline command will open the
same folder from the same setting and hand `objectClient` to the runners it
builds. A static test pins what opens the folder in production code, today the
web app's wiring only, so the command's addition gets its own review.

## Not decided here

- **Production storage.** The Google Cloud Storage adapter stays in Phase 7
  (`docs/decisions/TODO.md`). The folder is not a step towards it.
- **How a video is served.** The download route reads a whole object into memory
  and names its content type from the key's extension, and a deliverable's key
  has none. Preview and download of the customer's video are GS-12's.
- **Content type.** The folder keeps no metadata, so a content type given to
  `putObjectIfAbsent` is not stored.
- **Leftovers after a crash.** Nothing removes an abandoned upload or a staged
  file left by a killed process. In development, delete the folder.
- **Retention.** Deleting scene videos after 30 days (ADR-0052 Decision 17) is
  not built for any store.
- **More than one machine.** The folder serves the processes of one machine.
- **Case.** On a file system that ignores case, as macOS's does by default, two
  keys that differ only in case would name one file. Every key the application
  builds is made of random identifiers and fixed names, and two random
  identifiers that differ only in case are, like two equal ones, too unlikely
  to plan for (fewer than one in 10^24 for any two of the 96-bit ones).
- **Windows.** The store opens its folders with POSIX flags; it serves macOS and
  Linux.

## Consequences

- A development machine and CI can run the web app and the worker against one
  store whose objects survive a restart.
- The worker's existing storage code runs over it unchanged. Tests drive the
  real staging sink (one part and several), the real composition source
  materializer and output publisher, and the real Clean Master store over the
  folder.
- `putObjectIfAbsent` has its first implementation outside tests.
- Production is unchanged. The adapter refuses production, the setting is
  refused there, and an unset setting keeps the in-memory store.
- No migration.
