# Phase 4C-3B-1 — Provider diagnostic sanitization foundation

Milestone: Phase 4C-3B-1
Base: `2dddb3beb391667f6f400e5a20a7a5793a11eef1` (merged Phase 4C-3A-2b, PR #44)
Decision record: ADR-0031

> This report is an immutable technical snapshot and carries no lifecycle
> status. The GitHub pull request is the authoritative lifecycle source.

## What shipped

```ts
interface ProviderError {
  kind: ProviderErrorKind;
  retryable: boolean;
  code: string;
  messageSanitized: string;
  providerStatus?: number;   // added — integer 100–599, response-derived only
}                            // `cause` removed

normalizeHttpStatusError(status: number): ProviderError   // body argument removed
asProviderError(value: unknown): ProviderError | null     // replaces the duck cast
isProviderErrorKind / isHttpStatus                        // one runtime authority
```

`summarize` is deleted. `ProviderErrorException` no longer chains a cause. The
fake provider returns one fixed diagnostic. **ADR-0031 carries the reasoning.**

Deliberately **not** in this PR: the submission result union, status certainty,
redirect handling, timeouts, env vars, pricing, fake submission outcomes. All
Phase 4C-3B-2.

## Verification

| Check | Result |
| --- | --- |
| `pnpm typecheck` | 0 errors |
| `pnpm lint` | exit 0 |
| `pnpm test` | **1399 passed**, 63 files (baseline 1345 / 62) |
| `pnpm build` | exit 0 |
| `pnpm test:db` | **213 passed**, 9 files (baseline 213 / 9) |
| `prisma migrate diff --from-migrations` | `No difference detected.` |

## Where each property is proven

Every assertion runs against **hostile** values, not placeholders: five distinct
sentinels standing for a signed source URL, an API token, a customer prompt,
control characters, and provider error text. A failure names which class escaped.

| Property | Proven by |
| --- | --- |
| No status error carries body bytes | 7 statuses × {`createGeneration`, `getStatus`, `cancelGeneration`}, each answered with a body containing every sentinel |
| The unexpected-status message says only the status | Exact string equality on `"…unexpected HTTP status 418"` |
| `providerStatus` equals the real status | Asserted for all 7 statuses, unit and end-to-end |
| A 2xx with no prediction id leaks nothing | Hostile body, `WAVESPEED_MISSING_PREDICTION_ID`, no sentinel |
| Network errors retain nothing | An `Error` whose message, `stack`, `cause`, `errno` and `hostname` all carry sentinels |
| Abort stays a timeout, still clean | Same hostile error renamed `AbortError` |
| A hostile plain object leaks nothing | Non-`Error` throw path |
| Impostors are refused | 8 objects that pass the old `kind` + `retryable` test: bad `code`, non-boolean `retryable`, `kind: "toString"`, unknown kind, object `messageSanitized`, out-of-range `providerStatus`, an array wearing the keys, `null` |
| A *valid* look-alike is stripped | Passes validation but carries `rawBody` and an `Authorization` header — both dropped by rebuilding |
| Real errors survive by value | All 7 statuses round-trip equal |
| The kind vocabulary is one list | All 9 accepted; `toString`/`constructor`/`__proto__`/`hasOwnProperty`/wrong-casing/empty/`null`/`undefined`/number/object/array refused |
| `isHttpStatus` is exact | 100/200/418/503/599 accepted; 99, 600, 200.5, NaN, Infinity, `"200"`, `null`, `undefined` refused |
| A bogus `providerStatus` is dropped | `providerError({ providerStatus: 42 })` emits no such key |
| The fake obeys the contract | Hostile `Error` and hostile non-`Error` both yield the fixed diagnostic |
| No unsafe field exists | Compile-time `never` pin over `cause`/`rawBody`/`response`/`request`/`headers`/`url`/`details`/`meta` on `ProviderError` and `ProviderErrorInit` |
| The exception adds one field | Compile-time: `keyof Omit<ProviderErrorException, keyof Error>` is exactly `"error"` |
| The exception never carries a cause | Runtime: own keys are `["error","name"]`, `cause` undefined — asserted on **every** sanitization case, not once |

## Mutation ledger

| Mutation | Result |
| --- | --- |
| **M1** — raw body summary restored into the unexpected-status message | **4 fail** |
| **M2** — `ProviderError.cause` restored and the raw network error attached | **4 TS errors + 11 runtime fail** |
| **M3** — `new Error(msg, { cause })` restored in the exception | **45 fail** |
| **M4** — fake provider `error.message` passthrough restored | **2 fail** |
| **M5** — weak `kind` + `retryable` duck cast restored | **8 fail** |
| **M6** — `providerStatus` dropped from HTTP-status errors | **28 fail** |
| **M7** — provider body text placed into `code` | **4 fail** |

Every mutated file restored byte-identically, confirmed by `diff` against
pre-mutation copies. No mutation-only code is committed.

**M6's first run applied nothing** — the anchor expected five occurrences and the
file had a sixth indentation, so the edit aborted and the suite passed
untouched. Recorded because a mutation that never applied looks exactly like a
mutation that was not caught; re-run against a correct anchor it fails 28 tests.

**M2 is the only mutation caught at both levels.** Restoring the field is a
compile error against the `never` pin (4 errors) *and* a runtime leak (11
failures) — unlike Phase 4C-3A-2a's M5 and 4C-3A-2b's M7, which were compile-only
because Vitest strips types. It is reported as both rather than as one.

## One deliberate behaviour change

An already-normalized `ProviderError` passed to `normalizeWaveSpeedError` is now
returned **value-equal** rather than reference-equal, because it is rebuilt from
its five validated fields. The existing test asserted `toBe`; it now asserts
`toEqual`, with the reason recorded inline. Rebuilding is what drops a smuggled
`rawBody` from an object that is otherwise valid.

## Honest limitations

- **`ProviderErrorException` still has a `cause` key in its *type*.** The `Error`
  interface declares `cause?: unknown` (ES2022), so a `never` pin over its keys
  can never pass and the key cannot be removed while the class is an `Error`.
  It is pinned at runtime instead — never populated — and the class's own added
  surface is pinned at compile time.
- **Sanitization is not certainty.** 429 and 5xx still report `retryable: true`.
  Nothing may call `createGeneration` until Phase 4C-3B-2 lands the result union
  and the 400/401/403-only definitive allowlist.
- **The response body is still read** by the HTTP client before being discarded.
  Not separating a body-read failure from a transport failure is 3B-2's work.
- **Diagnostics are deliberately less specific**, and no replacement telemetry was
  added. Recovering detail needs a closed, redacted schema decided first.

## Invariants held

Prisma schema and migrations **unchanged** (no migration) · `http.ts` redirect and
timeout behaviour **unchanged** · `config.ts` **unchanged** · `factory.ts`
**unchanged** · environment schema **unchanged** · pricing values and shape
**unchanged** · `createGeneration` signature **unchanged** · `mapToWaveSpeedRequest`
**unchanged** · `parsePredictionId` **unchanged** · `requestHash` computation,
persistence and request body **unchanged**, and no `Idempotency-Key` header exists ·
capability descriptor **unchanged** · state machine **unchanged** · execution
repository, `claimPreparedForSubmission` and preflight **unchanged** ·
`PreparedSourceIdentity` **unchanged** · storage, audit, worker and `apps/web`
**unchanged** · no paid gate · no submission audit · no worker loop · no provider
call · no WaveSpeedAI call.

`createGeneration`, `prepareQueuedGeneration`, `findNextQueuedForPreparation`,
`claimPreparedForSubmission` and `failQueuedPreflight` all remain at **zero**
production invocation sites.
