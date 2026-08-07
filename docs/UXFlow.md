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

#### Implemented — decision controls (Phase 3B-3b)

Where a decision is available the page mounts approve and reject controls —
never a single toggle. Approve takes an optional note; reject requires a reason
and its control stays unusable while the field is blank, mirroring the domain
rule rather than replacing it. Inside a duplicate cluster a radio group names
the primary and approval acts on the selected member, so the request's target
and its `primaryAssetId` cannot disagree.

Controls are absent — not merely disabled — for a decided revision, for a viewer
without `video:review`, and for approval of a photo carrying a blocking finding.

Each row carries its own pending and error state: `Recording…` while the request
is in flight, an inline message on failure, and the row stays usable for a
retry. A successful decision refreshes the server component from the database
rather than patching state in the browser, because rejection also moves the
photo between sections.

Failure messages are chosen by HTTP status, and a `422` renders the API's own
message unchanged. The UI does not tell the individual refusals apart — they
share one error code, and parsing the message text would turn a display string
into an implicit API contract.

#### Implemented — correction controls (Phase 3D-4b)

A reviewer no longer has to reject an otherwise usable photo because the
analyzer misread the room. Each awaiting photo shows what the analyzer read the
room as, and offers two corrections:

- **Room** — a select over the existing vocabulary, with an explicit **Use
  analyzer result** choice that clears the override rather than leaving an empty
  field.
- **Order priority** — *lower numbers appear earlier*. A global priority, not an
  absolute scene position: duplicate values are legitimate, nothing is
  renumbered, and a photo without one keeps its automatic room rank.

Corrections are saved with an explicit **Save correction**, which is a different
write from Approve and Reject. The analyzer's own classification is never
overwritten, and the audit records the correction separately from the decision.

**Unsaved corrections block the decision.** Approving with edits still on screen
would freeze the revision around the *old* stored correction and silently
discard what the reviewer can see, so while a correction is unsaved the Approve
and Reject controls are unavailable and say: *Save or discard your correction
changes before approving or rejecting.* A failed save keeps them blocked,
because the change is still unsaved. **Discard changes** restores the stored
values locally, without a request.

Saving refreshes the page from the server rather than merging the response in
the browser, so the effective room, the corrected marker, and the decision
controls all come from authoritative state.

A role without `video:review` receives **no correction controls at all** — not
disabled ones — and a decided photo shows its correction **read-only**: what the
analyzer read, what was used instead, and the order priority if set. Changing a
correction after a decision means refreshing the analysis into a new revision;
the immutable-per-revision rule is unchanged.

The corrected values are what storyboard composition uses (Phase 3D-3), and a
correction that would alter a composed storyboard makes it read stale.

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

#### Implemented — `/properties/{propertyId}/video-projects` (Phase 3C-6a)

The property page now offers **Videos →** alongside **Review photo analyses →**.
The Videos page lists every video project the property has, each showing its
name, status (Draft, Storyboard ready, Storyboard stale), target length, aspect
ratio, resolution, and the customer's own camera-motion, prompt, and
negative-prompt text where set.

A property may hold any number of projects. There is no active, default, or
primary project, no pagination, search, filter, or sorting control, and the
empty state says so rather than implying a project exists. Rows carry no link
yet — the project detail page arrives in Phase 3C-6b.

Creation is a single panel: name, target length in seconds, aspect ratio, and
resolution are required, and the button stays unusable until all four are
filled and the length is a whole number above zero. Camera motion, prompt, and
negative prompt are optional and are sent only when they carry text. Aspect
ratio and resolution are free text — the configured provider's real supported
formats are Phase 4's to establish, and the placeholders show the shape of the
string, not a claim about what any provider accepts. No lifecycle field is sent:
a project always starts as a draft with no storyboard.

Authorization is presentational as well as enforced: a role without
`property:write` reads the list and receives **no create markup at all** — not a
disabled control — plus a one-line explanation. The API enforces the same rule
independently.

A successful creation refreshes the server component from the database rather
than inserting the project locally. Failure messages are chosen by HTTP status
and a `422` renders the API's own message unchanged, matching the review
surface.

Each row links to the project's storyboard.

#### Implemented — `/properties/{propertyId}/video-projects/{projectId}` (Phase 3C-6b)

The storyboard page opens with the project's settings shown **read-only** —
name, persisted status, target length, aspect ratio, resolution, and the
customer's own camera motion, prompt, and negative prompt where set — followed
by how many photos on the property are approved and how many a storyboard needs.
That count is informational: it does not gate composition, and the compose
result remains authoritative.

Below it, one banner states which of three things is true:

- **nothing composed yet** — neutral;
- **current** — this storyboard matches the photos currently approved;
- **out of date** — the approved photos changed since it was composed, so it
  cannot be used until it is composed again.

The banner is driven by the freshness the server recomputes at read time, **not**
by the project's persisted status. A project can read *Storyboard ready* while
its storyboard no longer matches its inputs, and in that case the page shows the
out-of-date warning. A stale storyboard is never described as ready or current.

Composition asks for two explicit values — the shortest and longest time any one
photo is held on screen — with **no prefilled defaults**, and the button stays
unusable until both are whole numbers above zero. They are presented as scene
pacing; nothing claims they reflect what a provider supports. Recomposing uses
the same action, worded *Compose again*.

Scenes render in order with their position, room, source photo, and length, each
with a short-lived signed thumbnail where the photo has one, under a statement
that a storyboard is a plan and not a measured floor plan.

Authorization is presentational as well as enforced: a role without
`property:write` reads the settings, banner, and scenes, and receives **no
compose markup at all**.

Failures follow the same scheme as the rest of the product: a status decides the
message, and a `422` renders the API's own sentence unchanged — the achievable
duration range, the approved-photo minimum, or a moderation refusal, which is
already sanitized server-side and carries no rejected prompt text.

Not yet implemented: generation itself, job status, and output playback (Phase
4); renaming, editing settings, and deletion (recorded for commercial-launch
readiness in `docs/decisions/TODO.md`).

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