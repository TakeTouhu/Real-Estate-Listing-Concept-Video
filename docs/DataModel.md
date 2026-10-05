# Data Model

Version: 2.0
Status: Approved initial-release contract (pre-Commercial-Launch)

Authority: ADR-0052, ADR-0053. Where this document and an ADR disagree, the ADR
governs.

> **This is a forward-looking design sketch, not the implemented schema.** The
> implemented schema is `packages/database/prisma/schema.prisma`, documented in
> `docs/er-diagram.md` and `docs/migration-notes.md`, and currently stands at
> migration 16. Entity shapes below that have not been built are illustrative;
> where the implemented schema already covers a concept it is authoritative and
> its names differ (for example `GenerationJob`, `GenerationReservation`,
> `GenerationDeliverableVersion`, `GenerationDeliverableValidation`).

## Core principles

- PostgreSQL is the system of record.
- Every tenant-owned record includes `organization_id`.
- Public resource IDs are separate from provider job IDs and storage keys.
- Unit reservation and settlement are transactional and idempotent, and settle
  exactly once. "Credits" below refers to the same entitlement concept now called
  **Units**.
- Sensitive provider payloads are not stored raw unless strictly necessary and encrypted.

## Main entities

### Organization

`id`, `name`, `slug`, `status`, `plan_id`, `created_at`, `updated_at`

### User

`id`, `email`, `name`, `status`, `created_at`, `updated_at`

### Membership

`id`, `organization_id`, `user_id`, `role`, `created_at`

Role templates: `OWNER`, `ADMIN`, `MANAGER`, `CREATOR`, `VIEWER`, `BILLING`.

**`REVIEWER` is removed.** It existed to approve finished videos, and that
workflow no longer exists (ADR-0052 Decision 2). Reviewing *source photographs*
survives as the `analysis.review` permission.

Membership alone is not the authorization model: the initial release adds groups,
Scope (`ORGANIZATION` / `GROUP` / `OWN`) and optional individual permissions, with
**additive** group permissions and **no DENY**. The permission list **and the
approved per-template grant matrix with each template's default Scope** are
ADR-0052 Decision 10. They need durable representation — group membership, scope,
and per-user grants — that does not exist yet.

That representation must also support the **grant ceiling**: every authorization
mutation records the acting user, and the model must be able to answer "may this
actor grant this?" rather than only "does this actor hold `permission.manage`?".
`OWNER`-only protected authority (`permission.manage`, `billing.manage`, the
`OWNER`/`ADMIN`/`BILLING` role assignments, ownership-equivalent changes, and
anything touching the last `OWNER`) must be enforceable on **every** path —
direct grant, group membership, group permission and Scope change alike — since
the additive model otherwise becomes an escalation route.

Whether the template defaults are **stored as rows** or **derived in code from
the approved matrix** is an implementation choice this document does not make;
either way the matrix is authoritative and a stored copy must be reproducible
from it. Note that `disclosure.none` and `video.share` are granted by **no**
template, so neither can be reached by assigning a role alone.

User status is **`active` or `deleted`** only; there is deliberately no
suspension/deactivation state, and deleted users cannot be restored (ADR-0052
Decision 11).

### Property

`id`, `organization_id`, `name`, `property_type`, `address_masked`, `description`, `status`, `created_by`, timestamps

Avoid exposing full addresses where not required.

### MediaAsset

`id`, `organization_id`, `property_id`, `storage_key`, `original_filename`, `mime_type`, `size_bytes`, `width`, `height`, `sha256`, `perceptual_hash`, `status`, `created_by`, timestamps

### AssetAnalysis

`id`, `organization_id`, `asset_id`, `room_type`, `confidence`, `quality_score`, `blur_score`, `brightness_score`, `duplicate_group`, `detected_objects_json`, `safety_flags_json`, `suggested_order`, `reviewed_by`, timestamps

### VideoProject

`id`, `organization_id`, `property_id`, `name`, `status`, `duration_seconds`, `aspect_ratio`, `resolution`, `style_preset`, `camera_motion`, `prompt`, `negative_prompt`, `include_music`, `include_captions`, `brand_template_id`, `created_by`, timestamps

### StoryboardScene

`id`, `organization_id`, `video_project_id`, `asset_id`, `position`, `room_type`, `duration_seconds`, `camera_motion`, `compiled_prompt`, `status`, timestamps

### GenerationJob

`id`, `organization_id`, `video_project_id`, `idempotency_key`, `status`, `attempt_count`, `progress_percent`, `estimated_credits`, `reserved_credits`, `settled_credits`, `estimated_cost`, `actual_cost`, `failure_code`, `failure_message_sanitized`, timestamps

Unique constraint: `(organization_id, idempotency_key)`.

### ProviderGeneration

`id`, `organization_id`, `generation_job_id`, `storyboard_scene_id`, `provider`, `model_id`, `provider_prediction_id_encrypted`, `request_hash`, `status`, `estimated_provider_cost`, `actual_provider_cost`, `temporary_output_expires_at`, timestamps

Provider prediction IDs are internal only.

### VideoOutput

`id`, `organization_id`, `video_project_id`, `generation_job_id`, `version`,
`storage_key`, `mime_type`, `size_bytes`, `duration_seconds`, `width`, `height`,
`status`, `disclosure_mode`, `logo_enabled`, `disclosure_change_count`,
timestamps

**`approved_by`, `approved_at` and `rejection_reason` are removed**: there is no
final-video approval (ADR-0052 Decision 2). Nothing waits on an approval, and no
approval record gates delivery.

`disclosure_mode` records which of A / B / C the file was produced with — needed
because old versions must display their own mode for 30 days.
`disclosure_change_count` carries the block-of-three accounting: it increments
only when a *new completed deliverable* is successfully produced, not on failure,
retry or cancellation (ADR-0052 Decision 9).

The implemented equivalent today is `GenerationDeliverableVersion` plus
`GenerationDeliverableComposition` (its receipt) and
`GenerationDeliverableValidation` (its verdict); publication is the job's
`currentDeliverableVersionId` pointer rather than a status on the output row.

### CreditLedger

`id`, `organization_id`, `generation_job_id`, `type`, `amount`, `balance_after`, `idempotency_key`, `metadata_json`, `created_at`

Types: `PURCHASE`, `RESERVATION`, `SETTLEMENT`, `RELEASE`, `REFUND`,
`ADJUSTMENT`.

The ledger must additionally support, per ADR-0053: **added Unit packages as
blocks**, each **tagged with the quality it was bought at** (Normal or HQ) —
add-on Units are quality-locked, so the ledger must be able to refuse an
ineligible block rather than treat added Units as one pool; the
**eligibility-first** consumption order (eligible Base Unit → oldest eligible
add-on → newest eligible add-on, FIFO *within* the eligible quality class); the
plan's **included HQ ceiling** (1 / 5 / 10) as a counter *inside* the Base pool
rather than a separate pool, since HQ may draw a Base Unit only while that
ceiling remains (ADR-0053 Decisions 2 and 3); the
**renewal-period binding** (a generation belongs to the period of its
reservation); the fact that added packages **do not carry over**; and the
**internal service-recovery budget**, which is organization-wide, derived from
the **base plan's included-user slots** (3 / 10 / 30) and **not** from active
users or purchased additional seats (ADR-0052 Decision 5), and must never be
rendered to a customer.

It must also represent a **released** reservation for a permanently failed
generation or recomposition (ADR-0052 Decision 19): a reservation may not remain
pending indefinitely, and a failure that delivered no technically valid video
must settle to `RELEASE`, never `SETTLEMENT`.

### Subscription

`id`, `organization_id`, `provider`, `provider_customer_id_encrypted`, `provider_subscription_id_encrypted`, `plan_id`, `status`, `current_period_end`, timestamps

### AuditLog

`id`, `organization_id`, `actor_user_id`, `action`, `resource_type`, `resource_id`, `request_id`, `ip_hash`, `metadata_sanitized_json`, `created_at`

### ConsentRecord

`id`, `organization_id`, `user_id`, `consent_type`, `version`, `accepted_at`, `evidence_json`

## Lifecycle

Assets and outputs use explicit lifecycle states and retention dates. Scheduled jobs physically delete expired customer data and corresponding storage objects after the recovery window. Audit and billing records follow separate legal retention rules.

## Indexes

Index organization scope first for tenant queries, plus project status, job status, creation time, property ID, request hash, and provider prediction lookup. Add partial indexes for active jobs and pending **source-photo analysis** reviews
(`analysis.review`; there is no final-video approval queue to index — ADR-0052
Decision 2).