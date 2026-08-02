# UX Flow

Version: 1.0
Status: Draft

## UX goal

A real-estate professional without AI or video-editing expertise must be able to create, review, and download a compliant promotional video through a guided workflow.

## Primary flow

```text
Sign in
→ Select organization
→ Create property
→ Upload photos
→ Review quality and privacy warnings
→ Confirm room classification and photo order
→ Customize video
→ Review estimated credits and time
→ Generate
→ Track progress
→ Review result
→ Approve, reject, or regenerate scenes
→ Download or create share link
```

## Screens

### Dashboard

- recent properties and projects
- active generation jobs
- pending approvals
- credit balance and monthly usage
- failed jobs requiring action

### Property creation

Collect only required listing data. Full address is optional and hidden by default. Require confirmation that the user owns or licenses uploaded photos.

### Upload

- drag-and-drop and mobile upload
- 3–20 photo guidance
- upload progress
- file-type, size, and resolution validation
- duplicate and privacy warnings
- clear explanation of blocked versus warning-only files

### AI analysis review

Show each image with editable room label, confidence, quality score, privacy flags, and suggested sequence. Users can reorder, exclude, and relabel images. Low-confidence classification cannot silently proceed.

#### Implemented — `/properties/{propertyId}/review` (Phase 3B-3a, read-only)

The review surface is reached from the property page and groups a property's
analyses into three sections: **awaiting decision**, **decided**, and **not
reviewable yet** (with the reason — not analyzed, in progress, or the failure
message). Each row shows a short-lived signed thumbnail, filename, room label,
analysis revision, blocking findings in the error style, warnings and
low-confidence as cautions.

Near-duplicates sharing a group render as one cluster stating that only one may
be approved; a group of one is an ordinary row. When a member already holds the
group's approval, the others state so rather than offering an action that would
fail.

A decision is presented as an immutable record — decision, note, reviewer **user
id**, timestamp, and the revision it was made against — with the statement that
only refreshing the analysis reopens review.

Authorization is presentational as well as enforced: a role without
`video:review` sees a read-only banner and no decision affordance. The API
enforces the same rule independently.

Decision controls (approve / reject, duplicate-primary selection) are Phase
3B-3b; this milestone reads only.

### Video customization

Controls:

- duration
- aspect ratio
- resolution
- camera motion
- style preset
- prompt
- negative prompt
- BGM
- captions
- logo/brand template
- AI-generated disclosure

Only display options supported by the configured WaveSpeedAI model capability. Show a preview of the storyboard, not a claim of actual geometry.

### Estimate confirmation

Before generation show:

- expected credit use
- estimated completion time
- selected provider quality/duration
- number of scenes
- rights and AI-disclosure confirmation
- cancellation/refund behavior

### Generation progress

Show normalized states: queued, analyzing, generating scenes, composing, validating, awaiting review, completed, failed, cancelled. Never expose WaveSpeedAI prediction IDs or temporary URLs.

### Review

- side-by-side source image and generated scene
- timeline preview
- quality and privacy warnings
- regenerate individual scene
- edit prompt or camera motion
- approve or reject with comment
- mandatory AI-generated disclosure preview

### Download and sharing

Provide short-lived signed download links. Share links are optional, revocable, expiry-controlled, and disabled until human approval.

## Error recovery

Every failure screen includes a user-understandable reason, whether credits were charged/released, retry eligibility, and a support reference ID. Never display raw provider errors.

## Accessibility and localization

- WCAG 2.1 AA target
- keyboard-accessible controls
- visible focus states
- Japanese-first copy with localization-ready message catalogs
- captions and disclosure legible in supported aspect ratios

## Mobile behavior

Upload, status monitoring, review, and approval must work on mobile. Advanced scene editing may use a simplified mobile layout.