# ADR-0098 — Sending an orchestrated attempt once, and recording the answer

Status: Accepted (GS-7c-2b, 2026-10-29). Fifth of the pull requests for row
GS-7 of the generation-to-preview plan the product owner approved on
2026-10-26 (`/mnt/project-files/cto/generation-e2e-proposal.md`), and the
second half of GS-7c-2 (ADR-0097).
Builds on: ADR-0026 (the execution preflight), ADR-0035 (provider submission
certainty), ADR-0036 (the submission outcome), ADR-0083 (Transaction K),
ADR-0084 (Transaction L), ADR-0096 (the gate moves only the source it locked,
audited) and ADR-0097 (discovery and the ending of a refused preparation).

## Context

Every piece of a send exists and nothing joins them. Discovery offers the
attempts waiting (ADR-0097). Preparation signs the photo's URL from the
attempt's frozen snapshot (ADR-0026), and its refusals for good end the attempt
(ADR-0097). The paid-submission gate moves one attempt `QUEUED → SUBMITTING`
for the source preparation signed, with the paid call's audit entry, in one
commit (ADR-0096). The submission outcome records what a provider answered
(ADR-0036). A provider adapter makes the POST (ADR-0035). Two steps of the
sequence recorded before any paid call are not built: the URL's freshness,
checked immediately before the call, and the call itself
(`docs/decisions/TODO.md`, *Phase 4C-3 must complete this sequence*).

## Decision 1 — One runner, in a fixed order

`AttemptSubmissionRunner.runOnce(limit, after)` reads one window of candidates
and takes each through:

```text
prepare     sign the photo's URL; a refusal for good ends the attempt (ADR-0097), one that may pass leaves it
check       this sender reaches the attempt's provider, and the URL has time left
authorize   the gate arms it and writes the audit entry, or refuses and writes nothing
send        one POST through the sender port, only after AUTHORIZED
record      the answer, through the submission outcome
```

The runner takes the gate and the outcome service as built and calls
`prepareQueuedGeneration` itself, so the preparation, the gate and the record
are the ones already decided; it adds the order and nothing else. Each attempt
gets one transition context, so its ending, arm and outcome share a
correlation.

Every step before the gate writes nothing but the ending. A gate refusal
writes nothing (ADR-0096), and the attempt is offered again on a later pass;
which refusals should end an attempt is GS-7d's.

## Decision 2 — Once armed, sent exactly once and recorded

After `AUTHORIZED` the attempt is `SUBMITTING`, and a request to the provider
may cost money. So:

- the sender is called once, never in a loop, and nothing in the runner calls
  it twice for an attempt;
- a sender that throws, or answers with something that is not a well-formed
  observation, is recorded as `SUBMISSION_UNKNOWN` with no code: the request may
  have left, and only reconciliation may say otherwise (ADR-0035);
- a record that throws leaves the attempt `SUBMITTING`, which discovery never
  offers. The stale submission recovery of the reconciliation maintenance turns
  it into `SUBMISSION_UNKNOWN` (ADR-0036); nothing sends it again.

The gate's commit landing and its answer being lost (a dropped connection
after `COMMIT`) also leaves the attempt `SUBMITTING` unsent, and the same
recovery records it unknown. That is the accepted cost of a boundary that is
crossed before the call.

## Decision 3 — The sender port and its adapter

The domain declares `PreparedGenerationSender`: the provider it reaches, and
`send(prepared)`, answering with a `ProviderSubmissionObservation`.
`createPreparedGenerationSender(provider)` in `@app/video-providers`
implements it over any submission adapter:

- the request is the prepared generation's, field by field: model id, signed
  URL, rendered prompt, duration, aspect ratio, native resolution and request
  hash. Nothing current is read;
- `ACCEPTED` carries the prediction id; `DEFINITIVELY_REJECTED` carries the
  error's `retryable`; an error contributes a code only when it is a timeout
  (`TIMEOUT`), and `null` otherwise, because the code vocabulary is closed and
  `null` is always truthful;
- an attempt admitted for another provider is not sent. The runner checks this
  before preparing, so another provider's attempts are left for their own
  sender, unsigned (`OTHER_PROVIDER`). Reached in the adapter anyway, the
  answer is `DEFINITIVELY_REJECTED` with `LOCAL_CONFIGURATION`: the request
  provably never left.

The adapter is the only production caller of a provider's create POST, and a
static test keeps it so.

## Decision 4 — The URL must have time left

Immediately before the gate, the runner requires the signed URL to have at
least `MIN_SOURCE_URL_REMAINING_MS` (300 seconds) left, by its own clock. The
time must cover the gate's transaction, the POST and the provider's own fetch
of the photo. An attempt whose URL has less is not sent and nothing is written
(`SOURCE_URL_STALE`); the next pass signs a new one. The check is before the
gate rather than after, because after the gate the attempt is armed and an
unsent armed attempt can only be recorded as unknown.

300 seconds is half the URL's provisional 600-second life and is provisional
with it, to be measured against a real submission before paid spending
(`docs/decisions/TODO.md`).

## Decision 5 — A job that will fail sends no more in the pass

When an attempt of a job ends in a pass, by preparation's refusal or by the
provider's definitive refusal, Transaction K will fail the job and release its
Unit (ADR-0083). The pass then sends none of that job's other attempts
(`JOB_ENDING`, nothing written), because a request sent for a job that will
fail is paid for and delivers nothing; Transaction L cancels them (ADR-0084).
Discovery carries each attempt's job for this. An attempt left uncertain does
not end its job, but the gate refuses its siblings while the reservation is on
its reconciliation hold.

## Decision 6 — The window moves

Discovery reads after a cursor, `{ createdAt, id }` in its own order
(`AttemptSubmissionCandidateQuery.after`). A pass returns `next`: the last
attempt it was offered when the window was full, or `null`, from the oldest,
when it reached the end. A caller that passes each `next` to the following pass
visits every waiting attempt in turn, so attempts left waiting by a refusal
that may pass, or by a gate refusal, no longer hold the oldest window for every
pass after them, in any organization (ADR-0097, *Keeping the window moving*).
The cursor is the caller's to keep; nothing stores it.

## Decision 7 — Nothing runs it yet

Nothing in production constructs the runner, the repository or the sender
adapter, and a static test keeps it so. The pipeline command (GS-9) is what
will, with the test provider only.

## Not decided here

- **An attempt the gate refuses for good** (GS-7d).
- **Whether a refusal the deployment causes ends a customer's attempt.** The
  runner now calls the ending for `PROVIDER_IDENTITY_MISMATCH` and
  `MODEL_DELIVERY_PLAN_CHANGED`, as the canonical table says. An attempt of
  another provider is passed over before preparation, so a worker for another
  provider never ends one; a misconfigured catalog still would
  (`docs/decisions/TODO.md`).
- **How long a retryable refusal may hold a Unit** (`docs/decisions/TODO.md`).
- **How the pipeline command carries the cursor and when it stops** (GS-9). A
  pass with attempts left waiting always finds work, so "until nothing is left"
  must mean until a pass sends and ends nothing.

## Consequences

- `@app/domain`: `AttemptSubmissionRunner`, its report and outcomes,
  `MIN_SOURCE_URL_REMAINING_MS`, `PreparedGenerationSender`,
  `AttemptSubmissionCursor`, `AttemptSubmissionCandidate` and
  `validateAttemptSubmissionCursor`; discovery's query takes `after`, and each
  candidate names its job.
- `@app/database`: discovery reads after the cursor and returns each attempt's
  job.
- `@app/video-providers`: `createPreparedGenerationSender`,
  `providerGenerationInputFor` and `submissionObservationFor`.
- No migration. Nothing outside tests constructs any of it, so no path a
  customer or a worker reaches changes.
