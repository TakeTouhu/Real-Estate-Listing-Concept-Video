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

### 1. One renderer, in the domain, producing a string from a structure

`renderPrompt(compiled: CompiledPrompt): string` lives in
`packages/domain/src/generation/prompt-render.ts`.

It is in the domain rather than beside an adapter because *what the model is
told* is product policy: the preservation rules are quoted from
`docs/AIVideoPipeline.md`, and a second provider must inherit them rather than
compose its own phrasing. The adapter's job stays narrow — put this string in
the field the vendor documents.

It is pure and total. Same structure in, same string out; no clock, no
environment, no network, nothing mutated. The direction is one-way: it reads a
`CompiledPrompt` and never writes back, re-compiles, or normalizes the stored
structure. `CompiledPrompt` remains the hashed, persisted, reviewable form.

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

`negativeConstraints.user` is **never** rendered, and the asymmetry is not
inconsistency. Folding a negative into a positive prompt inverts its meaning:
the customer asked for the absence of a thing and would be asking for its
presence. For the only production model the question is moot at admission —
`negativePrompt: UNSUPPORTED` refuses such a project outright — but the renderer
is provider-neutral and must hold for a model that admits one.

The exclusion is structural rather than remembered. `renderPrompt` projects the
compiled prompt onto a narrow internal type that has **no field capable of
carrying the user negative**, and `CompiledPrompt` is not assignable to that
type, so it cannot be forwarded wholesale by accident. Reintroducing the user
negative requires adding a field *and* populating it, in a diff that says so.

This is a review affordance, not an impossibility proof. Nothing stops a caller
constructing the narrow type by hand and putting the wrong text in the wrong
field. What the split buys is that the mistake has to be written down somewhere
a reviewer reads, and a sentinel-string test fails if it ever is.

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

### 7. An empty render is refused

If the whole structure renders to nothing, `renderPrompt` throws
`INTERNAL_ERROR`. The preservation rules are system constants copied into every
compilation, so an empty result means the structure was built wrong — not that a
customer left a field blank. `INTERNAL_ERROR` rather than `VALIDATION_FAILED`
for that reason. An empty `prompt` posted to a paid endpoint is a charge for
nothing.

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
try, which is why the exclusion is structural and pinned by test rather than
left to the comment above.

**Skip the system negatives because the model has no negative field.** Would
silently retire "text overlays claiming measurements or floor plans", which no
preservation rule covers and which `CLAUDE.md` states as a product rule.
