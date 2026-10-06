# Product Requirements

Version: 2.0
Status: Approved initial-release contract (pre-Commercial-Launch)

Authority: ADR-0052 (product and delivery), ADR-0053 (commercial), ADR-0054
(production platform and activation gates). Where this document and an ADR
disagree, the ADR governs.

> **This document describes the approved initial release. Most of it is not
> implemented yet.** Implementation status lives in `docs/architecture.md`, the
> `docs/phase-*-completion.md` records, and `docs/decisions/TODO.md`. Nothing here
> authorizes activating a paid provider or a production scheduler — both remain
> BLOCKED (ADR-0054 Decision 7).

## Service goal

Enable real-estate companies to create promotional interior walkthrough-style
videos from property photos without professional video-editing skills.

## Release scope — current-state reproduction only

The initial release reproduces the property **as it currently is**.

**Post-release, and not prepared for with initial-release UI or data-model
branches:** virtual staging, renovation proposal.

## Core users

Role templates: `OWNER`, `ADMIN`, `MANAGER`, `CREATOR`, `VIEWER`, `BILLING`,
combined with groups, Scope (`ORGANIZATION` / `GROUP` / `OWN`) and optional
individual permissions. Group permissions are additive; there is no DENY model.
See ADR-0052 Decision 10 for the permission list, **the approved per-template
grant matrix and each template's default Scope**. `BILLING` pays for capacity but
cannot generate video or consume Units; `ADMIN` manages people but not billing;
`MANAGER` defaults to `GROUP` scope and manages work rather than people.

**`permission.manage` is authority within a grant ceiling, not unlimited
delegation.** `OWNER` may assign every role; **`ADMIN` may assign only
`MANAGER`, `CREATOR` and `VIEWER`**; the other templates assign no roles.
Granting `permission.manage`, `billing.manage` or `disclosure.none`, assigning the
`OWNER`, `ADMIN` or `BILLING` role, and anything touching the last `OWNER` are
**`OWNER`-only**.
No role may escalate itself past its ceiling by any route — direct grant, group
membership, group permission or Scope.

There is **no Reviewer role** in the initial release. The former Reviewer existed
to approve finished videos, and that workflow is removed. Reviewing *source
photographs* survives as the `analysis.review` permission.

## Core flow

```text
1. Register a property.
2. Upload interior photos.
3. AI evaluates quality and classifies room type.
4. User confirms or edits labels and order.          ← analysis.review
5. User selects duration, aspect ratio, Normal/HQ, camera motion, style,
   prompt, negative prompt, disclosure mode, logo ON/OFF.
6. System estimates Unit use and completion time.
7. User starts generation.
8. System generates scene clips asynchronously.
9. System composes the final video.
10. System validates the composed video technically.
11. Unit is consumed where applicable.
12. Deliverable becomes available in the customer's private workspace.
13. Customer previews it.
14. Customer downloads/uses it, or requests a paid regeneration.
```

**There is no approval step.** There is no `APPROVAL_PENDING`, `APPROVED` or
`REJECTED` state for a finished video, no mandatory Approve button, and no
approval record gating delivery (ADR-0052 Decision 2).

### Private workspace delivery is not external publication

Delivery makes the video available **inside the customer's own organization**,
to authorized members only. VTaVision performs **no external publication**.
External use happens only by customer action after download, or through a future
customer-created sharing mechanism — which is **not** in the initial release.

## Customization

- Duration: limited by the verified capability of the internally selected route
- Aspect ratio: 16:9, 9:16, 1:1
- Quality: **Normal (720p)** or **HQ (1080p)** — the only quality choice.
  **Additional Units are quality-locked**: a Normal add-on cannot fund HQ and an
  HQ add-on cannot fund Normal, with no conversion or substitution. HQ may draw
  on an included Base Unit only while the plan's HQ ceiling (Standard 1,
  Premium 5, Enterprise 10, *inside* the included pool) remains, and Standard
  cannot buy HQ add-ons (ADR-0053 Decisions 2 and 3)
- Camera motion, style preset, prompt, negative prompt
- AI disclosure mode: A / B / C
- Company logo ON/OFF (default ON)

**Customers do not choose a Provider or a model, and Provider/model names must
not appear in customer-facing UX** (ADR-0052 Decision 6). HQ is a final-output
requirement, not a native-resolution promise; composition may upscale, and
"native 1080p" must not be claimed unless verified for the selected route.

BGM and captions are not initial-release commitments; they are not part of the
approved contract above.

## AI-generated disclosure

Exact text: `本コンテンツは生成AIを使用して作成しています。`

| Mode | Behaviour |
| --- | --- |
| **A** (default) | entire video, bottom-right, white, no background box, subtle/low-opacity, ≈1.25% of video height, ≈3% right/bottom margin, scales for landscape and portrait |
| **B** | same text, first 2 seconds and last 2 seconds |
| **C** | no in-video disclosure — gated (see below) |

Mode C requires **all three**: organization-level Mode C enablement by
OWNER/ADMIN, an **explicit individual `disclosure.none` grant**, and explicit
per-video consent with two affirmative checkboxes. **Only an `OWNER` may grant or
revoke `disclosure.none`**; it cannot come from a role template, a group or a
Scope, and enabling Mode C at organization level does not by itself make anyone
eligible (ADR-0052 Decision 10). Consent evidence and required wording meaning
are in ADR-0052 Decision 8. Final legal wording requires counsel review before
Commercial Launch.

**Changing mode after generation is a recomposition**, not a new provider call
— including after scene videos are deleted, by recomposing from the internal
overlay-free Clean Master (ADR-0052 Decision 17). Mode C eligibility is
**frozen at generation admission**: a later permission or organization change
affects only new generations (ADR-0052 Decision 10).
Three free changes per content video, then 1 Unit — of the **original video's
quality**, Normal or HQ, with no cross-quality substitution — buys the next block
of three
(ADR-0052 Decision 9).

## Company logo

One organization-level logo, OWNER/ADMIN managed, PNG/WebP including transparent
background, per-video ON/OFF with default ON, placed so it does not interfere
with the disclosure, scaled relative to output dimensions. Disclosure mode and
logo are independent. **No forced VTaVision watermark.** Available on all plans.
Multi-brand and branch-specific templates are post-release.

## Room classification

Living room, dining room, kitchen, bedroom, child room, study, bathroom,
washroom, toilet, entrance, hallway, balcony, storage, exterior, other. Users can
correct AI results.

## Quality and safety checks

Detect low resolution, blur, exposure problems, people, personal information,
suspicious watermark/copyright, and unsafe content. Separate blocking errors from
warnings.

**Near-duplicate similarity is explicitly not a customer-facing concern.** No
near-duplicate warning, no generation block, no Unit consequence. Perceptual-hash
data may remain for internal engineering analysis only (ADR-0052 Decision 14).

**Content moderation** follows a conventional generative-video safety policy
(ADR-0052 Decision 15). Moderation refusal happens before a paid provider call
wherever reasonably possible, and a moderation-blocked request **consumes no
Unit**. Moderation is separate from the preservation-first rules below.

## Unit consumption

A **technically valid completed video delivered to the private workspace consumes
the applicable Unit** — regardless of whether the customer likes, downloads or
uses it.

- Customer-requested regeneration consumes additional Unit(s).
- A free retry exists **only** for VTaVision-side technical/system failure.
- An aesthetically disappointing but technically valid video is **not** a
  free-retry case.
- Moderation-blocked failures consume no Unit.
- **Any permanent technical failure that delivers no technically valid video
  consumes no Unit and releases its reservation** (ADR-0052 Decision 19) — for an
  initial generation, a paid regeneration, or a disclosure/logo recomposition
  alike. A failed regeneration or recomposition keeps the previously delivered
  valid video as current, and the internal failure class (`BLOCKED`,
  `INVALID_MEDIA`, `INTEGRITY_MISMATCH`) never changes the customer's bill.

Automatic recovery of VTaVision-side failure is bounded by an **internal-only**
budget of `base-plan included-user slots × 1` — Standard 3, Premium 10,
Enterprise 30 — per organization per renewal period, never exposed to customers
and **not increased by purchased additional seats** (ADR-0052 Decision 5). On
exhaustion the reserved Unit is released, the generation consumes no Unit, and
the customer sees only:

```text
動画を正常に生成できませんでした。今回の生成ではUnitは消費されていません。
```

## Concurrency

Organization-level concurrent **customer video Job** limits: Standard 1,
Premium 3, Enterprise 5. Measured at Job level, not internal parallel scene
requests. HQ has no separate pool. Excess requests **queue** rather than fail.
An internal Safety Guard may enforce lower execution concurrency.

## Project management

Rename, settings change and deletion are in the initial release. Changing
settings after outputs exist creates **new generation conditions**; existing
completed outputs remain **historical versions** and are not silently rewritten.
Deletion follows the 30-day trash lifecycle.

## Commercial requirements

Multi-tenant SaaS with subscription plans and **Units**. Plans, Unit packages,
storage quotas, payment channels, SLA and legal retention are in ADR-0053.

Standard and Premium are **1-month, auto-renewing, monthly-billed self-service**
subscriptions with **no minimum commitment and no annual-prepayment discount**;
Enterprise terms are individually agreed (ADR-0053 Decision 1A). **Every
charge-changing action — Unit packages, seats, storage add-on, upgrade,
downgrade, cancellation — requires `billing.manage`** (`OWNER`/`BILLING` by
default, and `ADMIN` only through an explicit `OWNER` grant; ADR-0053 Decision
5A). Additional-seat cancellation takes effect at renewal, unprorated, and can be
scheduled only once membership already fits the reduced entitlement. Cancellation
takes effect at the end of the paid period with no prorated refund, while refunds
for duplicate or erroneous billing and legally required refunds remain owed
(Decision 3A). Upgrades are immediate and charge the full unprorated price
difference, replacing the base-Unit ceiling rather than stacking it; downgrades
take effect only at the next renewal, can be scheduled only once membership
already fits the next-period entitlement, and never delete content or users
(Decision 3B). A seat or storage add-on bought mid-period is usable immediately
with a prorated first charge (Decision 5A).

- Plan limits and usage tracking
- **No automatic overage charge**; customer approval required to buy Units
- Consent and rights confirmation
- Generation history and audit logs
- Secure asset retention and deletion (ADR-0052 Decision 17)
- Support operations (ADR-0053 Decision 11)

## Product constraints

- The generated video is an AI visualization, **not** measured geometry or a
  captured walkthrough.
- Do not intentionally fabricate structural features, equipment, views or
  additional rooms.
- Apply the AI-generated disclosure per the selected mode; Mode C is the only
  way to omit it, and only under its three gates.
- **VTaVision never publishes externally.** The customer decides, after preview,
  whether anything leaves their workspace.
- The customer warrants rights to uploaded photos, and is responsible for
  external-use compliance (ADR-0053 Decision 8). VTaVision is **not** the
  customer's advertising-law approval authority, and does not disclaim its own
  obligations.

## Initial KPIs

Technical launch gates (ADR-0053 Decision 12) are separate from product metrics.

**Gates — zero-tolerance items are not negotiable against percentages:**

- technically valid Deliverable success rate ≥ 98%
- erroneous/double Unit consumption = 0
- duplicate Provider charging from blind retry = 0
- cross-tenant data exposure = 0
- Sev1 incidents = 0
- loss-making Jobs under the Safety Guard definition = 0
- manual operator intervention < 5%

**Product metrics:** download/use behaviour, customer-regeneration rate, funnel
abandonment, operator intervention, cost per video, monthly retention.

**Customer aesthetic satisfaction is useful feedback but is not a technical
launch gate.**
