# ADR-0156 — Google Cloud Storage: the adapter's objects, over the JSON API

Status: Accepted (RD-3a, 2026-11-18). The first part of the third milestone
of production readiness, part 1, which the product owner approved on
2026-11-16 (`/mnt/project-files/cto/production-readiness-proposal.md`; gap
analysis `docs/production-readiness-gap-analysis.md`). It writes the Google
Cloud Storage adapter's object model, puts the Cloud Storage emulator in CI,
and decides how the adapter's `exists` is ended, which ADR-0153 left to
RD-3.

Builds on: ADR-0054 Decision 1 (Google Cloud Storage is production's
store), ADR-0008 and ADR-0085 (the two development stores and the port they
serve), ADR-0074 and ADR-0115 (canonical keys; what a signed link may
name), ADR-0153 Decision 2 (readiness asks the chosen adapter, by that
adapter's limits).

## Context

The web app's `ObjectStorage` port has two adapters, both refused in
production: the in-memory store and the shared folder. Production's store is
Google Cloud Storage (ADR-0054 Decision 1), and nothing in the repository
speaks to it.

The plan's RD-3 adds the adapter for the web app's port and tests it against
an emulator in CI, with no Google account, credential or deploy. Before it
was written, five investigations, each alone, measured the port's callers,
three clients, how each fails and is ended, the CI and configuration, and then
attacked the design the first four put together. Their reports are in
`/mnt/project-files/cto/rd-3/`. What decides this record:

- An object read answers the same `404` for a missing object and a missing
  bucket, on the emulator.
- `@google-cloud/storage` 8.4.0's own `timeout` does not end its `exists` on
  a store that says nothing: still waiting after 200 to 330 seconds.
- Cancelling one of that library's read streams destroys the keep-alive
  agent every request in the process shares: the other requests failed with
  `ECONNRESET`, in each of three ways of cancelling, two runs of two. A read
  cancelled before its headers, from a store that never answered, kept its
  connection until the process ended: 2.95 seconds in a harness that ends at
  3, still open after 10 in another. gaxios with an `AbortController` let go
  after 0.48.
- gaxios 7.3.1, Google's HTTP client for Node.js, ends a request it gave
  `timeout: 3000` within 3.04 seconds, in every silent or stalled case
  measured.
- Five of the library's 58 packages, resolved on 2026-11-18, were younger
  than two weeks.

RD-3 is split in three for size: this part, the object model; RD-3b, the
streamed read (`readObject`); RD-3c, the wiring (the environment, the choice
of adapter, the start check, readiness, and a credential for production).

## Decision 1 — One client: the JSON API over gaxios

The adapter speaks the Cloud Storage JSON API through gaxios 7.3.1, pinned
exactly as a dependency of `@app/storage`. It does not use
`@google-cloud/storage` or `google-auth-library`.

- **Why not the library.** A read it cancels before the headers keeps its
  connection, which ADR-0115's rule that a cancelled read holds nothing open
  cannot live with; by default its cancel resets other requests; its own
  limit does not end a question; it reads credential variables the process
  is given (`GOOGLE_APPLICATION_CREDENTIALS` among them) without the
  application's say; it brings packages under two weeks old; and it prints
  two `MaxListenersExceededWarning` lines for every streamed read.
- **Why one client.** Readiness keeps asking the chosen adapter about one
  key (ADR-0153 Decision 2): a second client for readiness alone could read
  `ready` where the app's own could not serve, the gap ADR-0155 closed for
  the database. The adapter's own `exists` is the limited question
  (Decision 3), so `readiness.ts` does not change.
- **Why not Cloud Storage's S3 interoperability.** It signs with HMAC keys,
  a credential of its own, which this plan does not create.

gaxios adds ten packages, all published more than two weeks before this
record; the oldest dates from 2018. One, `node-domexception`, is marked
deprecated by its author; `fetch-blob`, under `node-fetch` 3, uses it.
gaxios reads the proxy variables (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`,
and their lowercase spellings) and no other; the `debug` package under its
proxy agent, loaded only when a proxy is used, reads `DEBUG`, every
`DEBUG_*` variable and, where `supports-color` resolves, the colour
variables that reads. A process that sets a proxy variable sends the
store's requests through it, `HTTPS_PROXY` even to an `http` origin, unless
`NO_PROXY` names the host or its origin exactly, or a domain it ends in
written with a leading `.` or `*.`: gaxios ignores a bare parent domain, a
range, `*` and a host with its port there. A proxy's refusal then reads as
the store's own status, and a `DEBUG` that names the proxy agent writes the
proxy's address, password and all, to the log. Measured against a stand-in
proxy. The suites clear the proxy variables; keeping them from production
is open (`docs/decisions/TODO.md`).

Every request is sent once (`retry: false`), every status is read by the
adapter (`validateStatus` accepts all), and a redirect is a refusal, never
followed (`redirect: "manual"`).

## Decision 2 — Absence is proved by a list

A key reads as absent only once a list in the bucket has answered, because
a list answers `404` for its bucket alone.

- `exists` is one list: names beginning with the key, at most one. The key
  sorts before every longer name it begins, so it is there exactly when the
  first name listed is the key. One request proves the bucket and the key.
- `getObject` and `deleteObject` ask for the object first. Only after a
  `404` do they list, and a list that answers makes the object absent: an
  empty read, or nothing to delete.
- An upload names no object, so its `404` is the bucket's.
- A missing bucket is `STORAGE_BUCKET_MISSING` for every operation that
  asks the store.
- A list that cannot be read, or one with nothing on its page and more to
  come, proves no absence: `STORAGE_UNEXPECTED_ANSWER`.

So the deployment's account needs `storage.objects.list` on the one bucket,
beside `get`, `create` and `delete`, as Phase 5B's S3 adapter needs
`s3:ListBucket`. What Google answers an account that may not list, and
whether a `404` for a missing object needs the list permission at all, the
emulator cannot show: it has no permissions. That is a check for the first
deployment (`docs/decisions/TODO.md`).

## Decision 3 — A question is ended by gaxios's own setting

A question that moves no object's bytes, a list, is given
`timeout: GOOGLE_CLOUD_STORAGE_QUESTION_LIMIT_MS` (3,000 milliseconds), a
setting of gaxios's own: gaxios aborts the request itself, and no deadline
is written in the repository's code. That is the reading of the rule on
timers the product owner gave on 2026-11-16, and ADR-0153 Decision 1's for
Prisma: a client's own limit is set without asking and recorded here. The
scheduler guard reads the adapter and finds no timer.

So `exists`, and the list after a `404`, end within the limit against a
store that says nothing, as `STORAGE_TIMEOUT`, having been asked once.
That holds for each caller of `exists`: readiness, once RD-3c wires the
adapter in, and a queued generation's preparation, which asks whether its
source photo is stored and counts a failure as one to try again, once the
worker's production runtime uses the port (part 2). Three seconds is the
limit the readiness probe gives the database (ADR-0153).

The limit is the list's, one request's. In production RD-3c adds a
credential, fetched before the list: that request is to carry a limit of
gaxios's own as well, or a credential that never comes holds `exists`
unended. With both limited, `exists` waits at most the two together
(`docs/decisions/TODO.md`).

A put, a delete and a whole object's read are given no limit. A put or a
delete that is given up leaves the caller not knowing whether it happened,
and a whole object's read is as long as its object; how long each may take
is the deployment's to measure. They are recorded as open
(`docs/decisions/TODO.md`), as the shared folder's writes have no limit
either.

## Decision 4 — A refusal is its code

A request the store does not answer as asked is a `GoogleCloudStorageError`
whose message is its code alone, so nothing the store said, and no bucket,
key, host or address, is passed on:

| Code | When |
| --- | --- |
| `STORAGE_TIMEOUT` | a question was not answered within its limit |
| `STORAGE_FORBIDDEN` | `401` or `403` |
| `STORAGE_RATE_LIMITED` | `429` |
| `STORAGE_UNAVAILABLE` | a `5xx` |
| `STORAGE_BUCKET_MISSING` | the bucket answered `404` (Decision 2) |
| `STORAGE_REFUSED` | any other status, a redirect among them |
| `STORAGE_UNEXPECTED_ANSWER` | a list that cannot be read, or proves nothing |
| the transport's code | one plain word, such as `ECONNREFUSED` |
| `STORAGE_UNREACHABLE` | a failure that names none |

It is not an `AppError`, so a request that meets it is answered
`Unexpected error` with `500`, and readiness logs its code, which it reads
from `code` (ADR-0152). gaxios's own errors carry the request's address and
headers, and none is kept.

A key the store cannot name is a defect in the caller, as in the shared
folder: an `AppError` with `INTERNAL_ERROR` that names no key. A bucket or
an endpoint it cannot use is a `CONFIGURATION_ERROR` that names neither:
Node's error for an address it cannot read carries the whole address.

## Decision 5 — The keys and the bucket it accepts

A key is sent only when it is canonical (ADR-0074), holds no carriage
return, line feed or lone half of a surrogate pair, and is at most 1,024
bytes, which Cloud Storage refuses otherwise. Every character of a key that
is not unreserved is escaped, in a path and in a query alike, so a space,
`+`, `%`, `?`, `#` or a name in Japanese reaches the object it names;
measured on the emulator.

A bucket is 3 to 63 lowercase letters, digits, `-`, `_` and `.`, beginning
and ending with a letter or a digit. Cloud Storage also takes names with
dots up to 222 characters; this adapter does not. It takes some names Cloud
Storage refuses, such as one written as an address or beginning `goog`,
which no bucket can have; no name it takes reaches another path.

The endpoint is an `http` or `https` origin with nothing after it. Which
endpoints production may use, and with what credential, is RD-3c's to
decide, with PR-11 in view, whose end state runs the production image
against the emulator.

## Decision 6 — Signed links stay the application's own

`createSignedUploadUrl` and `createSignedDownloadUrl` make their links
through `signedStorageUrl`, as every store does, so the bucket is never
given a link a browser can use, and an internal-only key or a scene video
is refused as everywhere (ADR-0074, ADR-0115). The guard that lists every
signer names the adapter (`clean-master-shape.test.ts`).

## Decision 7 — Where it stands

- It is exported from `@app/storage/google-cloud-storage`, a subpath of its
  own, so nothing that loads `@app/storage` loads gaxios.
- It has no streamed read yet, so it is not an `ObjectStorage`
  (`GoogleCloudStorageObjects` is the port without `readObject`), and
  nothing in either application constructs it; a test holds that.
- It sends no credential: as written it can speak only to a store that asks
  for none, such as the emulator.

## Decision 8 — The emulator in CI

A new CI job, `storage`, runs `pnpm test:gcs` beside the Cloud Storage
emulator (`fsouza/fake-gcs-server` 1.56.1, pinned by its digest) as a
service container, configured by its `FAKE_GCS_*` variables, since a
service container takes no arguments, and checked by its health route.

The suites read the emulator's origin from
`GOOGLE_CLOUD_STORAGE_TEST_ENDPOINT`. Without it the run fails: Vitest
marks the file failed and its tests skipped. They refuse an origin that is
not on this machine and clear the proxy variables, so none can reach a real
store. Each test makes a bucket of its own.

The emulator proves the adapter's logic only. It has no permissions and
ignores the fields a request asks for, so the adapter reads nothing that a
trimmed answer would leave out, and what Google answers under least
privilege is left to the first deployment.

## What was measured

On this machine, against the emulator built from v1.56.1's source and
against stand-ins on `127.0.0.1`:

- The emulator suite, 8 tests: every operation of the web app's view as the
  shared folder's tests hold it, but the streamed read; an empty object and
  one of 5 MiB byte for byte; a key found by its whole name, never by a
  longer one; keys with characters a URL escapes; a missing bucket refused
  by every operation that asks the store; keys refused, nothing stored, the
  limit counted in bytes.
- The stand-in suite, 25 tests: the requests sent, once each and with no
  credential; keys refused with nothing sent, a lone half of a surrogate
  pair and a key over 1,024 bytes in fewer characters among them; signing
  sends nothing; each status's code, with nothing of the answer in the
  error; a redirect not followed; the lists that prove nothing;
  `ECONNREFUSED`; a store that hangs up, asked once, `ECONNRESET`; a
  silent store ending `exists` after 3.0 seconds, asked once; the list
  after a `404` likewise; a whole object answered after 3.5 seconds still
  read; and that no production code constructs the adapter or names
  gaxios or the adapter's folder in a quoted import path, and that
  `@app/storage`'s own index names neither.
- Both suites pass with `HTTPS_PROXY` naming a proxy that is not there.

## Consequences

- `@app/storage` depends on gaxios 7.3.1; the lockfile gains ten packages.
- CI gains a fifth job, `storage`, which installs no system package.
- No production behaviour changes: the adapter is new source that nothing
  constructs, the environment schema, the choice of adapters, the start
  check and readiness are as they were, and no migration is added.
- RD-3b adds the streamed read (ADR-0157); RD-3c wires the adapter, with a
  credential from the metadata server, and decides the endpoints production
  may use (ADR-0158).
- Nothing is activated: no timer, loop or schedule, no paid call, no
  production credential, no deploy, no Google account.
