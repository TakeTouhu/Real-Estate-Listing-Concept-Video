# Implementation Roadmap

Version: 2.0
Status: Approved initial-release contract (pre-Commercial-Launch)

Authority: ADR-0052, ADR-0053, ADR-0054.

Phases 0 through 5C are **complete and merged**; their records are in
`docs/phase-*-completion.md` and must not be rewritten. The scope statements below
for completed phases are kept as the plan they were delivered against. **Paid
Provider Activation and production scheduler activation remain BLOCKED**
(ADR-0054 Decision 7).

## Phase 0 — Engineering foundation

Scope:

- repository and monorepo structure
- TypeScript strict configuration
- local development environment
- CI pipeline
- minimal authenticated health-check application
- testing foundation
- architecture decision records
- environment/secret conventions
- WaveSpeedAI provider ADR and adapter contract
- gap analysis and completion report

Completion criteria:

- local setup works from documented steps,
- CI runs typecheck, lint, unit tests, and build,
- authenticated health endpoint and minimal UI work,
- no secrets committed,
- provider interface compiles with a fake adapter,
- Phase 0 completion report lists exact results.

Do not call the real WaveSpeedAI API in Phase 0.

## Phase 1 — Identity, organizations, and tenant isolation

Scope:

- PostgreSQL and Prisma foundation
- users, organizations, memberships, roles, invitations
- authentication/session implementation
- organization-scoped repositories
- audit log foundation
- tenant-isolation tests

Completion criteria: cross-tenant access is denied by automated tests and all writes produce required audit events.

## Phase 2 — Properties and secure media upload

Scope:

- property CRUD
- signed direct uploads
- file-content validation
- malware-scan integration boundary
- EXIF sanitization and image normalization
- private object storage
- asset retention/deletion states

Completion criteria: an authorized creator can upload valid photos and cannot access another organization’s assets.

## Phase 3 — AI analysis and storyboard

Scope:

- room classification adapter
- quality, duplicate, privacy, and safety analysis
- editable room labels and image order
- storyboard generation
- prompt compilation and moderation

Completion criteria: users can review and correct all AI decisions before generation.

## Phase 4 — WaveSpeedAI scene generation

Scope:

- `WaveSpeedVideoProvider`
- configurable model capabilities
- asynchronous prediction submission
- provider status mapping
- verified webhook and bounded polling fallback
- temporary output download and managed-storage copy
- retry, timeout, cancellation, and dead-letter behavior
- provider contract tests behind explicit spending controls

Completion criteria: a scene can be generated end-to-end without exposing API keys, provider IDs, or temporary URLs.

## Phase 5 — Video composition and delivery

Delivered as 5A (composition plan), 5B (composition execution and the managed
final object) and 5C (deliverable validation and the publication boundary). All
three are merged; see their completion reports.

Scope as delivered:

- FFmpeg composition and composition profile v1
- output validation
- the durable deliverable verdict and Transaction G — job `DELIVERABLE_READY`,
  the deliverable pointer, and exactly-once Unit consumption

**Superseded from the original plan:** "human review, approval, rejection" is
removed from the product (ADR-0052 Decision 2), and the original completion
criterion "cannot be shared before approval" no longer applies — customer share
links are not in the initial release at all (ADR-0052 Decision 12).

**Still unimplemented from this phase's scope:** the AI-generated disclosure
renders at no layer, and the company logo pipeline does not exist. Both are
required for the initial release and are tracked in `docs/decisions/TODO.md`.

**DS-1 — the AI disclosure layer v1** (ADR-0071, no migration): the exact text,
Mode A's geometry and six committed transparent images, one per size
composition produces, white at 70% over a faint shadow and never under 12
pixels (the product owner, 2026-10-20). Nothing draws them into a video yet;
DS-2 to DS-6 build the Clean Master, the overlay and the publication gate.

**DS-2 — real FFmpeg in CI** (ADR-0072, no migration): a `media` CI job runs
the dormant composer and inspector on real FFmpeg in all six sizes, and lays
each disclosure image over a real encode on nine backgrounds, neutral and
coloured. The encode keeps the text's lightness within 17 levels of 255 at any
pixel, and under 1.7 on average. No application code changes.

**DS-3 — the disclosure mode, frozen at admission** (ADR-0073, migration 29):
each generation job records the mode it was admitted under and each deliverable
version the mode it was planned under, bound into the plan's input fingerprint
(now v2). Only Mode A can be stored; admission refuses any other mode. Nothing
admits a whole-video generation or draws the disclosure yet.

**DS-4 — the Clean Master record and its internal location** (ADR-0074,
migration 30): one receipt row per composed deliverable version for its
overlay-free master, at `org/{organizationId}/internal/clean-masters/{version}`.
No signed URL of either purpose is made or honoured for any key under
`internal/`. Nothing writes a master yet; DS-5's composition will.

**DS-5a — the Clean Master encode, and the disclosure laid over it**
(ADR-0075, no migration): the composer can encode the overlay-free master at
CRF 16 and make the customer's video from it at the profile's CRF 18 with the
disclosure image for its size laid over it, refusing an image that is not the
reviewed one and handing FFmpeg a private copy of the checked bytes. No input's
tags or chapters reach a composed file. Real FFmpeg in CI proves both in all six
sizes. Composition does not call either yet; DS-5b will.

**DS-5b-1 — storing the Clean Master, and checking it before the disclosure**
(ADR-0076, no migration): a store that keeps the master first-wins under the
internal namespace and copies back exactly the stored bytes with their receipt,
at most 1 GiB; and an inspector that reads a master's frame size and a frame
rate its base and average agree on, refusing a master that is not the
profile's or asks to be shown turned. Real FFmpeg in CI proves every composed
master matches its profile and masters of another size, rate or orientation do
not. Nothing calls either yet; DS-5b-2 runs them in
composition.

**DS-5b-2a — composition's records for the Clean Master** (ADR-0077,
migration 31): the composition claim carries the version's frozen disclosure
mode and its master's key; Transaction J2 records the master's receipt in the
same commit as the video's, and a replay that disagrees about either is a
defect; discovery stops offering work frozen under a profile the build does not
carry or planned under a disclosure mode it does not draw; and two block codes
exist for a master over its ceiling or not usable.
Composition still runs profile v1 and makes no master; DS-5b-2b switches it.

**DS-5b-2b-1 — composition makes the Clean Master first** (ADR-0078, no
migration): composition profile v2. The runner makes the overlay-free master
from the scenes and stores it first-wins, or reuses the one already stored,
checks the stored copy's size and frame rate, makes the customer's video from
it with the version's disclosure, and finalizes with both receipts. A master
over its ceiling or not usable blocks with its own code, and a stored video
found without its master is a defect. Nothing in production runs it.

**DS-5b-2b-2 — every video is made from a recorded master** (ADR-0079, no
migration): Transaction J2 refuses a finalize that names no Clean Master and
records the master on every commit; the composer's one-pass encode of the
scenes into a video is removed; and a media suite runs the runner end to end on
real FFmpeg, the real storage adapters and an in-memory object store, fresh,
from another attempt's master, after a failed store, after a lost lease and
with a master of another size.

**DS-6a — publication requires the disclosure and the master** (ADR-0080, no
migration): Transaction G publishes a version, first or replacement, only when
its composition's frozen profile drew the version's disclosure mode and its
Clean Master is recorded at its canonical key; otherwise it refuses with a
defect and writes nothing. Validation discovery and the claim no longer offer
or validate such a version, and the sweep reports any defect for that
deliverable and goes on to the rest.

**DS-6b — a deliverable must measure its planned size and length** (ADR-0081,
no migration): a video that is not its composition's frozen frame size, or not
its job's admitted length within one frame period, is recorded `INVALID_MEDIA`
with `VIDEO_DIMENSIONS_INVALID` or `DURATION_INVALID` and is not published.
`finalizeValid` and Transaction G refuse a `VALID` verdict off that plan as a
defect, and discovery no longer offers one. The disclosure plan's six
milestones are built, for Mode A; the terminal settlement of an unusable deliverable is
not (ADR-0052 Decision 19, `docs/decisions/TODO.md`).

**GS-1 — a failed deliverable settles its job** (ADR-0082, no migration): the
first milestone of the generation-to-preview plan the product owner approved on
2026-10-26. A composition `BLOCKED` and a terminal `INVALID_MEDIA` or
`INTEGRITY_MISMATCH` verdict settle their job in the same commit: an initial
generation becomes `FAILED_TERMINAL` and its reservation is released, and a
failed replacement returns the job to the video the customer already holds,
charging no Unit (a scene regeneration right it used stays counted, an open
decision). The three failure classes settle identically, and the
generic transition API can no longer end a job that holds a Unit. Provider-side
failures are GS-2's.

**GS-2a — a scene whose attempts ended without a video settles its job**
(ADR-0083, no migration): a bounded sweep, Transaction K, settles a scene request
whose attempts all ended, the newest without a video (a provider refusal, a
provider failure or an unresolved submission). An initial generation's request, scene and job fail
and its Unit is released; a failed scene regeneration returns to the video the
customer already holds, charging nothing and spending no regeneration right. How
the attempt ended never enters the decision. Dormant: nothing in production runs
the sweep. Ending the failed job's other scenes is GS-2b's.

**GS-2b — a failed job's other scenes close** (ADR-0084, no migration): a
bounded sweep, Transaction L, closes each open scene of a failed job once
nothing of it is at the provider. A scene that never started is cancelled with
its pending request; one that started, or whose request was admitted, fails, an
attempt still waiting to be sent is cancelled before submission and its request
fails. A scene with an attempt the
provider may hold waits until that attempt ends; a ready scene is left alone.
Nothing moves money: the job's Unit was released when it failed. Dormant:
nothing in production runs the sweep.

**GS-3 — a shared folder holds development and CI objects** (ADR-0085, no
migration): one folder on disk, named by `SHARED_STORAGE_DIR`, holds the
objects the web app and the worker share in development and CI, and keeps them
across restarts. The web app reads and writes it through the `ObjectStorage`
port and the worker through its S3-shaped seam, both unchanged, so the staging
sink, composition input and output and the Clean Master store run over it as
they are. Refused in production; production storage stays Google Cloud Storage
(Phase 7). The worker opens it with GS-9's pipeline command.

**GS-4a — a storyboard is saved in one commit** (ADR-0086, no migration), the
first of GS-4's three pull requests: a composition's scenes, its
`STORYBOARD_READY` status and its fingerprint are saved in one transaction that
first locks the project row, so a project's scenes always belong to the
fingerprint it carries, and two compositions of one project take turns. The
start step (GS-4b, GS-4c) is to rely on it to copy a storyboard that is current.

**GS-4b — a generation starts in one commit** (ADR-0087, migration 32): under
the project row held `FOR SHARE`, one transaction checks that the project still
holds the storyboard the service judged current, derives the quality from the
project's resolution, creates the job and reserves its Units through
Transaction B, copies the storyboard's scenes with their first requests, and
records the audit entry; or writes nothing. A start key, unique per project,
answers a replay, even one arriving at the same moment, with the job it
started. The job stays `RESERVED`. Nothing outside tests constructs it until
GS-4c's service and GS-10's route.

**GS-4c — the start service** (ADR-0088, no migration), the last of GS-4's
three pull requests: `video.generate` and `unit.consume`, reach, and a deleted
Property's project answered as not found; the replay read before the storyboard
is judged; freshness; the quality and scenes the customer confirmed; the
quality from the project's resolution, offered only where a verified route
serves it (Normal today); scenes composed for generation; the length; the Unit
period opened first; then the start commit, with Mode A, new ids, the server
clock and the audit entry. The commit also re-checks the Property under its
lock. Every refusal writes no job, reservation or `generation.started` entry;
one after the period step leaves only the period and its own entry. Nothing
outside tests constructs it until GS-10's route.

**GS-5a-1 — the route table and price catalog are passed in** (ADR-0089, no
migration): a `RoutePolicy` (version, qualities, routes) that the
paid-submission gate authorizes against, production's when none is passed,
and from which the start's quality offer is built (the start always takes an
offer; production's is Normal only). A policy outside production is built by
`defineRoutePolicy`, which refuses production's version and a quality with no
route. The paid-submission repository verifies snapshots against the catalog
it is given, production's when none is. The authorization record names the
policy's version. Production behaves exactly as before; GS-5a-2's factory,
which refuses production, will pass the test route's.

**GS-5a-2 — the test route is built only outside production** (ADR-0090, no
migration): `createFakeRouteKit` hands out the test provider's model catalog,
a route policy (Normal at 720p, HQ at 1080p, each generated natively, and no
production route), the start's quality offer from the same policy, a nominal
price added to a copy of production's catalog, and a fixed development
exchange rate. It refuses production, given or ambient, and any provider but
the fake one, with no override. Production's tables are unchanged, and nothing
outside tests builds the kit until GS-9's pipeline command.

**GS-5b — a billing cycle's revenue is read from its period** (ADR-0091, no
migration): the Cost Safety Guard's revenue is the monthly price of the plan
the cycle's entitlement period was opened on plus the period's uncancelled
Unit purchases, tax-exclusive, as the product owner decided on 2026-10-27;
Enterprise stays unknown, so its cycles keep pausing. The gate's session
reads the period, its purchases and their cancellations in one statement on
the gate's own transaction, while the cycle's cost-admission lock is held. Nothing outside tests
constructs the paid-submission service until GS-9.

**GS-6 — the test provider makes a real clip from the photo** (ADR-0092, no
migration): `createFakeClipStudio` reads the scene's photo through its signed
URL, makes a clip that slowly zooms into the whole photo and pans across it,
at the request's aspect ratio and native size (720p or 1080p) and length, and
keeps it; the fake provider accepts a request only once its clip is made and
refuses it otherwise. The studio's status source answers for the clips it
keeps, and its byte source streams them to the transfer core. The FFmpeg clip
maker is in `@app/storage`. Both refuse production, and nothing outside tests
builds them until GS-9.

**GS-7a — the concurrent-job limit and a waiting job's launch plan** (ADR-0094,
no migration): each plan records how many jobs may run at once (Standard 1,
Premium 3, Enterprise 5), and a job holds a place from launch until it is
delivered or fails. `JobLaunchPlanner` plans a waiting job whole: one route for
every scene, chosen from the route policy and the model catalog and never
guessed between two, each scene's prompt rendered and priced at one instant
against the one contract in force. Nothing outside tests builds it until the
launch commit (GS-7b) and the pipeline command (GS-9).

**GS-7b — the launch commit** (ADR-0095, no migration): a waiting job starts
under its organization's limit, read from the current subscription, oldest
first and past a deleted Property's job. Under one launch lock per organization
its rows are locked and found as the start wrote them and as the plan was made
from, and the job and every scene start and each scene's first attempt is
admitted in one commit, or nothing is written. The same video started twice
waits for the first. Nothing outside tests runs it until the pipeline command
(GS-9), and the attempts it admits are not sent until GS-7c.

**GS-7c-1 — the boundary an orchestrated attempt crosses** (ADR-0096, no
migration): the legacy executor's discovery, claim and park act only on legacy
rows, so it never claims an orchestrated attempt, which reads `QUEUED` in the
legacy column for life. The paid-submission gate, once its pure rules permit,
locks the attempt's photo and its Property and moves the attempt only while
the Property stands and the photo is still the source preparation signed,
neither deleted nor changed (`SOURCE_INVALID` otherwise), and writes the paid call's `generation.submission_started` audit
entry in the commit that moves it to `SUBMITTING`. Nothing outside tests
constructs either, and nothing sends an attempt until GS-7c-2.

**GS-7c-2a — finding an attempt to send, and ending one refused for good**
(ADR-0097, no migration): discovery offers the orchestrated attempts waiting
to be sent, oldest first, with the organization each belongs to, passing over
any whose job has failed or whose Property is deleted. When preparation
refuses one for a reason that can never pass, such as its photo deleted, the
attempt ends before submission with that reason, in one commit behind the
cost-admission lock, and the attempt failure settlement then releases the
job's Unit. A reason that may pass leaves it waiting for the next pass.
Nothing outside tests constructs either, and nothing sends an attempt until
GS-7c-2b.

**GS-7c-2b — sending an attempt once, and recording the answer** (ADR-0098, no
migration): the sender takes each attempt discovery offers through
preparation, a check that the photo's signed URL has at least 300 seconds
left, the paid-submission gate, one POST through the provider port and the
record of the provider's answer. A send whose answer is lost is recorded as
unknown, never sent again, and a pass that cannot record an answer sends
nothing more. Once one attempt of a job has ended in a pass, the
job's other attempts are not sent in it, since the job will fail and its Unit
is released. Each pass starts after the last attempt the previous one was
offered, so attempts left waiting do not hold back newer ones in any
organization. Nothing outside tests constructs the sender; the pipeline
command (GS-9) is what will, on the test provider only.

**GS-7d-1 — ending a waiting job that can never launch** (ADR-0099, no
migration): a waiting job whose own rows make it impossible fails and its
Units come back, in one commit behind the cost-admission lock: its Property
was deleted (the product owner's decision of 2026-10-29: at once, not after
the 30-day trash period), a fact frozen at the start that the planner refuses
before any catalog, or rows not as the start wrote them. The cause is decided
from the rows the ending locks; a hold that is not `RESERVED`, or a job with an
attempt, is never released. A job refused for a route, a price or a rate keeps
waiting. The launch runner ends a deleted Property's waiting jobs first, then
hands the ending any candidate that can never launch, so such a job, once
its organization has a place to offer it, no longer holds back its queue.
Transaction L then cancels the job's scenes. Nothing outside tests constructs the runner or the repository.

**GS-7d-2 — ending a generating job's attempt whose Property was deleted**
(ADR-0100, no migration): such an attempt, which discovery never offers and
the gate refuses for good, ends before submission with `PROPERTY_DELETED`, in
one commit behind the cost-admission lock with the Property held while it
decides; the attempt failure settlement then fails the job and releases its
Unit, and Transaction L closes its other scenes. The sender ends up to its
limit of them, one per job, before its window, and one the gate refuses as
deleted since discovery at once. An attempt whose photo is gone was already
ended by preparation (GS-7c-2a). Nothing outside tests constructs the sender or
the repository.

**GS-7d-3a — ending a deleted Property's launched job before its video is
assembled** (ADR-0102, no migration): a launched job in `GENERATING`,
`SCENES_READY` or `COMPOSITION_PENDING` whose Property was deleted, with no
delivered video and its Unit `RESERVED`, fails and its Unit comes back in one
commit behind the cost-admission lock, the Property held while it decides.
Transaction L then closes its open scenes; one already at the provider still
finishes there and is never delivered. The launch runner ends them after the
waiting ones and before its launches, so the place each frees is taken in the
same pass. A job being assembled or checked is GS-7d-3b's. Nothing outside
tests constructs the runner or the repository.

**GS-7d-3b — Transaction G refuses a deleted Property's first video**
(ADR-0103, no migration): Transaction G takes the cost-admission lock first and
holds the job's Property `FOR SHARE` after the reservation. Finding it deleted
when it would publish a job's first video, it publishes nothing: the job fails
and its Unit is released in that commit, through the settlement of a cycle with
no usable video, so the cause cannot change the bill. A replacement, a replay
and a stale target are answered as before. Nothing outside tests constructs the
validation repository or its runner.

**GS-8 — planning a video's composition once its scenes are ready** (ADR-0104,
no migration): a dormant runner finds the `SCENES_READY` jobs Transaction I
would plan, oldest first, and calls it once per job with a fresh version id.
The query mirrors every refusal of Transaction I, so a job it would refuse
never holds the head of the batch; a verdict bound to other bytes is offered
and reported as that job's failure on every pass, keeping its place until
someone repairs it. Transaction I is unchanged. Nothing outside
tests constructs the runner.

**GS-9a — the launch window moves** (ADR-0105, no migration): the launch
candidate query reads after a `{ createdAt, generationJobId }` cursor, and each
launch pass returns `next`, the last organization read when its window was
full. A caller that carries it reaches every organization in turn, so
organizations whose oldest job waits for a route, a price or a rate no longer
keep every other organization's jobs from being offered. The instant is
compared in UTC whatever the session's time zone. GS-9 is split into four
milestones: this, the development assembly (GS-9b), the pipeline command
(GS-9c) and its end-to-end test (GS-9d).

**GS-9b-1 — the development pipeline's assembly** (ADR-0106, no migration): in
the worker, one function builds the launch, the submission, the provider
output, the maintenance at the provider boundary and Transactions K and L on
the test provider and the shared folder, and runs none of them. It is refused
in production and unless `VIDEO_PROVIDER=fake`, before anything is opened.
Photos are signed under an `https` address that never resolves, and the test
provider reads each one as the download route serves it. A database suite runs
a started job through the launch, the send and the copy of each clip, and
through the release of its Unit when a clip cannot be made. GS-9b-2 builds the
steps after the copy.

**GS-9b-2 — the steps after the copy** (ADR-0107, no migration): the assembly
also builds media validation and its failure resolution, scene delivery (F),
the composition plan (I), the composition (J) and the final validation that
publishes (G), on the machine's FFmpeg and ffprobe over the shared folder, and
still runs none of them. The database suite now makes a real video through
every step: a started job ends `DELIVERABLE_READY` with its Unit consumed, and
a job whose clips are unusable is retried once and then releases its Unit. The
database CI job installs FFmpeg for it. GS-9c is the command that runs them.

**GS-9c — the development pipeline command** (ADR-0108, no migration):
`pnpm --filter @app/worker pipeline --provider-folder <absolute path>` runs
every step once per cycle, in the order work flows, carrying the launch and
submission windows' cursors, until cycles that change nothing have read both
windows through. It stops at once when a step throws, after the cycle when an
answer from the provider was not recorded, and at `--max-cycles`; it never
waits, and work handed back for later waits for the next run. Every outcome a
step can report is counted as a change, a failure or neither, and a failure
makes the run exit 1. It prints counts only. It is refused in production,
unless `VIDEO_PROVIDER=fake`, on a database not on this machine, and on one
holding any attempt of another provider. The database suite runs its loop: a
started job becomes a published video and the run ends quiet. That is the
end-to-end test GS-9d planned, so GS-9 ends here. Only a test can start a
video until GS-10 gives the customer a way to; the command then takes it to
publication.

**GS-10a — what the start screen offers** (ADR-0109, no migration): the start
service gains `offer`, a read that writes nothing and answers, in the start's
own order, what a start of the project's storyboard would be now: its quality,
scenes, length and Units, with a forecast of how many would come from Base
Units and how many from add-on Units; or why not (not composed, stale,
compose again, quality not offered, too long, no plan, Units short). A Unit
period nobody has opened is read as opening it would hold it. GS-10 is split
into four milestones: this, the product owner's rule on starting again
(GS-10b), the start route in development only (GS-10c) and the start page
(GS-10d). Nothing outside tests constructs the service yet.

Completion criteria as met: a composed deliverable is proved technically valid,
and publication and Unit consumption are one atomic, replay-safe commit.

## Phase 6 — Billing and commercial controls

Scope:

- the approved plans, Units, packages and storage quotas (ADR-0053)
- Unit ledger, including **quality-tagged** added-package blocks and the
  **eligibility-first** consumption order — eligible Base Unit → oldest eligible
  add-on → newest eligible add-on, FIFO within the eligible quality class, with
  the included HQ ceiling enforced inside the Base pool (ADR-0053 Decisions 2
  and 3)
- estimate, reservation, settlement and release
- **no automatic overage**; customer-approved Unit purchase
- Stripe checkout/webhooks for web self-service; invoice/bank transfer for
  sales-assisted contracts, representable **without** a Stripe object
- disclosure-mode change accounting (3 free per video, then 1 Unit per block of 3)
- the internal service-recovery budget
- the **Cost Safety Guard** decision point before any paid submission (ADR-0054
  Decision 3)
- billing reconciliation and admin controls

Completion criteria: generation and billing remain idempotent under retries,
duplicate webhooks and worker crashes; no route is knowingly submitted at a loss.

**Phase 6A — Unit entitlement / ledger foundation** (ADR-0055, migration 17):
entitlement periods with a frozen plan snapshot, quality-tagged add-on blocks,
multi-source eligibility-first allocation frozen at reservation, all-or-nothing
funding, and Transaction G spending the frozen set. Implemented and dormant; the
stale 12-month / 5% constants are removed.

**Phase 6B — the organization subscription and period renewal** (ADR-0056,
migration 18): one subscription per organization (plan, `SELF_SERVICE` or
`SALES_ASSISTED` channel, renewal anchor, commercial reference; Enterprise
sales-assisted only), monthly periods derived from the anchor, and renewal that
opens the period containing an instant on demand and idempotently — no
scheduler. Implemented and dormant.

**Phase 6C — the role templates and the role-assignment ceiling** (ADR-0057,
migration 19): the six ADR-0052 templates and the 27-permission matrix replace
`OWNER`/`ADMIN`/`CREATOR`/`REVIEWER`; every membership path asks the
role-assignment ceiling of every role it touches and audits each refusal;
`REVIEWER` became `VIEWER`; every existing check moved to its specific
permission, reads included. Built first because every commercial mutation
requires `billing.manage`, which did not exist.

**Phase 6D — individual permission grants** (ADR-0058, migration 20): a
member's effective permissions are its template plus its individual grants, with
`property.create` never effective for `VIEWER` or `BILLING`; grants and
revocations go through the grant ceiling (`permission.manage`, the target's role,
`OWNER`-only `permission.manage` / `billing.manage` / `disclosure.none`, delegate
only what you hold), each refusal audited. Dormant: no route or page grants.

**Phase 6E — membership changes made atomic and race-free** (ADR-0059, no
migration): invitation, acceptance, role change and removal each commit with
their audit entry in one transaction; a role change or removal applies only to
the role its ceiling saw; demoting or removing an `OWNER` counts the `OWNER`s
under a lock, so the last one can never be taken away; an invitation is accepted
once. Built before groups, which reuse the pattern.

**Phase 6F — groups and group membership** (ADR-0060, migration 21): an
organization's groups (unique, trimmed names) and their members, with both of a
member row's foreign keys carrying the organization; `group.manage` to change,
`group.view` to list; deletion `OWNER`/`ADMIN`-only even where another role holds
`group.manage`; adding or removing a member under the role-assignment ceiling;
each change committed with its audit entry, each refusal audited. Dormant: a
group confers no permission and no row access yet.

**Phase 6G — group permissions** (ADR-0061, migration 22): a group carries
permissions every member then holds, additively; a CHECK makes `disclosure.none`
impossible on a group, and `property.create` stays ineffective for `VIEWER` and
`BILLING`. Every group change that gives or takes a permission (a grant or
revocation on the group, adding or removing a member of a group that carries
any, deleting such a group) is checked as a direct grant or revocation to each
member it reaches, on the group as locked when the change commits. Changing a
group's permissions needs `permission.manage`. Dormant: no route or page gives a
group a permission.

**Phase 6H — Property assignment** (ADR-0062, migration 23): a Property's
responsible user (for `OWN`) and its group (for `GROUP`), each kept inside the
organization by a foreign key that refuses deletion. Creation sets them by the
creator's role (an `OWNER` or `ADMIN` chooses; a `MANAGER` is its own
responsible user in one of its own groups; a `CREATOR` is its own responsible
user, ungrouped); only an `OWNER` or `ADMIN` changes them later. A group's
deletion ungroups its Properties and a member's removal unassigns theirs, each
counted in its audit entry. Creation and every assignment change commit with
their audit entries. Dormant: no route or page assigns, and reach is not
enforced.

**Near-duplicate rule removal** (ADR-0063, migration 24, before 6I): look-alike
photos are the customer's responsibility (ADR-0052 Decision 14). Each photo is
approved on its own, with no cluster or primary choice; the one-approved-per-group
index is dropped; storyboards admit approved look-alikes; and no response or
screen carries look-alike data. The perceptual hash and duplicate group stay,
internally.

**Phase 6I-1 — Property reach on Properties and photos** (ADR-0064, no
migration): a member reaches the Properties its role's scope selects (every
Property for `OWNER`, `ADMIN` and `BILLING`; its groups' for a `MANAGER`; those it
is responsible for as a `CREATOR` or `VIEWER`). The Property list is filtered in
the query, and every Property and photo path answers a Property out of reach
exactly as one that does not exist.

**Phase 6I-2 — Property reach on analyses, video projects and storyboards**
(ADR-0064, no migration): analyses and their review, video projects,
storyboards and generation admission are reached exactly when their Property
is, and out of reach they are answered as rows that do not exist. A deleted
Property takes no new video project and lists none.

**MFA-1 — authenticator-app MFA, foundation** (ADR-0065, migration 25):
TOTP and recovery codes, the sealed secret, who must use MFA, and `MfaService`,
each change audited. Dormant: no route calls it yet.

**MFA-2 — the security page and two-step sign-in** (ADR-0065, no migration):
anyone may turn on authenticator-app MFA at `/security`, keep recovery codes,
move to a new device and turn it off when their role allows. Once it is on,
signing in asks for a code after the password.

**MFA-3 — mandatory MFA** (ADR-0065 Decisions 15 to 17, no migration): an
`OWNER`, `ADMIN`, `BILLING` or other holder of `permission.manage` or
`billing.manage` who has not set up MFA sets it up at their next request,
before reaching anything else. There is no grace period. The readiness probe
reports a missing `MFA_SECRET_KEY`.

**MFA-4 — an organization's requirement for all members** (ADR-0065 Decisions
18 and 19, migration 26): an `OWNER` or `ADMIN` may require MFA of every member
from the dashboard. Members without MFA set it up at their next request. Off
for every organization until turned on.

**UP-1 — plan provisioning and the Units page** (ADR-0066, no migration): the
first of four Unit purchase pull requests. An operator command gives an
organization the sales-assisted plan its contract names, naming the operator and
the reason in the audit entry. Every member with `unit.view` can see the plan,
the period and the Units left on a new Units page; `billing.view` adds how the
plan is paid. The page writes nothing.

**UP-2 — the Unit purchase record** (ADR-0067, migration 27): the approved
package prices in the catalog, and a purchase approved by a `billing.manage`
holder written with its block and both audit entries in one transaction,
bought once per idempotency key, re-checked under the period's lock.

**UP-3 — the Unit purchase screen** (ADR-0068, no migration): a holder of
`billing.manage` in an invoice-paid Standard or Premium organization can buy one
additional Unit package at a time from the Units page. The confirmation step
states the Units and their quality lock, the price excluding tax, the date they
expire with no carry-over or refund, and that the purchase is invoiced; one
button approves it and the Units are usable at once. Enterprise packages are
listed as bought through sales. The purchase route refuses a post from another
origin.

**UP-4 — this period's purchases and the invoicing export** (ADR-0069, no
migration): a holder of `billing.view` sees each package bought this period on
the Units page, with its price excluding tax, when it was approved and by whom.
An operator command writes the invoice-paid purchases approved in a window to a
new CSV file, per organization and contract, for invoicing; each organization
listed is audited.

**UP-5 — cancelling a mistaken purchase** (ADR-0070, migration 28): an operator
command cancels a purchase made by mistake, after showing it and only with
`--confirm`. Only VTaVision's own mistake is free: its unused Units are
withdrawn at once, Units already used stay used, and the purchase is not
invoiced. The customer's mistake is charged, unless it is cancelled within 10
hours of its approval with none of its Units used. The export marks a
cancelled purchase with nothing to invoice, and the Units page says so.

**Not yet built in Phase 6:** Stripe and sales-assisted billing, subscription cancellation, seats and
storage blocks, upgrade/downgrade, charged disclosure recomposition, the internal
recovery budget, the Cost Safety Guard threshold, and reconciliation/admin
controls. Two decision gates are open: what a customer regeneration costs in
Units, and what happens to a self-service renewal whose payment fails.

## Phase 7 — SaaS operations and production readiness

Scope:

- observability and alerts
- dashboards and support tooling
- backups and restore tests
- retention/deletion automation
- **defense-in-depth rate limiting** (account / organization / IP / endpoint),
  with login brute-force protection
- **real malware scanning**; `PassthroughMalwareScanner` removed from production
- **Google Cloud** deployment: Cloud Run, Cloud Run Jobs, Cloud SQL, Google Cloud
  Storage adapter behind the existing port, Secret Manager, Artifact Registry,
  Cloud Logging/Monitoring, IAM (ADR-0054 Decision 1)
- privileged support access and break-glass, without generic impersonation
- security hardening and threat-model review
- counsel-reviewed terms, privacy, Mode C consent, responsibility boundary,
  versioned legal documents and a published subprocessor list
- provider outage playbooks

Completion criteria: staging production-readiness review passes and
rollback/recovery procedures are tested.

**The production scheduler is not activated by this phase.** Cloud Scheduler
requires explicit CTO activation approval, and the timing values it needs —
stale-`SUBMITTING` threshold, signed-URL TTL, cadence, batch size, worker
concurrency — must come from measured production evidence rather than guesses
(ADR-0054 Decision 4).

## Phase 8 — Closed Beta and launch

Scope:

- **3–5 real-estate companies** in Closed Beta, with hands-on online onboarding
- onboarding and support process
- generation quality and cost tuning
- performance/load testing, which is also what sets the production scheduler's
  timing values
- user feedback and defect closure
- launch metrics and **validation of provisional pricing** — notably the
  additional-storage figure (ADR-0053 Decision 4)

Completion criteria (ADR-0053 Decision 12): 3 companies actively using the
system, 30+ real properties, 100+ completed videos, technically valid deliverable
success rate ≥ 98%, manual operator intervention < 5%, and the core generation
flow completable without support — with these **zero-tolerance** gates:
erroneous/double Unit consumption 0, duplicate Provider charging from blind retry
0, cross-tenant data exposure 0, Sev1 incidents 0, loss-making Jobs 0.

**Customer aesthetic satisfaction is useful feedback but is not a technical
launch gate.** Zero-tolerance gates are not negotiable against percentage KPIs.

## Post-release roadmap

Explicitly deferred, and explicitly retained so none of it is lost:

**Authentication**

- Microsoft Entra ID SSO
- Google SSO
- organization-level SSO-required mode
- possible password-login disablement for SSO-enforced organizations

**Product modes**

- virtual staging
- renovation proposal

**Sharing**

- customer-facing share links: `video.share`, version-fixed links, expiry
  24h/7d/30d (default 7d), optional or organization-required password, view-only
  default, download only when the creator holds `video.download`, manual revoke,
  invalidation on new-version replacement, audit, a VTaVision-hosted share page
  that shows the AI disclosure **even for Mode C** videos, and a traffic Safety
  Guard

**Branding**

- multi-brand, branch-specific logos and templates

**Support knowledge base and assisted triage**

Not in the initial release, and not to be implemented early. The approved
direction:

- maintain a customer-facing **product manual / Knowledge Base**;
- **classify incoming support and incident requests automatically**, triaging on
  severity, security relevance, billing relevance and support topic;
- let routine product and how-to questions be answered by a **support chatbot
  grounded in the approved manual / Knowledge Base**;
- **escalate anything requiring human judgment or privileged action** to support
  staff.

Cases that must generally escalate to a human: suspected security incidents;
possible tenant-boundary or data exposure; billing disputes or billing mutation;
legal and contractual requests; account or permission recovery requiring
privileged action; Sev1 incidents; and any case where the chatbot lacks adequate
authoritative documentation.

**The chatbot must not obtain privileged tenant access merely because it is a
support interface.** A support surface is not a support privilege — the
privileged-access rules of ADR-0054 Decision 6 apply to it exactly as they apply
to a human operator, and nothing about it may reach the operator-recovery
privilege of ADR-0052 Decision 20.

**Other**

- restore-old-version-as-current
- additional Provider routes beyond one primary and one defined fallback

## Delivery rules

Each phase requires:

1. repository inspection and gap analysis,
2. smallest viable vertical milestone,
3. implementation on a dedicated branch,
4. automated checks,
5. phase completion report,
6. focused commits,
7. Pull Request review and merge before the next phase.

Do not mark a phase complete based only on screenshots or documentation. Completion requires working code, test evidence, and merged changes.