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