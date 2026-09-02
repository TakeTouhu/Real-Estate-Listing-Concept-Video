# Phase 4C-3B-2C-1 — Completion report

Provider-neutral submission certainty: the contract, the WaveSpeed
implementation, and the Fake provider.

Base: `544e35afd9bb53ab8e6091f2a01a70c302807892`. Decision record: ADR-0035.

> Phase 4C-3B-2C is **not** complete. This is the first of two subphases; the
> fal / H3 Max submission adapter is 3B-2C-2 and is not implemented here.

## Size

Measured against base. All counts include documentation.

| Scope | Insertions | Deletions | Total |
| --- | ---: | ---: | ---: |
| Production TypeScript | 487 | 89 | 576 |
| Tests | 678 | 47 | 725 |
| Migration SQL + Prisma schema | 0 | 0 | 0 |
| Documentation (`docs/`, `CHANGELOG.md`) | 482 | 16 | 498 |
| **Everything** | 1,647 | 152 | **1,799** |

Target ≤1,600, hard stop >1,800. **199 over target, 1 under the hard stop.**
Reported, not excepted; no size exception is requested.

Documentation prose was tightened three times against this ceiling, the last to
absorb the programmer-defect correction. No discriminating test was removed.

`docs/SystemArchitecture.md` is included and **CTO-approved for this subphase**
despite not being in §10's list: it declared
`createGeneration(...): Promise<ProviderGenerationRef>`, which this branch makes
wrong, so the canonical document would otherwise point implementers at the
pre-change return type.

## What changed

`createGeneration` returns `ProviderSubmissionOutcome` — `ACCEPTED`,
`DEFINITIVELY_REJECTED`, `SUBMISSION_UNKNOWN` — and no longer throws for
expected provider or transport failures. `SUBMISSION_UNKNOWN` is the default; an
adapter must positively establish non-acceptance to say anything else. The union
carries **no `retryable` and no HTTP status of its own**, pinned at compile time.
Submission became its own port, `VideoGenerationSubmissionProvider`. ADR-0035
carries the rationale.

### WaveSpeed certainty

| Response | Outcome |
| --- | --- |
| 2xx with a usable prediction id | `ACCEPTED` |
| `400`, `401`, `403` | `DEFINITIVELY_REJECTED` |
| `422` (**changed**), `429`, 5xx, 3xx, unlisted 4xx | `SUBMISSION_UNKNOWN` |
| 2xx with no usable prediction id | `SUBMISSION_UNKNOWN` |
| Transport failure or timeout | `SUBMISSION_UNKNOWN` |
| An unexpected local defect, before invocation | **throws** — see below |

422 is no longer definitive because the currently verified WaveSpeed contract
does not establish it as proof of non-acceptance. No claim is made about what
WaveSpeed does internally with a 422; none has been verified.

**There is no `DEFINITIVELY_REJECTED` before invocation on this path.** Only an
*explicitly modelled* local refusal may claim one, and this adapter has none, so
the mapper call is deliberately unguarded and an unexpected defect propagates.
Catching it would convert an unknown bug into a financial claim (ADR-0035 §5).

The allowlist is a `switch` with **no exported backing collection** — an
exported array would be a mutable object controlling a financial
classification. Tests restate the three statuses independently and sweep every
status from 100 to 599 to prove nothing else is definitive.

### Malformed provider success

`parsePredictionId` is now total over arbitrary parsed JSON, returning
`string | null`. It previously asserted its argument into an envelope type and
read a property off it, so a body of exactly `null` raised a `TypeError` — a
defect escaping the one method whose failures must all be classified outcomes.
The guard is a runtime check; a valid identifier is trimmed. Its diagnostic no
longer claims acceptance, only that no usable prediction id was present.

### At most one outbound POST

Exactly one `fetch` per request with no retry anywhere in the transport;
`redirect: "manual"` so a followed 3xx cannot become an unauthorized second
POST; an explicit 60 s timeout separate from the client-wide 30 s default. Every
submission test asserts the outbound call count, not only the outcome. The
`HttpClient` seam moved to the package root, since it is not WaveSpeed's;
`wavespeed/http.ts` remains a re-export shim.

## Mutation ledger (§8)

Every mutation was applied to real source, gated, and restored byte-identically
(asserted by the harness and confirmed by a clean `git status`).

| ID | Mutation | Result | Detected by |
| --- | --- | --- | --- |
| MP | an arbitrary pre-invocation defect is caught and called `DEFINITIVELY_REJECTED` | KILLED | 1 failing test |
| M1 | `createGeneration` returns `ProviderGenerationRef` directly again | KILLED | 6 type errors |
| M2 | WaveSpeed 429 classified `DEFINITIVELY_REJECTED` | KILLED | 3 failing tests |
| M3 | WaveSpeed 422 classified `DEFINITIVELY_REJECTED` | KILLED | 2 failing tests |
| M4 | malformed WaveSpeed 2xx treated as definitive rejection | KILLED | 12 failing tests |
| M5 | a WaveSpeed submission timeout is retried once | KILLED | 3 failing tests |
| M6 | WaveSpeed submission redirects are followed | KILLED | 1 failing test |
| M15 | `SUBMISSION_UNKNOWN` made equivalent to `error.retryable === true` | KILLED | 5 failing tests |
| MN | `parsePredictionId` stops being total (JSON-literal `null` 2xx) | KILLED | 4 failing tests |
| E1 | no WaveSpeed status is ever definitive | KILLED | 5 failing tests |
| E2 | a WaveSpeed transport failure is called a rejection | KILLED | 4 failing tests |
| E3 | submission uses the client-wide default deadline | KILLED | 1 failing test |
| E4 | the malformed-2xx diagnostic claims the submission was accepted | KILLED | 1 failing test |
| E5 | the outcome union grows a `retryable` flag of its own | KILLED | 5 type errors |

**14/14 killed.** M1–M6, M15 and MN are the required set; E1–E5 are retained
WaveSpeed mutations from the superseded work; MP is the programmer-defect
boundary. All are additions — nothing was removed or substituted.

MP's evidence is one test injecting the defect through the input itself, via a
throwing getter, so no injection framework was added. Under the mutation the
`TypeError` becomes `DEFINITIVELY_REJECTED`; the test requires it to propagate,
transport never called.

## Security

Every ADR-0031 regression is preserved. The `createGeneration` cases now read
the returned outcome instead of catching an exception, with every secrecy
assertion unchanged and one added: the whole outcome is serialized and checked,
so a future field on either failure arm carrying provider bytes fails the suite.
`getStatus` and `cancelGeneration` still assert the thrown form, and a
transport-failure case was added on the polling path.

No error message contains a row id, `requestHash`, provider name, provider model
id, model key, prompt, signed URL, or customer data. No `any`, no `@ts-ignore`,
no cast used to bypass a type — and the one assertion doing runtime work was
removed.

## Dormancy

| Requirement | Status |
| --- | --- |
| Real fal call | No — no fal code in this subphase |
| Real WaveSpeed call | No — every test injects a stub transport |
| Paid path reachable | No |
| Five production execution entry-point caller counts | Zero |
| `VIDEO_PROVIDER` | `fake \| wavespeed`, unchanged |
| `FAL_API_KEY` | Absent |
| fal factory branch | Absent |
| Paid gate / submission audit / worker execution loop | None |

`packages/video-providers/src/fal/` does not exist here; `index.ts` exports no
fal symbol.

## Verification

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | Pass |
| `pnpm lint` | Pass |
| `pnpm test` | Pass — 70 files, 1,587 tests |
| `pnpm build` | Pass |
| `pnpm test:db` | Pass — 9 files, 220 tests |
| Prisma schema parity | `No difference detected.` |
| Schema / migration changes | **Zero** |
| Working tree after mutations | Clean |

## Required phase documentation

| Item | Status |
| --- | --- |
| Architecture diagram | Updated — `docs/architecture.md` status table, and the provider interface in `docs/SystemArchitecture.md`. Neither shows a submission-only adapter, because none exists |
| Entity-relationship diagram | **Not applicable** — no schema change |
| Critical sequence diagram | **Deferred to the whole-phase report** — ADR-0035 §5 tabulates the invocation boundary |
| OpenAPI / API change summary | **Not applicable** — no HTTP API, DTO or route changed |
| Change log | Updated — `CHANGELOG.md` |
| Release notes | **Not applicable** — nothing customer-visible shipped |
| Database migration notes | **Not applicable** — no migration |
| Phase completion report | This document, for the subphase. The whole-phase report is written when 3B-2C-2 lands |

## Known limitations

- **`SUBMISSION_UNKNOWN` is representable but not survivable.** Nothing persists
  it, reconciles it, or holds a credit reservation open while unresolved.
- **Nothing calls `createGeneration`.** The contract is enforced by the compiler
  and the tests, by no runtime path.
- **Neutrality is claimed, not demonstrated.** One implementation cannot show
  the vocabulary is not a WaveSpeed shape wearing a general name; that is
  3B-2C-2's job, and its classifier must come from fal's own published contract.
- **WaveSpeed's allowlist is unverified against the live API.** 400/401/403 is
  reasoned from HTTP semantics, not observed; no live call is authorized.

## Erratum against Phase 4C-3B-2B

`docs/phase-4c3b2b-completion.md` is an immutable merged snapshot and is not
edited. For the record: its "Known limitations" claim that a V1 attempt's
"inputs are gone" overstates the case. The accurate statement — already in that
report's refusal table and ADR-0034 — is that V2 delivery semantics cannot be
proven from a V1 row without reinterpreting historical data.
