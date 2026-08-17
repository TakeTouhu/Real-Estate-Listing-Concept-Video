# ADR-0020: Rendering a compiled prompt into the provider's single prompt field

Status: Accepted (Phase 4B-2b)
Date: 2026-08-17

## Context

ADR-0014 made a compiled prompt **structure** rather than an interpolated
string. Five parts — preservation rules, scene facts, the customer's
customization, system negative constraints, the customer's negative constraints
— never merge, and that separation, not phrase detection, is the integrity
mechanism: customer text sits in fields nothing reads as an instruction about
the constraints.

ADR-0018 kept it that way through persistence. `requestCompiledPrompt` stores
the structure byte-identically to what the request hash covered, explicitly so
that "exactly one [renderer] can be built later at the provider boundary".

ADR-0019 then verified the selected model. `wavespeed-ai/open-video/image-to-video`
documents `image`, `prompt`, `duration`, `resolution` and `seed` — and nothing
else. There is no `negative_prompt` and no `camera_motion`. §8 nevertheless
declared `cameraMotion: PROMPT_RENDERED`, on the stated grounds that the vendor
documents the prompt as controlling motion, and recorded plainly that this was
**a promise about a renderer that did not exist**, unverifiable until one did.

So this milestone owns one function, and one field. Everything the model is ever
told about a scene has to fit in `prompt`.

## Decision

### 1. One renderer, in the domain, taking the persisted snapshot

`renderPrompt(requestCompiledPrompt: string): string` lives in
`packages/domain/src/generation/prompt-render.ts`.

**Its input is the durable column, not a typed object.** A generation stores
`requestCompiledPrompt` as an opaque JSON string (ADR-0018). A first revision of
this renderer accepted an already-typed `CompiledPrompt`, which left Phase 4C no
honest route from the stored column to the renderer except
`JSON.parse(value) as CompiledPrompt`. Pre-merge review found three reachable
consequences of that unchecked cast — a row with no preservation rules, a row
with no system constraints, and a row carrying a customer negative prompt each
produced a plausible, sendable prompt. Parsing and validation therefore belong
*inside* the renderer, where they cannot be skipped by the caller.

It is in the domain rather than beside an adapter because *what the model is
told* is product policy: the preservation rules are quoted from
`docs/AIVideoPipeline.md`, and a second provider must inherit them rather than
compose its own phrasing. The adapter's job stays narrow — put this string in
the field the vendor documents.

It is pure and total. Same stored string in, same prompt out; no clock, no
environment, no network, nothing mutated. The direction is one-way: it reads the
stored snapshot and never writes back, re-compiles, or normalizes it. The
persisted structure remains the hashed, reviewable form; this is a projection of
it, and execution never needs the mutable project or storyboard to reconstruct
what was approved.

### 2. The format: labelled plain-text sections, fixed order, `-` bullets

```
Room: living room

Preservation rules:
- Preserve visible structure, windows, doors, equipment, materials, and finishes as far as technically possible.
- Do not add nonexistent furniture, equipment, views, openings, or rooms.
- Do not change material or apparent room size.
- Do not add people or fictional logos.

Avoid:
- people
- fictional logos or branding
- invented windows, doors, or rooms
- text overlays claiming measurements or floor plans

Camera motion requested by the customer (the rules above take precedence):
slow dolly forward

Styling requested by the customer (the rules above take precedence):
warm evening light, calm pace
```

Sections are separated by a blank line and omitted entirely when their source is
absent, so nothing renders as an empty heading.

**Why this and not prose.** Bullets keep each rule atomic. If the string is ever
truncated by a limit the vendor has not published, truncation costs trailing
rules rather than corrupting the meaning of earlier ones, and the loss is
visible at a glance in the same string a human reviewer reads.

**Why this and not JSON or tagged markup.** Video models are conditioned on
natural language; structured syntax degrades adherence and invites the model to
treat the markup as subject matter. Encoding the five-part structure as syntax
would also imply the model honours the separation, which it does not — see §4.

**Why headings at all.** Human review before publication is a mandatory product
rule. The rendered prompt is the artifact a reviewer or a support engineer reads
when a generation goes wrong, and attribution — which words the customer wrote —
is the first question either of them asks.

### 3. Camera motion is rendered, which is what makes `PROMPT_RENDERED` true

The requested motion is emitted verbatim under its own heading. ADR-0019 §8's
promise is now behaviour, and `capability.test.ts` pins the two together: the
descriptor's `cameraMotion` declaration is asserted to equal `PROMPT_RENDERED`
**only if** the renderer demonstrably carries the motion and demonstrably omits
it when there is none. If a future change stops the renderer carrying motion,
the test does not fail loosely — it demands the descriptor become
`UNSUPPORTED`. Relaxing the test to preserve the declaration is the one repair
that is not available. The declaration follows the behaviour, never the reverse.

A **blank** camera motion renders nothing, because whitespace requests nothing.
This is deliberately *not* the rule `assertSettingsSupported` applies, which
refuses on `cameraMotion !== null` without trimming, because the raw value is a
request-hash fact. The two disagree on purpose and only about presentation: a
blank motion is still "present" for admission and identity, and still absent
from the text. Trimming here changes the rendered string only — nothing stored,
hashed, or admitted moves.

### 4. Flattening loses ADR-0014's separation at the model, and we say so

The provider has one prompt field. Whatever structure exists on our side, the
model receives one string, and inside it the customer's sentences sit in the
same context window as the preservation rules. **ADR-0014's separation is
preserved in the system's representation and cannot be preserved in the model's.**

What survives the flattening:

- Customer text can only ever land inside its two delimited, labelled regions.
  Nothing splices it into a rule, a heading, or the negative list; those are
  built from frozen module constants routed through different fields.
- Every system-authored section precedes every customer-authored one, so nothing
  the customer typed is positioned as a preamble the rules then appear to qualify.
- The text is moderated before compilation, and rejection is terminal.

What does not survive: the model is free to weigh the customer's sentence above
the rule that precedes it. The `(the rules above take precedence)` clause in each
customer heading is a **mitigation, not a control** — in-band text asking a model
to prioritise other in-band text. It is worth its two dozen characters and it is
not a guarantee, and this ADR declines to describe it as one.

### 5. The system negative constraints are rendered; the customer's never are

`negativeConstraints.system` is rendered under `Avoid:`. The four entries are
system-authored, fixed, and reviewed, and one of them —
"text overlays claiming measurements or floor plans" — implements a product rule
from `CLAUDE.md` that **no preservation rule covers**. The model has no negative
field. Dropping the list because the vendor lacks a parameter would silently
retire a stated product constraint, so it goes in the only channel there is,
phrased in the same imperative voice the preservation rules already use.

`negativeConstraints.user` is **never** rendered, and a non-blank one is
**refused outright**. The asymmetry is not inconsistency. Folding a negative
into a positive prompt inverts its meaning: the customer asked for the absence
of a thing and would be asking for its presence. Silently omitting it is not the
safe alternative either — it discards a stated customer requirement, and the
first revision of this renderer did exactly that. Neither is available, so the
renderer fails closed.

For the only production model the question should never arise: admission refuses
such a project because `negativePrompt: UNSUPPORTED`. Reaching the renderer with
one means corrupt or legacy state, which is precisely when silent behaviour is
worst.

The refusal is the control. The structural exclusion behind it is the second
line: `renderPrompt` projects onto a narrow internal type that has **no field
capable of carrying the user negative**, and `CompiledPrompt` is not assignable
to that type, so it cannot be forwarded wholesale by accident. Reintroducing the
user negative requires adding a field *and* populating it, in a diff that says
so.

That second line is a review affordance, not an impossibility proof — nothing
stops a caller constructing the narrow type by hand. It is worth keeping anyway,
because the two mechanisms fail differently: the refusal catches bad *data*, and
the type catches bad *code*.

### 6. Three facts are deliberately not rendered

The same narrow type omits them, so they have no route to the string:

- **`assetId`** — an internal identifier. It must not reach a provider payload
  at all; omitting the field is stronger than remembering not to print it.
- **`position`** — storyboard bookkeeping. A single image-to-video call does not
  act differently for being third in a sequence.
- **`durationSeconds`** — carried by the provider's own documented `duration`
  parameter. Restating it as prose would give the model two sources for one fact
  and a way to disagree with the request that was hashed and billed.

An **unclassified** room renders no line at all. "Room: unclassified" spends
tokens on something the model cannot act on, and guessing a likely label is
exactly what `SceneFacts.roomType` documents as forbidden.

### 7. The renderer fails closed, and says nothing about the data

`JSON.parse` succeeding is not evidence of anything, so every field the renderer
reads is checked before it is read. Three layers, in order:

1. **Shape.** Malformed JSON, a non-object root, and every wrong field type are
   refused. Nothing downstream can meet `undefined` and throw a raw `TypeError`
   instead of a domain error. An unknown `roomType` is refused rather than
   rendered.
2. **Safety content.** `preservation` and `negativeConstraints.system` must
   equal the frozen constants — **exact sequence equality**, not subset or
   superset, because `compileScenePrompt` writes exactly
   `[...PRESERVATION_RULES]` and `[...SYSTEM_NEGATIVE_CONSTRAINTS]`. A missing
   rule silently weakens the request; an extra entry would render unreviewed
   text at system trust level. Before this check, an empty
   `negativeConstraints.system` rendered a complete prompt with
   "text overlays claiming measurements or floor plans" simply absent — a
   product rule from `CLAUDE.md` that no preservation rule covers.
3. **Customer negative.** A non-blank `negativeConstraints.user` is **refused**,
   not dropped. See §5.

Every refusal is `INTERNAL_ERROR` with a **fixed sentence chosen by code**. None
of the conditions is reachable for a request admitted through
`GenerationService`, so reaching one means stored state disagrees with the code
that wrote it — not something a customer can act on, and the reason why
`VALIDATION_FAILED` would be wrong. No compiled prompt, customer text, room
type, asset id, generation id, request hash, tenant id, or credential appears in
any message or in `details`; a test asserts that against sentinel values.

The reasons are distinct rather than uniformly opaque, because an operator needs
to know *which* invariant failed and no reason needs the data to say so.

**Consequence, deliberately accepted.** Exact-equality means editing
`PRESERVATION_RULES` or `SYSTEM_NEGATIVE_CONSTRAINTS` invalidates every
generation already admitted and not yet executed: they fail closed rather than
executing under rules the customer's approved request never described. Changing
the rules is a re-admission event, not a silent upgrade. This is the same drift
problem recorded below, resolved here in the safe direction.

## Consequences

### The rendered string is not covered by the request hash

This is the significant one, and it is a gap this milestone creates rather than
closes.

The request identity hashes the **structure** (`compiledPrompt`), not the
rendered text. The rendered text is a function of the structure *and the
renderer's code* — headings, ordering, bullet syntax, the trimming rule. That
second input is not part of the request identity and is not recorded anywhere on
the row.

The consequence is concrete: a generation admitted and hashed under one version
of this file, then executed after a deploy that changed a heading, submits text
the customer's approved request never described — under a hash that still
validates. Nothing today detects it, because nothing today executes a generation
at all; Phase 4C is the first code that submits.

Two shapes could close it, and choosing between them is Phase 4C's call, not
this milestone's: pin a renderer version into the request identity, or freeze
the rendered string alongside the structure at admission. The second is simpler
and costs a column; the first keeps the row smaller and makes every renderer
change a deliberate re-identification of in-flight work. Recorded in
`docs/decisions/TODO.md` as a Phase 4C prerequisite.

Rendering was kept minimal partly because of this: the renderer authors headings
and bullet characters and nothing else. No framing sentence, no invented
preamble, no restated duration. The less prose the renderer owns, the less there
is to drift.

### Camera motion reaches the model as unmoderated customer text

`VideoProject.cameraMotion` is a free-text field the customer types in the
create panel. It flows to `StoryboardScene.cameraMotion`, into
`SceneFacts.cameraMotion`, and — as of this ADR — into the prompt.
`compileScenePrompt` moderates `prompt` and `negativePrompt`. It does **not**
moderate camera motion. `SceneFacts` is documented as "System-derived, never
user text", and for this field that comment is wrong.

This milestone does not fix it. Adding a field to moderation changes what
admission accepts and belongs in its own reviewable change, not folded into a
renderer. What this milestone does instead is refuse to launder the value:
camera motion renders **under a customer heading, below the rules**, alongside
the styling request, rather than as a system fact above them. The gap is
recorded in `docs/decisions/TODO.md`; either route the field through the
moderator or constrain it to a vocabulary.

### Prompt length is now a real cost with no published limit

Every generation carries roughly 600 characters of preamble before the customer's
own words. If OpenVideo weights early tokens or truncates at an undocumented
length, the customer's styling request is the part most likely to be diluted or
lost — it is last. The vendor publishes no limit for `prompt`, and this
repository is not permitted to make a paid call to discover one.

Accepted for now, because dropping constraints to shorten the prompt trades a
product rule for adherence we have not measured. It becomes measurable in Phase
4C/4D, when generations can actually be produced and compared.

### Reversal conditions

Named so a later phase does not have to relitigate the reasoning:

- **Measured adherence degrades with the preamble.** Once real generations exist,
  if constraint-heavy prompts demonstrably produce worse output than a compact
  prose form, collapse the sections. The preservation rules are the product
  requirement; this *layout* of them is not.
- **The vendor publishes a prompt length limit we exceed.** Then section
  selection stops being a style question and becomes a budget, and the order of
  omission has to be decided explicitly rather than by truncation.
- **A model exposes a dedicated negative field.** Then the system negatives leave
  the prompt and become `PROVIDER_FIELD`, and `Avoid:` disappears from the
  rendered string for that provider.
- **Camera motion becomes a constrained vocabulary.** Then it stops being
  customer free text, moves above the rules as a system fact, and the heading
  changes with it.

## Alternatives rejected

**Render in the adapter.** Each provider would compose its own phrasing of the
preservation rules, and the product rule would exist in as many wordings as there
are vendors. The rules are policy; the field name is the vendor's business.

**Keep the structure as JSON inside the prompt.** Implies to a reader that the
model honours the separation, which it does not, and video models handle prose
better than syntax. The honest statement is §4: the separation is ours, not the
model's.

**Put the customer's text first.** Reads more naturally as a creative brief, and
positions every constraint as a qualification of whatever the customer wrote —
including, in the adversarial case, a qualification of an instruction to ignore
them.

**Fold the customer's negative prompt in as "avoid X".** Superficially it is the
same words with a heading, and it is the transformation that inverts their
meaning most quietly. It is also what a future contributor will most plausibly
try, which is why a stored row carrying one is refused outright and the
exclusion behind that refusal is structural and pinned by test.

**Silently drop the customer's negative prompt.** The first revision of this
renderer did, on the reasoning that admission already refuses one so the case is
unreachable. "Unreachable" is exactly the claim corrupt or legacy state
falsifies, and the failure mode is a paid generation that quietly ignores a
constraint the customer stated. Refusing is the only disposition that neither
inverts the meaning nor discards the requirement.

**Validate in the caller instead of the renderer.** Would leave Phase 4C free to
write `JSON.parse(value) as CompiledPrompt`, and a second caller free to skip
the check entirely. A guarantee a caller can decline is not a guarantee.

**Skip the system negatives because the model has no negative field.** Would
silently retire "text overlays claiming measurements or floor plans", which no
preservation rule covers and which `CLAUDE.md` states as a product rule.
