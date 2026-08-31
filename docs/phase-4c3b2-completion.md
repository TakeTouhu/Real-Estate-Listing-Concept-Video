# Phase 4C-3B-2 — Paid submission certainty and transport hardening

Milestone: Phase 4C-3B-2
Base: `2aa05e4357297a5021c6947fe10bb06a52ac7a63` (merged Phase 4C-3B-1, PR #47)
Decision record: ADR-0032

> This report is an immutable technical snapshot and carries no lifecycle
> status. The GitHub pull request is the authoritative lifecycle source.

## What shipped

```ts
type ProviderSubmissionOutcome =
  | { kind: "ACCEPTED";              ref: ProviderGenerationRef }
  | { kind: "DEFINITIVELY_REJECTED"; error: ProviderError }
  | { kind: "SUBMISSION_UNKNOWN";    error: ProviderError };

createGeneration(input): Promise<ProviderSubmissionOutcome>   // was Promise<ProviderGenerationRef>

findUsablePredictionId(payload: unknown): string | undefined  // replaces the throwing parser
isDefinitiveRejectionStatus(status: number): boolean          // the sole 400/401/403 authority

interface HttpRequest {                                        // both optional, both omitted by default
  redirect?: "follow" | "manual";
  timeoutMs?: number;
}
```

**ADR-0032 carries the reasoning in full.** Not repeated here.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | 0 errors |
| `pnpm lint` | exit 0 |
| `pnpm test` | **1497 passed**, 66 files (baseline 1399 / 63) |
| `pnpm build` | exit 0 |
| `pnpm test:db` | **213 passed**, 9 files (baseline 213 / 9) |
| `prisma migrate diff --from-migrations` | `No difference detected.` |

## Where each property is proven

| Property | Proven by |
| --- | --- |
| The allowlist is exactly three statuses | Every integer 100–599 walked; the definitive set collected and asserted equal to `[400, 401, 403]` |
| No fourth status sneaks in end to end | 402, 404, 409, 422, 429, 500, 503 driven through the adapter |
| 400/401/403 reject definitively | Each with its existing kind and code, `providerStatus` recorded, hostile body discarded |
| 34 further statuses are ambiguous | 301, 302, 307, 308, 402, 404–431, 451, 500–599 — each asserted `SUBMISSION_UNKNOWN` |
| Certainty ≠ retryability | 429 and 500 asserted `retryable: true` **and** `SUBMISSION_UNKNOWN` in the same test |
| Acceptance needs a usable id | `data.id`, legacy top-level `id`, and `data.id` winning over both |
| Any 2xx with an id is accepted | 200, 201, 202 |
| Optional metadata cannot revoke acceptance | Malformed `status`, nonsense `urls`, unrecognised `code` — still `ACCEPTED` |
| 12 malformed-2xx shapes are ambiguous | Unparseable JSON, empty body, `{}`, no `data`, missing/empty/whitespace/leading-space/trailing-space/non-string/null id, truncated response |
| Padding is refused, never trimmed | Unit table over 11 unusable id forms, plus end-to-end |
| Transport failures are ambiguous | Network rejection, connection reset, non-`Error` throw, `AbortError` |
| Exactly one POST | Call count asserted on **12** paths: accepted, 400, 401, 403, 422, 429, 500, 307, 308, malformed 2xx, network rejection, timeout |
| Create asks for the hardened transport | `redirect: "manual"` and `timeoutMs: 60_000` on the issued request |
| Scope is preserved | `getStatus` and `cancelGeneration` issue requests with **both** fields `undefined` |
| The real fetch seam honours it | Mocked global `fetch`: one call, `redirect: "manual"`, abort at exactly 60 000 ms and not 59 999 |
| A 307 does not re-POST | One fetch, outcome `SUBMISSION_UNKNOWN` |
| Timeouts are per-request | Override 60 000 vs default 30 000 vs constructor 5 000, each asserted at the boundary millisecond |
| Timers are cleared | After success *and* after rejection: advancing 120 s more leaves the signal unaborted and `getTimerCount()` at 0 |
| Pre-invocation failures still throw | A body that cannot serialize throws with **zero** client calls |
| ADR-0031 secrecy survives | Four sentinels (API key, signed URL, prompt, body text) absent from every failure outcome, including the new ambiguous arm |
| The contract cannot regress | Compile-time: return type is exactly the union; `ref` only on `ACCEPTED`; `error` only on the two failure arms; three exhaustive discriminants; a bare `ProviderGenerationRef` is not assignable |
| The fake obeys the same contract | Defaults `ACCEPTED`; both failure modes carry fixed codes; options type cannot carry `error`/`code`/`message`/`cause`/`body` |

## Mutation ledger

| Mutation | Result |
| --- | --- |
| **M1** — 422 added to the definitive allowlist | **3 fail** |
| **M2** — 429 classified definitive | **4 fail** |
| **M3** — 500 classified definitive | **4 fail** |
| **M4** — malformed 2xx treated as `ACCEPTED` | **14 fail** |
| **M5** — prediction id fabricated when none is usable | **14 fail** |
| **M6** — whitespace-padded ids accepted by trimming | **3 fail** |
| **M7** — `redirect: "manual"` removed from create | **2 fail** |
| **M8** — create-specific 60 s timeout removed | **2 fail** |
| **M9** — POST retried once after a network failure | **6 fail** |
| **M10** — POST retried once after 429 or 5xx | **8 fail** |
| **M11** — throw after an invoked network failure instead of returning UNKNOWN | **8 fail** |
| **M12** — old bare `ProviderGenerationRef` restored | **compile-only: 9 TS errors, 0 runtime failures** |
| **M13** — raw response body restored into the ambiguous diagnostic | **2 fail** |
| **M14** — create-only transport leaked into `getStatus`/`cancelGeneration` | **1 fail** |

Every mutated file restored byte-identically, confirmed by `diff` against
pre-mutation copies. No mutation-only code is committed.

**M12 is compile-only**, the same honest treatment 4C-3A-2a's M5 and 4C-3A-2b's
M7 received: Vitest strips types, so restoring the old return type leaves all 223
provider tests passing while `tsc` reports 9 errors — among them the type-level
assertion that a bare `ProviderGenerationRef` is not an outcome. It is reported
as compile-only rather than as a runtime result.

## Deliberate behaviour changes to existing tests

Three existing tests changed shape, none weakened:

- **A 401 no longer throws.** It returns `DEFINITIVELY_REJECTED`; the test now
  asserts the arm and the same safe diagnostic, including the API-key check.
- **A network throw no longer rejects.** It returns `SUBMISSION_UNKNOWN` while
  keeping its `NETWORK` / `retryable: true` diagnostic — the two assertions
  together are what prove certainty and retryability are separate.
- **`parsePredictionId` is gone**, replaced by `findUsablePredictionId`. The old
  "throws when missing" test is replaced by an 11-case table asserting
  `undefined`, and the 3B-1 sanitization suite reads `createGeneration`'s error
  off the outcome instead of catching it.

## One stale comment corrected

`preset` was described as appearing "in a Quick Start example but not in the
parameter table". It is now a documented optional OpenVideo parameter, so that
wording is corrected in `mapping.ts` and in the test description. **The request
mapping is unchanged** — `preset` is still not sent, now for the stated reason
that the provider defaults it and nothing here selects one.

## Invariants held

Prisma schema and migrations **unchanged** (no migration) · state machine
**unchanged** · execution repository, `claimPreparedForSubmission`,
`failQueuedPreflight` and preflight **unchanged** · `PreparedSourceIdentity`
**unchanged** · `requestHash` computation and persistence **unchanged** ·
environment schema **unchanged** · `config.ts` and factory env wiring
**unchanged** · pricing shape and values **unchanged** · request-body mapping
**unchanged** · storage, audit, worker and `apps/web` **unchanged** · no paid
gate · no submission audit · no orchestration · no provider call · no
WaveSpeedAI call.

`createGeneration`, `prepareQueuedGeneration`, `findNextQueuedForPreparation`,
`claimPreparedForSubmission` and `failQueuedPreflight` all remain at **zero**
production invocation sites.

## Known limitations

- **Nothing consumes the outcome.** Persisting it — the `SUBMITTING →
  PROCESSING / FAILED_* / SUBMISSION_UNKNOWN` transitions — is a later
  orchestration milestone. The union is production-dormant.
- **`SUBMISSION_UNKNOWN` has no automatic exit** and holds the generation
  identity, by design (ADR-0016). Reconciling one still needs a human, and the
  operator path remains open in `docs/decisions/TODO.md`.
- **A 3xx on create is ambiguous rather than investigated.** The `Location` is
  deliberately not followed, so a provider that adopted a redirect-based create
  would surface as unknown until someone looks.
- **The response body is still read** by the HTTP client before being discarded.
  Separating a body-read failure from a transport failure would let a known
  status survive an unreadable body; not done here.
- **Pricing still blocks the paid gate.** Unchanged, and the reason is recorded
  in ADR-0032 and TODO.
