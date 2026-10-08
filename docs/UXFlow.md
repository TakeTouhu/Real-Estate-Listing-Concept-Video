# UX Flow

Version: 2.0
Status: Approved initial-release contract (pre-Commercial-Launch)

Authority: ADR-0052, ADR-0053, ADR-0054. Where this document and an ADR
disagree, the ADR governs.

> **Two different "reviews" appear in this document, and they must not be
> confused.**
>
> - **Source-photo analysis review** — implemented in Phases 3B/3D, retained,
>   permission `analysis.review`. A user checks and corrects the analyzer's
>   reading of individual photographs *before* generation. The "Implemented —"
>   sections below are historical records of that shipped surface and are
>   preserved as written.
> - **Final-video approval** — **removed from the product** (ADR-0052 Decision
>   2). No `APPROVAL_PENDING` / `APPROVED` / `REJECTED` state, no Approve button,
>   no approval record gating delivery.

## UX goal

A real-estate professional without AI or video-editing expertise must be able to
create, preview, and download a promotional video through a guided workflow.

## Primary flow

```text
Sign in
→ Select organization
→ Create property
→ Upload photos
→ Review quality and privacy findings
→ Confirm room classification and photo order
→ Customize video (incl. Normal/HQ, disclosure mode, logo ON/OFF)
→ Review estimated Unit use and time
→ Generate
→ Track progress
→ Preview the delivered video in the private workspace
→ Download / use it, or request a paid regeneration
```

Delivery places the video in the customer's **private workspace**. That is not
external publication; VTaVision publishes nothing externally.

## Screens

### Dashboard

- recent properties and projects
- active generation jobs
- Unit balance and monthly usage
- failed jobs requiring action

There is no "pending approvals" queue: nothing waits on an approval.

### Property creation

Collect only required listing data. Full address is optional and hidden by default. Require confirmation that the user owns or licenses uploaded photos.

The responsible-user and group controls follow the creator's role (ADR-0052
Decision 10): `OWNER`/`ADMIN` may choose either or leave it unset; a `MANAGER` is
shown as the fixed responsible user and picks one of its own groups (pre-selected
when it has only one, with no "no group" option); a `CREATOR` is shown as the
fixed responsible user with no group control. `VIEWER` and `BILLING` are offered
no create action.

### Upload

- drag-and-drop and mobile upload
- 3–20 photo guidance
- upload progress
- file-type, size, and resolution validation
- privacy warnings
- clear explanation of blocked versus warning-only files

**No near-duplicate warning.** Visual similarity between photographs is
intentionally the customer's concern: it produces no warning, no block and no
Unit consequence (ADR-0052 Decision 14).

### AI analysis review

Show each image with editable room label, confidence, quality score, privacy
flags, and suggested sequence. Users can reorder, exclude, and relabel images.
Low-confidence classification cannot silently proceed.

This surface is **retained** under the `analysis.review` permission. It concerns
source photographs, not the finished video.

> **Known contradiction with the approved contract, recorded rather than
> rewritten.** The shipped surface described below clusters near-duplicates and
> allows only one member of a group to be approved. ADR-0052 Decision 14 removes
> customer-facing near-duplicate warnings and blocks, so that behaviour must be
> removed or neutralized as implementation work — tracked in
> `docs/decisions/TODO.md`. The records below are left as written because they
> are accurate history of what shipped.

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
- **quality: Normal (720p) or HQ (1080p)** — the only quality choice
- camera motion
- style preset
- prompt
- negative prompt
- AI disclosure mode (A / B / C)
- company logo ON/OFF (default ON)

Only display options supported by the internally selected, verified route.
**Never name a Provider or model in the UI** (ADR-0052 Decision 6). Show a
preview of the storyboard, not a claim of actual geometry.

HQ is a final-output requirement. If the selected route produces below target,
composition may upscale, and the UI must not claim "native 1080p" unless it is
verified for that route.

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

- expected Unit use
- estimated completion time
- selected quality (Normal / HQ) and duration
- number of scenes
- rights confirmation and the selected AI-disclosure mode
- that a technically valid delivered generation consumes its Unit regardless of
  whether it is liked, downloaded or used
- that **cancellation is unavailable once a paid Provider request has been
  submitted**
- **which entitlement will fund it** — an eligible Base Unit, or a Normal or HQ
  add-on block

**Add-on Units are quality-locked** (ADR-0053 Decision 2), so this must be
legible *before* purchase and *before* generation rather than discovered at
funding time. An HQ request cannot be funded by Normal add-on Units, and a Normal
request cannot be funded by HQ add-on Units. Where no eligible entitlement
exists, say so plainly and say what would fix it — **never** imply an automatic
conversion, exchange, refund or package substitution, because none exists. A
Standard organization that has used its single included HQ entitlement has no
further HQ route that period, and must be told that at the point it chooses HQ.

Mode C additionally requires its own consent step with two affirmative
checkboxes (ADR-0052 Decision 8); it cannot be chosen as an ordinary dropdown
value without that consent.

Mode C is offered only to a user who personally holds an explicit
`disclosure.none` grant **and** whose organization has Mode C enabled. Enabling
it at organization level does not make the enabling `ADMIN` eligible, and the UI
must not suggest otherwise.

**The `disclosure.none` grant/revoke control is shown only to `OWNER`s**, and
only as a per-user action — never as a group setting, a role default or a Scope
option, because the permission cannot travel by any of those routes (ADR-0052
Decision 10). A user whose grant is revoked loses the option for new requests;
their completed Mode C videos and the consent records behind them are unchanged.

### Generation progress

Show normalized states: queued, analyzing, generating scenes, composing,
validating, completed, failed, cancelled. **There is no "awaiting review"
state.** Never expose provider prediction IDs, model names or temporary URLs.

### Preview

The delivered video appears in the customer's private workspace.

- playback of the delivered video
- side-by-side source image and generated scene
- timeline preview
- quality and privacy findings
- the disclosure mode the video was produced with
- request a **paid** regeneration (ADR-0052 Decision 4)
- change disclosure mode — a recomposition, three free changes per video and
  then 1 Unit per further block of three (ADR-0052 Decision 9); still a
  recomposition, with no provider call, after scene videos have expired. A
  charged change uses a Unit of the **original video's quality**; if none is
  eligible, say so before the change and do not offer a different-quality Unit

**A logo-only change is free** and does not use up a disclosure change; a
disclosure + logo change together counts as one disclosure change (ADR-0052
Decisions 9 and 13).

**Storage purchase** offers +50 GB blocks only while the plan's cap allows one
more — Standard up to 150 GB, Premium up to 450 GB — and otherwise points the
organization to the next plan rather than accepting the purchase (ADR-0053
Decision 4). **While a downgrade is pending, the purchase surface checks the
pending target plan's cap too**: a block that would leave more next-period blocks
than the target plan allows is not offered, and the UI explains that the
scheduled downgrade is the reason (ADR-0053 Decision 3B).

**A running job's disclosure and logo settings are locked** once it is admitted
(ADR-0052 Decision 10). The UI must not offer to change them mid-flight, and a
later change to the organization's Mode C setting or a user's `disclosure.none`
applies only to new requests — never to a job already running.

**Purchases, plan changes and cancellation are shown only to holders of
`billing.manage`** — `OWNER` and `BILLING` by default, and an `ADMIN` only if an `OWNER` has
explicitly granted it (ADR-0053
Decision 5A). An `ADMIN` adding a member when no seat remains, or uploading at
the storage limit, is told that a billing user must purchase capacity; nothing is
bought implicitly. While a seat reduction is scheduled, adding or inviting a
member past the next-period entitlement is blocked with an explanation — and the
same applies while a plan downgrade is pending. A downgrade that would leave
membership over the next-period entitlement shows a warning stating how many
users must be removed before it can proceed. A
reduction cannot be scheduled until membership already fits it; the product
never picks members to remove (ADR-0053 Decision 5A).

There is **no approve or reject control** and no comment-on-approval flow.
Preview exists for the customer's own judgement before they decide to use the
video.

### Download

Short-lived signed download links, restricted to users holding
`video.download`.

Old final versions stay available for 30 days: previewable with `video.view`,
downloadable with `video.download`, labelled with version, date and disclosure
mode. There is **no "restore old version as current"** feature, and downloading
an old version **consumes no Unit**.

**Customer-facing share links are not in the initial release** (ADR-0052
Decision 12). `video.share` is reserved for future work and must not be exposed.

## Error recovery

Every failure screen includes a user-understandable reason, whether the Unit was
consumed or released, retry eligibility, and a support reference ID. Never
display raw provider errors.

Where VTaVision failed to deliver a technically valid video and automatic
recovery cannot continue, the customer sees only the customer-safe meaning:

```text
動画を正常に生成できませんでした。今回の生成ではUnitは消費されていません。
```

The internal recovery budget, its remaining amount, and the fact that it is the
reason for the outcome are **never** shown to customers (ADR-0052 Decision 5).

The same message and the same billing outcome apply to **every** permanent
technical failure (ADR-0052 Decision 19) — a failed initial generation, a failed
paid regeneration, or a failed disclosure/logo recomposition. The reservation is
released, no Unit is consumed, and a failed regeneration or recomposition leaves
the customer's **previously delivered valid video still current**. The internal
failure class is never surfaced and never changes what the customer is told or
charged: `BLOCKED`, `INVALID_MEDIA` and `INTEGRITY_MISMATCH` all read the same
way to a customer.

**There is no customer-facing unblock or retry-the-terminal-row control**, for
any role including `OWNER` and `ADMIN`. Recovery from a terminal internal failure
is an internal operator action (ADR-0052 Decision 20), so a failure screen offers
a support reference, not a button.

Support expectations shown to customers must match ADR-0053 Decision 11: online
support, staffed weekdays 10:00–18:00 JST, inquiries accepted at any hour with
the response clock running in staffed hours, and an initial-response target by
plan. Never present Sev1 monitoring as 24/7 staffed support.

## Accessibility and localization

- WCAG 2.1 AA target
- keyboard-accessible controls
- visible focus states
- Japanese-first copy with localization-ready message catalogs
- the AI disclosure legible in every supported aspect ratio (captions are not an
  initial-release commitment)

## Mobile behavior

Upload, status monitoring, source-photo analysis review, and delivered-video
preview must work on mobile. Advanced scene editing may use a simplified mobile
layout.