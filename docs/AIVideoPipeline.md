# AI Video Pipeline

Version: 2.0
Status: Approved initial-release contract (pre-Commercial-Launch)

Authority: ADR-0052, ADR-0054. Where this document and an ADR disagree, the ADR
governs. **Paid Provider Activation and production scheduler activation remain
BLOCKED** (ADR-0054 Decision 7).

## Purpose

Generate a promotional interior walkthrough-style video from multiple property photos while preserving the visible characteristics of the real property.

## Pipeline

```text
Upload
→ Malware scan
→ Image normalization and EXIF sanitization
→ Quality assessment
→ Room classification
→ Duplicate/similarity detection (internal analysis only — no customer warning)
→ User confirmation of room labels and order
→ Scene ordering
→ Storyboard generation
→ Prompt compilation
→ WaveSpeedAI scene generation
→ Managed-storage copy
→ FFmpeg composition
→ Audio/captions/branding
→ Output quality validation
→ Unit consumption where applicable
→ Available in the customer's private workspace
```

There is **no human approval step** (ADR-0052 Decision 2). Availability in the
customer's private workspace is not external publication.

## Image analysis output

Each photo receives room type, confidence, quality, brightness, blur, duplicate
group, detected objects, privacy/safety flags, and suggested order. Low-confidence
results require user confirmation.

The duplicate group is **internal analysis data only**. It must not produce a
customer warning, a generation block, or a Unit consequence (ADR-0052 Decision
14).

## Storyboard rules

Typical order: exterior → entrance → hallway → living → dining → kitchen → bedroom → wet areas → storage → balcony. Use only available photos. Do not synthesize missing rooms.

## Prompt compilation

Keep system constraints, property context, room metadata, user prompt, negative prompt, and brand template separate.

Mandatory preservation rules:

- Preserve visible structure, windows, doors, equipment, materials, and finishes as far as technically possible.
- Do not intentionally add nonexistent furniture, equipment, views, openings, or rooms.
- Do not change material or apparent room size for misleading advertising.
- Do not add people or fictional logos.

User-controlled settings include atmosphere, speed, camera height, focus area, scene order, prompt, and negative prompt. Moderate all user input.

## Scene generation

Generate short clips per source image through the `VideoGenerationProvider` port.
**WaveSpeedAI is the primary candidate for the initial release and is not
activated** (ADR-0054 Decision 2); the initial candidate model remains
`wavespeed-ai/open-video/image-to-video`, subject to the re-verification list in
that ADR. Model capabilities, duration, resolution, pricing and concurrency are
configuration data, not hard-coded constants.

**Provider and model identity never reaches the customer.** Normal (720p) and HQ
(1080p) map internally to verified routes.

A **Cost Safety Guard decision happens before any paid Provider submission**: a
route that would knowingly run at a loss is not submitted, an approved
alternative is used if one exists, and otherwise admission is safely rejected or
paused (ADR-0054 Decision 3).

```text
Validate scene
→ create short-lived signed input URL
→ compile preservation-first prompt
→ submit asynchronous WaveSpeedAI prediction
→ store prediction ID internally
→ webhook or bounded polling
→ obtain temporary output
→ copy into managed object storage
→ validate clip
```

## Final duration

Allocate scenes according to requested output length. The UI only offers options
supported by the internally selected verified route, and never names it. Reuse a source image with a different safe camera movement only when necessary, without fabricating unseen geometry.

## Composition

Use FFmpeg to normalize codecs, resolution, frame rate, colour, transitions,
audio, the organization logo where enabled, and the AI-generated disclosure in
the selected mode.

HQ is a final-output requirement, not a native-resolution promise: composition
may upscale, and "native 1080p" must not be claimed unless verified for the
selected route.

**Recomposition, not regeneration**, covers changing the disclosure mode or the
logo on an existing video. Neither is a new AI Provider content call (ADR-0052
Decisions 9 and 13).

## Quality validation

Detect broken frames, flicker, abrupt structural changes, disappearing/duplicated
equipment, unnatural motion, prohibited content, a missing or wrong disclosure for
the selected mode, wrong duration, and wrong output format. Retry only retryable
scene failures within configured limits.

Validation decides **technical validity**, which is what consumes a Unit. It does
not decide whether the customer will like the result.

## Delivery, not publication

VTaVision never publishes externally. A technically valid deliverable becomes
available in the customer's **private workspace**, visible only to authorized
members of that organization, and the customer decides after preview whether
anything leaves it (ADR-0052 Decision 2).

The customer is responsible for external-use compliance; VTaVision is not the
customer's advertising-law approval authority and does not disclaim its own
obligations (ADR-0053 Decision 8).

## Failure and bounded recovery

- **No blind automatic retry of a Provider POST.** Submission certainty and
  retryability are separate concepts, and an ambiguous submission enters
  reconciliation rather than an immediate re-POST (ADR-0054 Decision 4).
- Automatic recovery of VTaVision-side failure is **bounded** by an internal,
  never-customer-visible budget of `plan maximum user limit × 1` per organization
  per renewal period (ADR-0052 Decision 5).
- On exhaustion: no automatic extra Unit charge, automatic recovery stops, the
  reserved Unit is released, **the failed generation consumes no Unit**, and the
  case escalates internally. An authorized operator may grant one further manual
  free recovery.
- **System recovery/recomposition and customer-requested paid regeneration stay
  distinct** and must not be merged into one counter or one explanation.

## Cost control

Show estimated Unit use before generation, reserve the Unit transactionally,
track estimated and actual provider cost separately, prevent duplicate jobs with
idempotency keys, and settle exactly once — which Phase 5C's Transaction G now
does.

A **moderation-blocked request consumes no Unit**, and moderation refusal happens
before a paid Provider call wherever reasonably possible (ADR-0052 Decision 15).