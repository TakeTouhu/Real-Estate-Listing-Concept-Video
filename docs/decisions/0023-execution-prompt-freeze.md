# ADR-0023: Freeze the rendered execution prompt at admission

Status: Accepted (Phase 4C-0a)
Date: 2026-08-17

## Context

Phase 4B-1c froze the five facts that say **what was asked for**, so an admitted
generation survives its storyboard being recomposed or its project's settings
being edited (ADR-0018). Phase 4B-2b then built the single renderer that turns
that snapshot into the one string a provider's `prompt` parameter carries
(ADR-0020), and its review recorded a gap the milestone deliberately did not
close:

> The request identity hashes the **structure** (`compiledPrompt`), not the
> rendered text. The rendered text is a function of the structure *and the
> renderer's code* — headings, section order, bullet syntax, the trimming rule.
> That second input is not part of the request identity and is not recorded
> anywhere on the row.

The concrete failure: a generation is admitted and hashed under one renderer,
someone deploys a renderer change, and the worker submits different bytes — under
a `requestHash` that still validates. The customer approved one request; the
provider is paid for another.

That gap was recorded as a hard Phase 4C prerequisite, and Phase 4C-0b already
demonstrated how real it is by *changing the renderer*: the camera-motion section
lost its caveat and gained a token→sentence mapping, so identical stored
structures render differently before and after that merge.

Nothing detected it, only because nothing submits yet. Phase 4C is the first code
that will.

## Decision

### 1. Persist the rendered prompt as a sixth request-snapshot field

`SceneGeneration.requestRenderedPrompt` holds **the exact positive provider
prompt string produced at admission for this attempt**.

The lifecycle:

```
compiled prompt snapshot
  → render exactly once, for a genuinely new attempt
  → persist the rendered string
  → Phase 4C worker reads that exact string
  → provider receives it verbatim
```

The worker never runs the renderer for an admitted generation. Renderer changes
therefore apply to **new admissions only**, which is what "frozen" means here.

### 2. The 8-fact request hash is unchanged

Deliberately. The hash answers *"are these two the same paid request?"*; the
frozen prompt answers *"what exactly will this one send?"*. Different questions,
so different mechanisms.

Adding the rendered bytes to the hash would make every renderer change invalidate
reuse and **create duplicate paid work for identical customer requests** — the
opposite of what the hash exists for. It would also force a dual-hash regime,
since historical hashes must stay interpretable. The alternative was evaluated and
rejected in the Phase 4C-0 plan.

Consequences worth stating rather than discovering:

- Two rows may share a `requestHash` and carry **different** frozen prompts, if
  they were admitted either side of a renderer change. That is correct: they are
  the same request, and each will send what it was admitted to send.
- **Succeeded reuse crosses renderer versions.** An identical request admitted
  after a renderer change returns the earlier row and its video, produced under
  the older bytes. Reuse is duplicate-spend prevention, and the structure the
  customer approved is unchanged, so this is the intended behaviour — but it is a
  semantic, not an accident.
- A **terminal retry** creates a new row (terminal states release the partial
  unique index), which renders afresh under the current renderer. A retry is a
  re-admission, and re-admission is exactly when a renderer change should apply.

### 3. Render after the reuse lookups, immediately before create

Placement is load-bearing, not incidental. Rendering earlier would mean a corrupt
snapshot could stop a caller from being handed an attempt that **already
exists** — reuse needs no renderer, because a reused row already carries its own
frozen prompt.

Rendering there also means `renderPrompt`'s fail-closed validation (ADR-0020 §7)
runs before anything durable: an unrenderable compiled prompt refuses **before**
the row is created, before enqueue, and before audit. A defect that used to be
discoverable only at submission time is now caught at admission.

### 4. Nullable, and never backfilled

The column is nullable and the migration adds nothing else. `null` means "this
attempt predates the freeze contract and cannot be submitted".

Backfilling would mean rendering historical rows with **today's** renderer —
fabricating, for a request admitted earlier, precisely the bytes this column
exists to pin down. It would perform the drift it prevents, in the migration that
prevents it. `frozenExecutionPromptFrom` therefore fails closed rather than
computing a value, mirroring `generationRequestFactsFrom`'s refusal for
pre-snapshot rows. A plausible reconstruction of a paid request is worse than
none.

No `requestHash` is rewritten, no row deleted, and no index added: this is
execution payload fetched by primary key through the row a queued job names,
never a lookup key.

### 5. No renderer-version registry

Considered in the Phase 4C-0 plan and rejected. Keeping a version plus every
historical renderer implementation means retaining them forever, or accepting
that deleting one silently breaks old rows — the same failure mode, relocated and
made harder to see. Keeping the *result* rather than the *recipe* is strictly
simpler and strictly stronger.

A corollary: the frozen bytes are inherently model-correct. The row freezes
`providerModelId` **and** the rendered prompt together, so if rendering policy
ever varies by model, an admitted generation still cannot be executed against a
different model's phrasing.

## Consequences

**Storage.** Roughly 600 duplicated bytes per row. `requestRenderedPrompt` is a
projection of `requestCompiledPrompt`, whose bytes already live on the same row
and on `storyboard_scenes.compiledPrompt`, so this introduces **no new class of
data** — and the same handling rule applies: never in audit metadata, a queue
payload, an error message, or a log. The queue payload remains `{ generationId }`.

**Admission does slightly more work.** It now renders, which can throw. That is a
change to a merged contract, and it is the safe direction: the failure surfaces
before a durable row exists rather than when a worker tries to spend money.

**Test fixtures must be renderable.** Placeholder compiled prompts that were
adequate while nothing rendered them are now rejected at admission. Three fixture
sites were rebuilt from the frozen constants, which is a cost worth naming: the
strictness is real and it reaches tests.

**What this does not close.** The frozen prompt is not covered by the request
hash, and that remains true by design (§2). What changed is that it no longer
matters for execution: the bytes are pinned to the row rather than recomputed.
There is one residual case — an operator editing `requestRenderedPrompt`
directly in the database would change what is submitted without changing any
hash. That is a database-access concern, not an application one, and no
application path can express it: `SceneGenerationUpdate` cannot name the field,
so a worker writing state cannot alter what will be sent.

## Alternatives rejected

**Renderer version + versioned renderers** — see §5.

**Add rendered bytes to the request hash** — see §2. Breaks reuse, duplicates
paid work, and forces a dual-hash migration.

**Render at execution from the frozen structure, pinning the renderer by
convention** — unenforceable, and Phase 4C-0b changed the renderer within days of
the gap being recorded.

**Make the column `NOT NULL`** — would need a default, and any default is a
fabricated provider prompt: a row claiming it will submit text nobody rendered
for it.
