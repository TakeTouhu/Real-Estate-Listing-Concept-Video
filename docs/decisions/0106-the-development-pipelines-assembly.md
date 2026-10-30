# ADR-0106 — The development pipeline's assembly

Status: Accepted (GS-9b-1, 2026-10-30). The second milestone of row GS-9 of
the generation-to-preview plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`: "the pipeline command",
run only when a person or a test starts it, only with the test provider, never
in production). Builds on: ADR-0085 (the shared folder), ADR-0090 (the test
route kit), ADR-0091 (the billing cycle's revenue), ADR-0092 (the test
provider's studio), ADR-0095 and ADR-0098 (the launch and the sender) and
ADR-0105 (the moving launch window).

## Context

Every step from a waiting job to a copied clip exists as a runner nothing
builds outside tests. The pipeline command (GS-9c) will run them in order, so
something must build them, once, on the test provider. A survey on `2fc1380`
found what has no factory outside tests: an exchange-rate source, a reader for
the test provider's photos, an `https` base for the shared folder's signed URLs
(preparation refuses every attempt without one, `SIGNED_SOURCE_URL_UNUSABLE`),
a reconciliation policy, and the ids and contexts each runner takes. Static
tests forbid building each runner outside its own module.

GS-9b is split in two, each its own pull request:

- **GS-9b-1** (this record): the assembly, and the steps from a waiting job to
  each clip copied into the shared folder, with the two that give a Unit back
  when an attempt fails (Transactions K and L) and the maintenance of attempts
  left at the provider boundary.
- **GS-9b-2**: the rest: media validation and its failure resolution, scene
  delivery (F), the composition plan (I), the composition (J) and the final
  validation (G).

## Decision 1 — One assembly, in the worker, that runs nothing

`assembleDevelopmentPipeline(env, { providerFolder }, { prisma, renderer? })`,
in `apps/worker/src/development-pipeline/`, builds the runners and returns
them. It calls none of them, starts no timer and reads no argument. Nothing in
the worker's start-up, the web app or the operator commands names its folder,
and a static test keeps it so. The pipeline command (GS-9c) will be its only
caller.

It is in the worker because the worker is where generation runs (ADR-0024).
The operator commands in `apps/ops` act on production's database, and the
pipeline never does.

## Decision 2 — Refused before anything is opened

The assembly refuses, in this order and before any folder is created or any
client is built:

- `NODE_ENV` of `production`, given or in the process;
- `VIDEO_PROVIDER` other than `fake`;
- no `SHARED_STORAGE_DIR`;
- a test provider folder that is not an absolute path.

Each is a `CONFIGURATION_ERROR`. The shared folder, the route kit, the studio
and the clip maker refuse production themselves too (ADR-0085, ADR-0090,
ADR-0092), so the refusal holds twice.

## Decision 3 — Signed URLs under an address that cannot resolve

The assembly opens the shared folder the web app stores photos in, from the
same `SHARED_STORAGE_DIR` and `STORAGE_SIGNING_SECRET` (ADR-0085), and signs
under `https://development.invalid/api/storage`. Preparation refuses a source
URL that is not `https` with a host, and `.invalid` is reserved never to
resolve (RFC 6761), so no URL the pipeline signs can be fetched by anyone. The
token is the same HMAC token, under the same secret, that the web app's
download route redeems, so the route would serve a pipeline token too, for as
long as it lasts. Nothing stores the URL.

## Decision 4 — The test provider reads a photo as the download route serves it

`createSharedFolderPhotoReader` reads a URL only when its origin and path are
the base's download path and its token was signed with the shared folder's
secret, for download, has not expired and names a key that may be signed
(ADR-0074). The web app signs with the same secret, so a download token the web
app made is read too; the base is what it must be under. The
bytes are the shared folder's at that key. Anything else reads as nothing; the
studio then makes no clip, and the test provider refuses the request, as a real
provider refuses a URL it cannot fetch (ADR-0092).

The DS-4 shape test names this reader, beside the download route, as the only
application code that redeems a token or reads stored bytes, and pins that it
reads the key the verified token names.

## Decision 5 — One studio, and the test route's own rate and price

One studio serves the test provider, the status source and the byte source,
since the byte source opens only the locators its own status source issued
(ADR-0092). Its clips are kept in the test provider's folder, which the caller
names. The clip maker is FFmpeg's unless one is given; the database suite gives
a stand-in, since its CI job has no FFmpeg.

The launch planner prices against the test route's fixed development exchange
rate, `{ current: () => Promise.resolve(kit.fx) }`, typed as an
`FxRateSource`. The media-recovery dormancy test admits that one line, once, in
this file only. The planner and the paid-submission gate use the route kit's
catalog. The gate's revenue is the billing cycle's own (ADR-0091), so an
organization the pipeline runs for needs a Standard or Premium period, as
`provision-subscription` opens.

## Decision 6 — What each step is given

- **Launch**: the route kit's policy, models and prices, the rate above, the
  system clock, and random ids (`gatt_` for an attempt, `gpsn_` for a pricing
  snapshot).
- **Submission**: preparation over the asset repository, the shared folder and
  the kit's models; the gate over its repository with the kit's prices, the
  system clock and the kit's route policy; the sender over the test provider
  with the studio; the submission outcome with the policy of Decision 7.
- **Provider output**: the polling reader, the studio's status source, the
  streaming copy at its 512 MiB ceiling into the shared folder's S3-shaped
  client, and the completion service.
- **Maintenance at the provider boundary**: the policy of Decision 7.
- **K and L**: the system clock.

Each transition gets a worker's context: no user, its own random correlation,
no cause or reason, empty metadata, and `pipeline.<step>` as its event label.
Most repositories label their own events; this label is only the fallback.

## Decision 7 — Development values for reconciliation

A one-hour reconciliation window, and an attempt presumed lost after 15
minutes at the provider boundary. The test provider answers within the call,
so an attempt left there that long was abandoned by a run that stopped. These
are development values. Production's are still an activation decision
(`docs/decisions/TODO.md`, "production stale-`SUBMITTING` threshold"), and the
assembly is refused in production.

## Decision 8 — Static tests admit the assembly by name

Each dormancy test that forbids building a step outside its module now admits
`apps/worker/src/development-pipeline/assembly.ts`, for the constructors and
factories it calls and for nothing that would run a step:

| Test | Admits |
| --- | --- |
| `job-launch/dormancy` | the planner, the runner and the three repositories |
| `attempt-submission/dormancy` | the runner, its repository and the sender |
| `attempt-failure-settlement/dormancy`, `failed-job-scene-closure/dormancy` | the runner and the repository; no call of either |
| `provider-output/dormancy`, `fal/queue-status-dormancy` | `createProviderOutputRunner`; no batch |
| `managed-output/dormancy` | `createProviderOutputRunner`, the streaming copy, the staging sink over the shared folder's client, and the process runner; no batch and no `S3Client` |
| `media-validation-lifecycle/dormancy` | the process runner, for the clip maker |
| `media-recovery/dormancy` | `: FxRateSource =` once, in the exact line of the test route's rate |
| `fake/route-kit` | the route kit, the studio and the clip maker |
| `shared-folder-storage` | opening the shared folder |
| `clean-master/clean-master-shape` | the photo reader, as above |

A new test in the folder pins that it holds the assembly and the photo reader
only; that neither runs a step, starts a timer or reads an argument; that
neither names `fetch(`, an HTTP or socket module, an HTTP client, the AWS SDK,
an `S3Client`, the AI providers, the WaveSpeed or fal adapters or the
provider factory; and that nothing in the worker's other files, the web app or
the operator commands names the folder.

## Considered and not done

- **Signing under the web app's local address.** Preparation refuses `http`,
  and a URL that resolves invites a fetch.
- **Injecting the process runner rather than the clip maker.** The clip maker
  is the one piece the database suite must replace; FFmpeg's own runner stays
  the default.
- **The assembly in `apps/ops`.** Its commands act on production's database,
  its shape test pins its files, and the pipeline is development only.

## Not decided here

- The command: the order of its passes, the cursors it carries, when it stops,
  what it reports, and how a person starts it (GS-9c). Among them, where the
  test provider's folder is when the person names none.
- The steps after a clip is copied (GS-9b-2).
- Whether the command refuses a database that holds another provider's
  attempts. The steps read every organization's rows in the database they are
  given; only the sender passes over another provider's attempts. A
  development database holds none, since nothing can send to another provider
  while paid activation is blocked. If one did, the output pass would poll
  them through the studio, which refuses them and writes nothing, and the
  maintenance would apply this record's development values to them (GS-9c).

## Consequences

- `apps/worker` depends on `@app/database`, `@app/domain` and `@app/storage`,
  and gains `src/development-pipeline/`: `assembleDevelopmentPipeline`,
  `developmentPipelineContext`, `DEVELOPMENT_SIGNED_URL_BASE`,
  `DEVELOPMENT_RECONCILIATION` and `createSharedFolderPhotoReader`, with the
  types `DevelopmentPipeline`, `DevelopmentPipelineEnv`,
  `DevelopmentPipelineOptions`, `DevelopmentPipelineDeps`,
  `DevelopmentPipelineStep` and `SharedFolderPhotoReaderOptions`.
- The static tests of Decision 8.
- No migration, no route, no page, no environment variable.
