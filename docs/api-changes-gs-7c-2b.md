# API Changes — GS-7c-2b

Sending an orchestrated attempt once through the paid-submission gate, and
recording the provider's answer (ADR-0098). **No migration; no route and no
page.** Nothing outside tests constructs the runner, the repository or the
sender adapter.

## HTTP

No change.

## Internal API

### Added: `@app/domain`

| Export | What it is |
| --- | --- |
| `AttemptSubmissionRunner` | `runOnce(limit, after)`: one window of candidates, each checked for its provider, prepared, checked for its URL's time left, authorized by the gate, sent once and recorded (up to three tries while recording throws or loses a race), in that order |
| `AttemptSubmissionReport` | `{ sent, ended, failed, stopped, outcomes, next }`; `stopped` when an answer was not recorded and nothing after it was sent; `next` is the cursor for the following pass (after the attempt that stopped it, or the window's last when it was full), or `null` |
| `AttemptSubmissionRunOutcome` | `SENT` (the observation, the record or `null`, and whether the gate warned), `ENDED`, `NOT_PREPARED`, `MOVED`, `NOT_SENT` (`OTHER_PROVIDER`, `SOURCE_URL_STALE`, `JOB_ENDING`, `PASS_STOPPED`), `NOT_AUTHORIZED` (the gate's refusal and reason) or `FAILED` |
| `AttemptSubmissionRunnerDeps` | the repository, the preflight's dependencies, the gate's `authorize`, the sender, the outcome's `recordObservation`, a clock and a context factory |
| `MIN_SOURCE_URL_REMAINING_MS` (300 000) | the time a signed photo URL must have left, immediately before the gate |
| `PreparedGenerationSender` | the sender port: `providerName` and `send(prepared)`, answering with a `ProviderSubmissionObservation` |
| `AttemptSubmissionCursor`, `validateAttemptSubmissionCursor` | `{ createdAt, id }` in discovery's order; `null` or a valid date and a non-empty id, else `VALIDATION_FAILED` |
| `AttemptSubmissionCandidate` | a system generation candidate plus its `generationJobId` |

### Added: `@app/video-providers`

| Export | What it is |
| --- | --- |
| `createPreparedGenerationSender(provider)` | the sender over any submission adapter; one `createGeneration` per `send`, and none for another provider's attempt (answered `DEFINITIVELY_REJECTED`, `LOCAL_CONFIGURATION`) |
| `providerGenerationInputFor(prepared)` | the provider's request, field by field from the prepared generation |
| `submissionObservationFor(outcome)` | the adapter's answer in the submission outcome's vocabulary; only a timeout names a code |

### Changed

| Export | Change |
| --- | --- |
| `AttemptSubmissionCandidateQuery` (`@app/domain`) | now requires `after: AttemptSubmissionCursor \| null` |
| `AttemptSubmissionRepository.findSubmissionCandidates` | reads after the cursor in its own order, and returns `AttemptSubmissionCandidate[]` |
| `createAttemptSubmissionRepository(prisma)` (`@app/database`) | the same, in its query |
