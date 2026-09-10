# Phase 4C-3B-2H-3A — Dormant fal Queue Completion Status Adapter

- Base: `fcea3fe54664095ca2f6e61c6494e243d1707333`
- Decision record: ADR-0040
- Migration: **none**
- Paid provider activation: **still blocked**

## What this phase adds

One concrete implementation of Phase 2H-2's `ProviderCompletionStatusSource`,
for fal's asynchronous Queue API on the MiniMax H3 Max image-to-video route. It
translates fal's lifecycle into the provider-neutral observation Phase 2H-2
already validates, and makes no other change to the system.

## The claim about dormancy has changed, precisely

Phase 2H-2 could truthfully say the repository contained **no concrete polling
implementation**. That is no longer true, and this document does not repeat it.

`FalQueueCompletionStatusSource` builds real `https://queue.fal.run` requests. It
would reach fal if it were handed a credential and called. What remains true, and
what is asserted by tests rather than described, is:

| Claim | How it is held |
| --- | --- |
| Nothing in production constructs it | Static scan over every `apps/web`, `apps/worker`, `packages/database` and `packages/storage` source, plus every `packages/video-providers` source except its own file and the package index |
| Nothing calls the runner it satisfies | The same scan, for `createProviderOutputRunner`, `runProviderOutputAttemptOnce`, `runProviderOutputBatchOnce` |
| No fal credential exists | `FAL_KEY` and `FAL_API_KEY` absent from the environment schema and from every production source; the adapter never reads `process.env` |
| fal cannot be selected | `VIDEO_PROVIDER` is still `z.enum(["fake", "wavespeed"])` |
| No scheduler exists | No `setInterval`, `node-cron` or `cron.schedule` anywhere; the one `setTimeout` is the transport's per-request abort timer |
| No test reaches the network | Neither suite constructs `FetchHttpClient` or calls `fetch`; both inject a scripted transport |

The accurate summary is: **a concrete fal polling implementation exists, and it
has no production composition, caller, or credential wiring.**

## The fal contract implemented

```text
GET https://queue.fal.run/minimax/h3-max/image-to-video/requests/{id}/status
GET https://queue.fal.run/minimax/h3-max/image-to-video/requests/{id}/response
```

Two resources, because fal separates the lifecycle from the artifact — and that
separation is what lets this adapter be correct about money. The first call
establishes whether fal ran and will bill. The second establishes only whether
the platform can currently reach what it produced.

```text
IN_QUEUE                      → { kind: "IN_PROGRESS" }               1 request
IN_PROGRESS                   → { kind: "IN_PROGRESS" }               1 request
COMPLETED, no failure         → { kind: "SUCCEEDED", outputLocator }  2 requests
COMPLETED, no failure, no URL → { kind: "SUCCEEDED", null }           2 requests
COMPLETED, known failure      → { kind: "FAILED", … }                 1 request
COMPLETED, unknown failure    → throw → STATUS_SOURCE_FAILED          1 request
status unreachable/unreadable → throw → STATUS_SOURCE_FAILED          1 request
identity or credential wrong  → throw → STATUS_SOURCE_FAILED          0 requests
```

## The orderings that are load-bearing

**Provider success is durable before output acquisition is attempted.** Once
`/status` returns `COMPLETED` with no failure, fal has billed for the render.
Every failure of the subsequent `/response` call — throw, local timeout, non-2xx,
unreadable JSON, missing `video.url`, blank `video.url` — returns `SUCCEEDED`
with a `null` locator. Never `FAILED`, never a throw. Phase 2H-2 records the
success, answers `OUTPUT_LOCATOR_UNAVAILABLE`, and a later poll may reacquire the
location. The live-PostgreSQL suite proves the reacquisition actually works.

**A status failure is not a provider failure.** The `/status` call throwing,
timing out, returning non-2xx, returning unreadable JSON, or reporting a
lifecycle state fal has not published all throw. The attempt keeps its state,
its `stateVersion` and its certainty, and no transition event is written.

**Identity is validated before a URL exists.** `providerName` and
`providerModelId` are compared against `"fal"` and the compiled-in
`MINIMAX_H3_MAX_MODEL_ID` before anything is built, and the URL is then
interpolated from the *constant* rather than the validated column. A persisted
model id is therefore validated and unused — so even a weakened check could not
turn a database value into outbound network authority.

## Closed failure classification

Thirteen recognized `error_type` values, matched by exact membership. No prefix
matching, no substring matching, no HTTP status as a substitute, and the
human-readable `error` is never parsed.

| `error_type` | Retryable | Diagnostic |
| --- | --- | --- |
| `request_timeout` | ✅ | `TIMEOUT` |
| `startup_timeout` | ✅ | `TIMEOUT` |
| `runner_connection_timeout` | ✅ | `CONNECTION_RESET` |
| `runner_disconnected` | ✅ | `CONNECTION_RESET` |
| `runner_connection_refused` | ✅ | `CONNECTION_RESET` |
| `runner_connection_error` | ✅ | `CONNECTION_RESET` |
| `runner_incomplete_response` | ✅ | `CONNECTION_RESET` |
| `runner_scheduling_failure` | ✅ | `null` |
| `runner_server_error` | ✅ | `null` |
| `internal_error` | ✅ | `null` |
| `client_disconnected` | ❌ | `null` |
| `client_cancelled` | ❌ | `null` |
| `bad_request` | ❌ | `LOCAL_CONFIGURATION` |

`retryable` governs whether a *later* phase may admit a new `SYSTEM_RECOVERY`
attempt. **No `SYSTEM_RECOVERY` attempt is created in this phase**, and the
adapter itself retries nothing.

The diagnostic column reuses Phase 2G-1's three-member catalog unexpanded, so
five entries are `null` — the honest answer rather than a gap. The `error_type`
never reaches the observation, the row or the audit trail.

An unclassifiable failure — missing, blank, wrongly typed or unknown
`error_type`, or a failure claimed only through the prose — throws
`FAL_STATUS_FAILURE_UNCLASSIFIED`. It does not guess. Both guesses are
unrecoverable in opposite directions; refusing leaves the attempt `PROCESSING`
and is fixed by a reviewed code change.

## Security properties

| Property | Held by |
| --- | --- |
| Persisted model id is never URL authority | Compared before any URL exists; the URL uses the constant, and `falQueueStatusUrl` takes no model parameter |
| Provider-returned `response_url`, `status_url`, `cancel_url` are ignored | Never parsed; the result resource is derived identically to the status resource |
| Redirects are not followed | `redirect: "manual"` on both calls, so a 3xx cannot re-send `Authorization: Key …` to a host fal's response chose |
| Request id cannot alter the route | `encodeURIComponent`, plus an outright refusal of dots-only segments, which encoding cannot neutralize |
| Provider logs never fetched | No `?logs=1`; the status URL carries no query string at all |
| Human-readable errors never persisted or exposed | Counted as a failure claim, never parsed; absent from the observation, the thrown error and the database |
| Credential never leaks | Constructor input only, used in exactly one header, absent from every error surface; asserted by an occurrence count |
| Output URL never persisted | Only ever inside `TransientProviderOutputLocator`; the DB suite serializes every column and event payload and searches for it |

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Pass — all 10 projects |
| `pnpm lint` | Pass — 0 problems |
| `pnpm test` | **3476 passed**, 108 files (was 3171 / 105) |
| `pnpm test:db` (live PostgreSQL) | **728 passed**, 22 files (was 706 / 21) |
| `pnpm build` | Pass |
| Prisma drift | `No difference detected` |
| 2F-1 / 2G-1 / 2G-2 / 2H-1 / 2H-2 regressions | Pass, unchanged |

305 unit tests and 22 database tests added. No pre-existing test was modified,
weakened or removed.

## Mutation ledger

**21 mutations, 21 killed, no survivors.**

| # | Defect | Killed by |
| --- | --- | --- |
| N01 | `IN_QUEUE`/`IN_PROGRESS` reported as a provider failure | 4 |
| N02 | `IN_PROGRESS` parsed as completed success | 4 |
| N03 | Completed success never fetches the result | 25 |
| N04 | Result-fetch failure suppresses known provider success by throwing | 4 |
| N05 | Result-fetch failure reported as a provider failure | 33 |
| N06 | Unsupported model still performs HTTP | 6 |
| N07 | Persisted model id becomes outbound URL authority | 6 |
| N08 | Provider-returned `response_url` becomes outbound authority | 2 |
| N09 | Request id not encoded as a single path component | 11 |
| N10 | Provider logs requested from the status endpoint | 12 |
| N11 | Human-readable error used for retry classification | 1 |
| N12 | HTTP status alone classifies a provider execution failure | 13 |
| N13 | `request_timeout` mapped non-retryable | 3 |
| N14 | `bad_request` mapped retryable | 3 |
| N15 | Unknown `error_type` guessed rather than refused | 17 |
| N16 | fal `error_type` leaks into the provider-neutral observation | 33 |
| N17 | Raw output URL returned as a string instead of a nominal locator | 7 |
| N18 | The locator discloses its raw value on serialization | 1 |
| N19 | An automatic retry loop introduced inside the adapter | 10 |
| N20 | A second status request issued per poll | 140 |
| N21 | A result request performed while the render is in progress | 5 |

Counts are failures in **this phase's suites only**; several mutations would also
be caught elsewhere. N11 and N18 are killed by a single test each — deliberately
narrow assertions about exactly one behaviour, not weak coverage of a broad one.

## Not done

- **No managed-output transfer implementation.** `ManagedOutputTransferPort` still
  has no production adapter, and `TransientProviderOutputLocator` still has no
  way to read its value back. Dereferencing is a network capability and is
  reviewed with the adapter that needs it.
- **No production composition.** No route, worker loop, bootstrap or scheduler
  calls either Phase 2H-2 runner; both remain dormant.
- **No credential wiring.** `FAL_KEY` is not in the environment schema.
- **No paid submission activation.** fal and Veo production execution remain
  disabled, the WaveSpeed paid route is unchanged, and no payment integration was
  added.
- **No Scene delivery or Job readiness.** `OUTPUT_VERIFIED` is not customer
  delivery; `SceneGenerationRequest → DELIVERED`, `GenerationScene → READY` and
  `GenerationJob → SCENES_READY` are untouched.
- **No pricing or resolution change.** fal's current documentation may differ
  from earlier frozen assumptions; that reconciliation belongs to the mandatory
  provider-contract reverification before Paid Provider Activation.
