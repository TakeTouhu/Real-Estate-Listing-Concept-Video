# API Changes — GS-9a

The launch window moves (ADR-0105). **No migration; no route and no page.**
Nothing outside tests constructs the launch runner or its repository.

## HTTP

No change.

## Internal API

### Added: `@app/domain`

| Export | What it is |
| --- | --- |
| `JobLaunchCursor` | `{ createdAt, generationJobId }`: where a launch window starts, in the candidates' own order of each organization's oldest waiting job, by creation and then id |
| `JobLaunchWindowQuery` | `{ limit, after }`, `after` a `JobLaunchCursor` or `null` for the oldest |
| `validateJobLaunchCursor(value)` | `null`, or a `Date` with a finite time and a non-empty string id; refused with `VALIDATION_FAILED` otherwise |

### Changed

| Export | Change |
| --- | --- |
| `JobLaunchCandidate` (`@app/domain`) | gains `createdAt`, the job's creation instant |
| `JobLaunchRepository.findJobLaunchCandidates` (`@app/domain`) | takes a `JobLaunchWindowQuery` instead of a `JobLaunchCandidateQuery` |
| `JobLaunchRunner.runOnce(limit, after = null)` (`@app/domain`) | takes an optional cursor for its launches, checked before any read; the endings of deleted Properties' jobs still read from the oldest |
| `JobLaunchReport` (`@app/domain`) | gains `next`: the last candidate read when the window was full, whatever its launch answered, or `null` when it reached the end |
| `createJobLaunchRepository(prisma)` (`@app/database`) | the candidate query checks the cursor, reads the window after it, comparing its instant in UTC whatever the session's time zone, and returns each candidate's `createdAt`. `launchJob` is unchanged |
