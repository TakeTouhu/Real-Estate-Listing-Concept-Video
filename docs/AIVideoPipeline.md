# AI Video Pipeline

Version: 1.1
Status: Draft

## Purpose

Generate a promotional interior walkthrough-style video from multiple property photos while preserving the visible characteristics of the real property.

## Pipeline

```text
Upload
→ Malware scan
→ Image normalization and EXIF sanitization
→ Quality assessment
→ Room classification
→ Duplicate/similarity detection
→ User confirmation
→ Scene ordering
→ Storyboard generation
→ Prompt compilation
→ WaveSpeedAI scene generation
→ Managed-storage copy
→ FFmpeg composition
→ Audio/captions/branding
→ Output quality validation
→ Human review and approval
```

## Image analysis output

Each photo receives room type, confidence, quality, brightness, blur, duplicate group, detected objects, privacy/safety flags, and suggested order. Low-confidence results require user confirmation.

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

## WaveSpeedAI scene generation

Generate short clips per source image through `WaveSpeedVideoProvider`. Initial candidate model: `wavespeed-ai/open-video/image-to-video`. Model capabilities, duration, resolution, pricing, and concurrency are configuration data, not hard-coded constants.

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

Allocate scenes according to requested output length. The UI only offers options supported by the active provider model. Reuse a source image with a different safe camera movement only when necessary, without fabricating unseen geometry.

## Composition

Use FFmpeg to normalize codecs, resolution, frame rate, color, transitions, audio, captions, logo, and mandatory AI-generated disclosure.

## Quality validation

Detect broken frames, flicker, abrupt structural changes, disappearing/duplicated equipment, unnatural motion, prohibited content, missing branding/disclosure, wrong duration, and wrong output format. Retry only retryable scene failures within configured limits.

## Human approval

Never auto-publish. The reviewer confirms that no material misrepresentation, personal information exposure, or advertising-policy violation remains.

## Cost control

Show estimated credits before generation, reserve credits transactionally, track estimated and actual WaveSpeedAI cost separately, regenerate by scene, prevent duplicate jobs with idempotency keys, and settle/refund credits exactly once.