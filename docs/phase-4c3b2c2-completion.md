# Phase 4C-3B-2C-2 — Completion report

The dormant fal / MiniMax H3 Max submission adapter. Base:
`c99c15c536bdf1ceb8bf11f1f1552f485cbb13a1`. Decision record: ADR-0035 §7.

## Size

All counts include documentation.

| Scope | Insertions | Deletions | Total |
| --- | ---: | ---: | ---: |
| Production TypeScript | 377 | 10 | 387 |
| Tests | 460 | 0 | 460 |
| Migration SQL + Prisma schema | 0 | 0 | 0 |
| Documentation (`docs/`, `CHANGELOG.md`) | 345 | 17 | 362 |
| **Everything** | 1,182 | 27 | **1,209** |

Target ≤1,150, hard stop >1,400. **59 over target, 191 under the hard stop.**
Reported, not excepted. Every figure is measured from base `c99c15c` and
reconciles with GitHub's compare; none is hand-maintained.

## The contract

| | Value |
| --- | --- |
| Executable model id | `MINIMAX_H3_MAX_MODEL_ID` from `catalog.ts` — the adapter defines no endpoint constant |
| Queue URL | `https://queue.fal.run/minimax/h3-max/image-to-video`, frozen |
| Authorization | `Key <credential>`, plus `Content-Type: application/json`, and no other header |
| Body | `image_url`, `prompt`, `duration`, `resolution`, `prompt_expansion_mode`, `enable_safety_checker`, and `seed` only when supplied |
| Frozen constants | `prompt_expansion_mode: "balanced"`, `enable_safety_checker: true` |
| Timeout | 60 s, request-specific — the constant is module-local, and the test owns the literal |
| Redirects | `manual` — a 3xx is `SUBMISSION_UNKNOWN`, never followed |

The queue host is a constant, not configuration: the superseded `baseUrl`
override is not restored, since the only thing it could do is send the fal
credential somewhere fal does not operate. `prompt_expansion_mode` and
`enable_safety_checker` are V2 generation semantics frozen in the adapter rather
than exposed as settings — both change what the model produces.

## Certainty

| Case | Outcome |
| --- | --- |
| Unsupported model id (before any HTTP) | `DEFINITIVELY_REJECTED` |
| Blank credential (before any HTTP) | `DEFINITIVELY_REJECTED` |
| 2xx with a valid `request_id` | `ACCEPTED` |
| Everything else after invocation | `SUBMISSION_UNKNOWN` |
| Unexpected pre-invocation defect | **throws** |

"Everything else" is exhaustive by design: 3xx, 400, 401, 403, 408, 422, 429,
every 5xx, transport failure, timeout, abort, malformed JSON, empty body, JSON
`null`, array, scalar, unexpected envelope, and a 2xx whose `request_id` is
missing, non-string, empty or whitespace-only.

**fal deliberately does not copy WaveSpeed's 400/401/403 rule** (ADR-0035 §7).
Certainty and retryability stay separate: a fal result may be
`SUBMISSION_UNKNOWN` with `retryable` either true or false, and neither
authorizes another POST. Only `request_id` is an acceptance handle, trimmed, and
`parseFalQueueRequestId` is total over arbitrary parsed JSON — it never throws,
so a malformed success is a classified outcome rather than an exception.

## Resolution

```text
H3 Max target 1080p
native token   768P
wire value     768P
native 1080p claim = NO
```

The adapter sends `input.nativeGenerationResolution` verbatim. It parses no
provider resolution string, infers no pixels, and converts nothing into a
product label — composition owns the deliverable (ADR-0034).

## Invocation boundary

Two explicitly modelled local refusals may be definitive, because each proves
nothing was sent. Everything else before the call — mapping, headers,
serialization, `HttpRequest` construction and
`this.http.request.bind(this.http)` — sits **outside** the certainty `try`,
which contains one statement: `response = await submitRequest(httpRequest)`.
Exactly one outbound POST per call, and every post-invocation test asserts the
invocation count rather than only the outcome.

## Security

Local error text is a closed set of fixed helpers; the superseded
`falLocalConfigurationError(messageSanitized: string)` is **not** restored,
because a caller-supplied message is an open channel into a field ADR-0031
requires to be application-owned.

The credential is constructor input, appears only in the `Authorization` header,
and is absent from every returned outcome — including the local-refusal path,
asserted with a real credential in scope, which closes the gap the superseded PR
left open. Non-2xx bodies are never parsed; only a validated integer status
survives. `normalizeError` trusts provenance and never shape. `requestHash` is
not transmitted and there is no `Idempotency-Key`.

## Mutation ledger

| ID | Mutation | Result | Detected by |
| --- | --- | --- | --- |
| M7 | fal 422 classified `DEFINITIVELY_REJECTED` | KILLED | 1 failing test |
| M8 | a fal submission timeout classified `DEFINITIVELY_REJECTED` | KILLED | 4 failing tests |
| M9 | an application re-POST added on network failure | KILLED | 3 failing tests |
| M10 | a 2xx without a valid `request_id` accepted | KILLED | 13 failing tests |
| M11 | `requestHash` transmitted as an `Idempotency-Key` | KILLED | 1 failing test |
| M12 | the frozen native `768P` wire value becomes `1080p` | KILLED | 2 failing tests |
| M13 | fal submission redirects followed | KILLED | 1 failing test |
| M14 | the raw fal response body leaks into the normalized error | KILLED | 4 failing tests |
| F1 | a local refusal includes the configured credential | KILLED | 1 failing test |
| F2 | nominal provenance replaced by structural duck typing | KILLED | 1 failing test |
| F3 | `parseFalQueueRequestId` stops being total (JSON literal `null`) | KILLED | 4 failing tests |
| F4 | request construction and transport resolution move inside the certainty `try` | KILLED | 1 failing test |
| F5 | the submission timeout drifts from the 60-second contract | KILLED | 1 failing test |

**13/13 killed.** M7–M14 are the authorized set, run as specified and not
substituted; F1–F5 are additional. Each was applied to real source, gated, and
restored byte-identically; no marker remains.

F5 exists because the timeout regression was previously self-referential: it
imported the production constant and asserted it against itself, so a drift from
60 s would have moved both sides together and stayed green. The constant is now
module-local and unexported, and the test owns the literal 60,000 — which is
what makes F5 killable at all.

## Dormancy

| Requirement | Status |
| --- | --- |
| `VIDEO_PROVIDER` fal support | NO — `z.enum(["fake", "wavespeed"])` |
| `FAL_API_KEY` / `FAL_KEY` in env schema | NO |
| fal branch in `createVideoProvider` | NO |
| Production construction of the adapter | NO — zero non-test callers |
| Real fal call / real WaveSpeed call | NO / NO |
| Paid path reachable | NO |
| Pricing change | NO — H3 Max keeps `pricing: null` |
| `@fal-ai/client` dependency | NO — no manifest or lockfile change |

The five production execution entry points — `createGeneration`,
`prepareQueuedGeneration`, `findNextQueuedForPreparation`,
`claimPreparedForSubmission`, `failQueuedPreflight` — all remain at **zero**
production callers.

## Required phase documentation

| Item | Status |
| --- | --- |
| Architecture diagram | Updated — `docs/architecture.md` status table |
| Entity-relationship diagram | **Not applicable** — no schema change |
| Critical sequence diagram | Covered by ADR-0035 §5's boundary table, which this adapter implements unchanged |
| OpenAPI / API change summary | **Not applicable** — no HTTP API, DTO or route changed |
| Change log | Updated — `CHANGELOG.md` |
| Release notes | **Not applicable** — nothing customer-visible; the adapter is unreachable |
| Database migration notes | **Not applicable** — no migration |
| Phase completion report | This document, plus the whole-phase `docs/phase-4c3b2c-completion.md` |

## Known limitations

- **No fal contract is verified against the live API.** Endpoint, field names,
  native token and the `request_id` envelope come from documentation; all must
  be re-verified before fal is enabled.
- **No pricing.** H3 Max stays `pricing: null`, so no credit amount can be
  derived for it. That is the next separately authorized milestone.
- **Submission-only.** No polling, result retrieval, cancellation,
  orchestration, persistence or reconciliation exists for fal.
