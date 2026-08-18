# ADR-0024: The generation row is the durable queue

Status: Accepted (Phase 4C-1a)
Date: 2026-08-18

## Context

Phase 4B-1b introduced `SceneGenerationQueue` — one method, `enqueue`, whose
documented contract was explicit:

> A rejected promise means the job was **not** accepted; the caller keeps the
> persisted row in `QUEUED` and does not audit it as started.

That contract shaped admission's side-effect ordering (ADR-0017 §10): create the
row, hand it to the queue, and audit only once the queue accepted it. The
ordering was financially motivated and correct *for a design with a transport* —
a record of "requested for execution" must not outrun a handoff that failed.

Two facts have since accumulated against that design.

**Nothing ever implemented the port.** `@app/queue` is a placeholder exporting a
package name. The only `SceneGenerationQueue` in the repository is
`RecordingSceneGenerationQueue`, a test double. Admission has been calling a
handoff that, in production, would be an unimplemented dependency.

**The transport creates the failure mode it exists to prevent.** ADR-0017 §13
recorded the consequence as a mandatory Phase 4C requirement: a row persisted but
not durably enqueued is invisible work, and something must sweep for it. So the
transport needs a recovery mechanism whose only job is to find work the transport
lost — and that mechanism, a scan for `QUEUED` rows, is a complete delivery
mechanism on its own.

## Decision

### 1. `state = 'QUEUED'` is the durable acceptance condition

A worker discovers executable work by scanning for it, over the `@@index([state])`
added in Phase 4A-2a. There is no message, no job record, and no transport.

The invariant this milestone owes:

> Once the row is durably created in `QUEUED`, loss of an in-process wake signal
> must not make the work permanently unreachable.

It holds by construction rather than by recovery: there is no wake signal to
lose. Eligibility is a property of durable state, evaluated independently of
whatever happened in the process that admitted it.

### 2. `SceneGenerationQueue` is removed, not retained as a no-op

An adapter that resolves unconditionally and does nothing would keep the call
site alive while making its contract false in both halves — acceptance would no
longer be conferred by the call, and a row nobody enqueued would still be
executable.

This repository has twice paid for surface that reads as a capability the system
has: `ProviderGenerationInput` carried `negativePrompt` and `cameraMotion` fields
nothing read (removed in Phase 4B-2b), and the WaveSpeed adapter sent three
fields the endpoint does not document (corrected in Phase 4B-2a). A queue call
that cannot fail and delivers nothing is the same defect in a third place.

Removed: the port, `RecordingSceneGenerationQueue`, the `queue` dependency on
`GenerationServiceDeps`, and the enqueue call. `@app/queue` keeps its placeholder
status — it is now honestly empty rather than describing a port nothing
implements.

### 3. Admission is create → audit

```
render/freeze → create QUEUED row → audit generation.requested → return
```

The ordering rationale in ADR-0017 §10 — "audit only after the queue accepted" —
has no referent once nothing accepts. What replaces it is simpler: the row is the
acceptance, so the audit follows the fact it records.

### 4. Eligibility is state, never audit existence

`create` succeeds and `audit` throws: the caller receives the error, and **the
row remains executable**. This is deliberate, and the alternative was considered
and rejected — gating execution on the presence of an audit row would convert a
failing audit sink into silent cancellation of durable, paid-for customer work.
An observability failure must not become a correctness failure.

The exposure that leaves — a generation executed with no `generation.requested`
entry — is closed from the other end. The worker audits the submission itself at
the moment of the provider call, so the guarantee becomes:

> A provider is never charged without an audit entry for that charge.

Closing the requested-side window instead would need the audit write inside the
same transaction as the row insert. That is the transactional-outbox item already
recorded in `docs/decisions/TODO.md` and named in `analysis/ports.ts` as
deliberately outside `ReviewTransaction`'s boundary. This milestone does not
reopen it, and does not close it for one call site while every other audit write
in the system keeps the existing convention.

### 5. What the removed payload guaranteed, restated

ADR-0017 §13 forbade widening `SceneGenerationJob` beyond `{ generationId }`, so
that tenant identity never travelled on a wire. With no wire, the literal
invariant is vacuous. The security properties it protected are not, and they
survive as constraints on what execution *reads and emits*:

- No organization id is duplicated into any execution transport — there is none;
  the worker resolves tenant identity through the generation's `VideoProject`.
- No prompt text, signed URL, provider prediction id, or credential is
  transported, logged, or audited.

### 6. Consistency-window ledger

| Window | Before | After |
| --- | --- | --- |
| Enqueue fails → row `QUEUED`, unaudited, work invisible until a sweep | Live, and ADR-0017 §13 made the sweep mandatory | **Eliminated** — there is no enqueue to fail |
| Audit fails → row exists, work proceeds unaudited | Live | **Unchanged in kind**, and now the only way an executable row lacks `generation.requested` |

No window is introduced. One is removed.

## Consequences

**A rejected `startScene` no longer means nothing happened.** It never fully did
— an enqueue failure already left a durable row — but the surviving case is
narrower and worth stating plainly: if the audit sink fails, the caller sees an
error while the work is admitted and will execute. A later identical request
returns that same row through the existing active-reuse path rather than creating
a second one.

**Phase 4C's `QUEUED` sweep stops being recovery and becomes the mechanism.**
ADR-0017 §13's first requirement is satisfied by the design rather than by an
added component: there are no stranded rows, because there is no state a row can
be in where it is durable and undiscoverable.

**No schema, no migration, no state-machine change.** The columns this design
relies on — `state`, `updatedAt`, `lastPolledAt` — all shipped in Phase 4A-2a.

**What this does not do.** No worker, no system-scoped execution repository, no
claim, no provider submission, no polling. Admission simply stops pretending to
hand work to something that never existed. Phase 4C-1b adds the read side.

## Alternatives rejected

**Keep the port as a production no-op adapter** — see §2. Preserves merged call
sites at the cost of a permanently false contract.

**A `generation_jobs` table** — a second durable authority for "what work
exists", requiring reconciliation with the state that already answers it. The
stranded-row problem survives unless the job insert joins the row's transaction,
which would mean reopening merged admission code to gain what removing the
transport gives for free.

**Redis / BullMQ / SQS** — new infrastructure, new secrets, a new CI service, and
no transactional relationship with the row. Unjustified for a workload measured
in minutes per job.

**PostgreSQL `LISTEN/NOTIFY` as a wake signal** — deferred, not rejected on
principle. Because a dropped notification must never lose work, it requires the
polling path underneath it regardless; it is therefore a latency optimization
over this design rather than an alternative to it, and no latency requirement
exists for a job that takes minutes.
