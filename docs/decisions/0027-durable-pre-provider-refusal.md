# ADR-0027: Durable pre-provider refusal parking

Status: Accepted (Phase 4C-2B)
Date: 2026-08-26

> **Superseded in part by ADR-0030.** `claimQueuedForSubmission` no longer
> exists: Phase 4C-3A-2b replaced it with `claimPreparedForSubmission`, which
> takes a `PreparedSourceIdentity` and locks the asset row. References below are
> the historical record of this milestone, not the current API.

## Context

ADR-0026 gave preflight a closed vocabulary of thirteen refusal reasons and a
canonical disposition for each, then deliberately stopped: `prepareQueuedGeneration`
holds no generation-state authority and writes nothing. A refusal existed only as
a thrown `PreflightRefusalError`, in memory, for the lifetime of one call.

That is not enough to build on. A refused generation stays `QUEUED`, so the next
discovery scan offers it again, preflight refuses it again, and nothing anywhere
records that it was ever looked at. Phase 4C-3 cannot decide what to do with a
row whose history it cannot read.

This milestone gives a refusal somewhere durable to live. It adds no worker, no
orchestrator, no provider call, and no caller: like 4C-1b and 4C-2A before it,
everything here is production-dormant.

## Decision

### 1. Two new legal transitions out of `QUEUED`

```
QUEUED -> FAILED_RETRYABLE
QUEUED -> FAILED_TERMINAL
```

`QUEUED` previously allowed only `SUBMITTING` and `CANCELLED`. Both new edges are
safe precisely because they leave `QUEUED`: **nothing has been submitted**, so
neither can describe an attempt a provider was paid for. That is why the
equivalent edges out of `SUBMITTING` need `SUBMISSION_UNKNOWN` beside them and
these do not — there is no acceptance to be in doubt about.

No other row of the transition table changes. `ACTIVE_SCENE_GENERATION_STATES`,
`TERMINAL_SCENE_GENERATION_STATES`, the `SceneGenerationState` vocabulary, the
partial unique index, the schema and the migrations are all untouched.

### 2. Legal is not automatic

`FAILED_RETRYABLE -> QUEUED` remains legal and remains **unperformed**. There is
no scheduler, no timer, no retry loop, and no worker; this milestone adds none.
The edge exists so a future *explicit* retry policy has somewhere legal to go —
a decision someone makes, not one the machine takes because a row is sitting in
that state.

Whatever implements that later must express the move as an expected-state
compare-and-swap naming `FAILED_RETRYABLE` as the state it replaces, and treat
zero rows updated as "someone else moved it" rather than as success.

The state-machine comments were corrected accordingly. "Legal automatic move"
became "legal move", the `PROCESSING` explanation no longer reads as though a
retryable provider failure walks itself back to `QUEUED`, and the
`FAILED_RETRYABLE` entry now says outright that no actor performs the edge.
`canTransition` answers *is this allowed*, never *does this happen*, and reading
it as the latter is how a parked row would become an unintended re-submission.

### 3. Reason to state, through disposition

```ts
preflightFailureStateFor(reason: PreflightRefusalReason): PreflightFailureState
```

where `PreflightFailureState` is exactly `"FAILED_RETRYABLE" | "FAILED_TERMINAL"`.

There is deliberately **no second per-reason table**. `REASON_DISPOSITION`
already answers "what may be done about this reason"; re-deciding that per reason
would create two places where a reason's fate is written down, and the classic
failure is a `TERMINAL` reason acquiring a `FAILED_RETRYABLE` parking spot in one
file and not the other. Reasons reach a state only *through* their disposition,
via a two-entry `Record<PreflightDisposition, PreflightFailureState>`:

| Disposition | Durable state | Reasons |
| --- | --- | --- |
| `RETRYABLE` | `FAILED_RETRYABLE` | `ASSET_NOT_READY`, `ASSET_UPLOAD_FAILED`, `STORAGE_UNAVAILABLE`, `SIGNED_SOURCE_URL_UNUSABLE` |
| `TERMINAL` | `FAILED_TERMINAL` | `LEGACY_SNAPSHOT_MISSING`, `LEGACY_PROMPT_MISSING`, `REQUEST_HASH_MISMATCH`, `PROVIDER_IDENTITY_MISMATCH`, `ASSET_NOT_FOUND`, `ASSET_UNRECOVERABLE`, `ASSET_FORMAT_UNSUPPORTED`, `ASSET_SOURCE_CHANGED`, `ASSET_OBJECT_MISSING` |

The return type is two states wide on purpose. Widening it to
`SceneGenerationState` would let a future edit return `SUBMITTING` — a licence to
spend money — from a helper whose entire job is to describe work that will **not**
be submitted. Here that is a compile error.

**Both outcomes are parked.** `FAILED_RETRYABLE` does not mean anything will try
again.

### 4. One narrow method on the existing execution port

```ts
failQueuedPreflight(
  generationId: string,
  reason: PreflightRefusalReason,
): Promise<FailedSceneGeneration | null>;
```

`SceneGenerationExecutionRepository` gains exactly one method and stays at three.
A second system-scoped repository was considered and rejected: this port already
exists for precisely this purpose, already resolves tenant identity through
`VideoProject`, and already carries the trust boundary. Splitting the two writes
across two trusted ports would double the surface that can reach a row without
naming its organization, for no isolation gain.

**The target state is derived, never supplied.** There is no state parameter, so
`ASSET_NOT_FOUND` filed as `FAILED_RETRYABLE` is unspeakable rather than merely
discouraged. The `reason` is also what lands in `normalizedErrorCode`, so the
durable state and the durable code cannot describe different failures — they come
from one argument.

Deliberately absent: an `organizationId` input (tenant identity is *resolved*, as
on the other two methods), a changes object, a target state, and any `Error`
parameter. Passing a `PreflightRefusalError` was rejected: it invites persisting
`.message`, and widens what a persistence adapter can reach into.

`FailedSceneGeneration` is its own type, and structurally distinct from
`ClaimedSceneGeneration` rather than only nominally so. That type means *the
licence to spend money on this generation exactly once*; this one means the
opposite, so a value meaning **stop** must not pass where a value meaning **go**
is expected.

Two interfaces carrying identical members would not achieve that. TypeScript is
structural: they would be freely interchangeable however they were named or
documented. The distinction is therefore carried by `generation.state`, narrowed
to `"SUBMITTING"` on the claim and to `PreflightFailureState` on the park. Those
cannot overlap, so neither type is assignable to the other, and the compiler
rejects the substitution. This states no more than both adapters already prove at
runtime before returning.

### 5. Expected-state compare-and-swap

```
UPDATE ... WHERE id = $1 AND state = 'QUEUED'
```

The identical predicate `claimQueuedForSubmission` uses. That is the whole safety
argument: two writers, one row, one `state = 'QUEUED'` — the database picks one.

Order:

1. derive `target = preflightFailureStateFor(reason)`
2. `assertTransition("QUEUED", target)` — legality from the domain, not restated here
3. open the transaction
4. conditional `updateMany`
5. `count === 0` → `null`
6. authoritative re-read **inside** the same transaction
7. validate every post-write invariant
8. return the authoritative `FailedSceneGeneration`

The re-read shares the transaction for the same reason the claim's does:
`updateMany` returns a count rather than rows, and outside a transaction that
read is a TOCTOU window a legal `QUEUED -> CANCELLED` can commit inside. Within
it, the `UPDATE` holds the row lock until commit.

### 6. `null` means one thing

*This caller did not win a `QUEUED` preflight-failure transition.*

Unknown id, already `SUBMITTING`, `PROCESSING`, `SUCCEEDED`, already failed,
`SUBMISSION_UNKNOWN`, `CANCELLED`, or simply lost the race — all identical,
because the caller's next action is identical in every one of them. There is no
preliminary existence read; the CAS decides.

### 7. A won write never returns `null`

If `count === 1`, `null` is no longer available. The database has said this caller
won, so anything that goes wrong afterwards is an invariant failure, not a lost
race, and reporting it as `null` would leave a row parked in a state no caller
believes it wrote. Five invariants are checked and throw `INTERNAL_ERROR` **inside**
the transaction, rolling the write back so the row stays `QUEUED` and stays
discoverable:

- the row exists
- its owning `VideoProject` resolves
- `state` is the derived target
- `normalizedErrorCode` is the reason
- `normalizedErrorMessage` is `null`

The last two are checked rather than assumed because they are the entire product
of this method: a parked row whose code did not persist is indistinguishable from
one parked for some other reason entirely.

### 8. Diagnostics: exact reason, explicit null message

On a successful park:

```
normalizedErrorCode    = the exact PreflightRefusalReason
normalizedErrorMessage = null
```

The reason is persisted verbatim — unprefixed, untransformed — because it is
already a closed machine-readable vocabulary the domain switches on. A prefixed
alternative would need its own drift test against the reason list and would buy
nothing.

**The `null` message is written explicitly, not omitted.** Omitting it would leave
whatever the column already held, and a future explicit requeue policy can return
a row to `QUEUED` still carrying a message from an earlier failure. The durable
code would then describe this refusal while the durable message described the
previous one — a diagnostic worse than none, because it reads as authoritative.

Not persisted: `PreflightRefusalError.message`, any raw cause, signed URLs,
storage keys, prompts, `requestHash`, `organizationId`, `assetId`, or any
arbitrary caller text. The message is not persisted even though every throw site
today uses fixed literal text: `PreflightRefusalError` takes `message: string` as
a free constructor parameter, so canonicality is convention rather than structure,
and a durable diagnostic contract should not rest on convention.

The two columns are consequently no longer provider-only. Their comments in
`types.ts` and in `schema.prisma` now say **execution** diagnostics. The Prisma
edit is comment-only — no field, type, nullability, default, index, relation or
enum changed, and no migration was generated. Parity remains `No difference detected.`

### 9. Only four fields move

`state`, `normalizedErrorCode`, `normalizedErrorMessage`, and the
database-managed `updatedAt`. Nothing else.

`providerPredictionId` and `submittedAt` are **not** cleared. The current
pre-provider path has them null, but a future explicit requeue policy may operate
on an attempt that carries real execution history, and those two columns record
what a provider was actually paid for. Erasing them as a side effect of parking
would destroy the evidence of a charge.

## Concurrency

**Park vs claim (R1).** Both compete on the same predicate, so exactly one wins.
If the claim wins the row is `SUBMITTING`, the park returns `null`, and it can
never overwrite a row someone may already be paying for. If the park wins the row
is parked, the claim returns `null`, and no submission licence for that row can
exist.

**Park vs park (R2).** **First database writer wins. There is no reason
priority.** With two refusals both true of one row, either is a correct record,
and inventing an order would make the durable reason depend on a rule nothing
else in the system knows about. The loser gets `null` and does not write again.

**Cancellation (R3).** Not implemented here. The hard prerequisite stands
unchanged: any future `QUEUED -> CANCELLED` must itself be an expected-state CAS.
The tenant-facing `SceneGenerationRepository.update` carries no state predicate,
so it is not a safe competitor and is not used as one — including in tests.

**Persistence failure (R4).** If the transaction fails, nothing was sent to any
provider — preflight makes no provider call and no claim was taken. The row stays
`QUEUED`, is rediscovered, and is preflighted again; re-running preflight is free
and side-effect-free. This is emphatically **not** `SUBMISSION_UNKNOWN`, which
means a POST may have been accepted and billed. Misusing it here would park
recoverable work for a human over an infrastructure blip. No special state is
added for repository failure.

## Identity

`FAILED_RETRYABLE` is active and **retains** the request identity, so admission
reuses the active attempt and no duplicate is created. `FAILED_TERMINAL` is
terminal and **releases** it, so a later deliberate valid admission may create a
new attempt. Neither membership set changed, and neither did the partial unique
index that reads them.

## Audit

**No audit event is added.** There is no provider POST in this milestone, and
coupling audit I/O into the CAS would put a second failure mode inside the
transaction that decides whether work is parked. The paid-call invariant is
unchanged and still Phase 4C-3's: a durable `generation.submission_started` audit
must succeed **before** the provider POST. A preflight-failure audit event may be
emitted by orchestration later if judged useful; it does not belong in a
repository method.

## Consequences

- A refused generation now has a durable, typed, machine-readable resting place.
- Nothing reads it yet. Production callers of `prepareQueuedGeneration`,
  `findNextQueuedForPreparation`, `failQueuedPreflight` and
  `claimQueuedForSubmission` remain **zero**.
- Phase 4C-3 still owns the orchestration that connects preflight to this method,
  URL freshness immediately before the paid call, the residual asset deletion
  race, the paid-call enable gate, the claim, the submission audit, the provider
  POST, and submission ambiguity.
- A future explicit retry or requeue policy has a legal edge to use and a hard
  requirement to meet: expected-state CAS.

## Alternatives rejected

**A second system-scoped repository.** More trusted surface, no isolation gain;
the existing port already carries exactly this boundary.

**A caller-supplied target state.** Makes reason/state disagreement expressible,
defensible only by a runtime cross-check duplicating the mapping.

**Accepting the `PreflightRefusalError`.** Passes an `Error` into persistence and
invites persisting its message.

**Persisting a canonical message alongside the code.** Would require adding a
a per-reason message map purely to make persistence safe — new surface for a
string that adds nothing the reason code does not already carry.

**A prefixed code vocabulary.** Needs its own drift test against the reason list;
the reason strings are already unambiguous.

**Reason priority on a contested row.** Rejected as above.
