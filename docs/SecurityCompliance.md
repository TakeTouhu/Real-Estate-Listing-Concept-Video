# Security and Compliance

Version: 2.0
Status: Approved initial-release contract (pre-Commercial-Launch)

Authority: ADR-0052, ADR-0053, ADR-0054. Where this document and an ADR
disagree, the ADR governs.

## Security objectives

Protect customer property images, generated videos, billing data, credentials, and tenant boundaries while preventing misleading or unauthorized real-estate advertising.

## Identity and access

- Strong session management and secure cookies
- Email/password with **mandatory email verification**
- **Authenticator-app (TOTP) MFA plus recovery codes**
- **MFA is mandatory** for `OWNER`, `ADMIN`, any holder of `permission.manage`,
  and any holder of `billing.manage`. Other users may enable it optionally, and
  an organization may require it for all members. **This rule is
  capability-based, not template-based**, so it follows the grant wherever it
  goes — including through a group or an individual grant.
- **Therefore `BILLING` is MFA-mandatory**, because the `BILLING` template holds
  `billing.manage` by default. It is a consequence of the capability rule above,
  not a separate rule, and it must stay true if the template changes.
- Role templates `OWNER`, `ADMIN`, `MANAGER`, `CREATOR`, `VIEWER`, `BILLING`,
  plus groups, Scope (`ORGANIZATION` / `GROUP` / `OWN`) and optional individual
  permissions. Group permissions are **additive**; there is **no DENY model**.
  There is **no Reviewer role** — see the AI-transparency section.
- **The approved per-template grant matrix and each role's fixed Scope are
  ADR-0052 Decision 10**, and each template's grant list there is exhaustive.
  Three separations it enforces by role: `BILLING` does not generate video or
  consume Units; `ADMIN` does not manage billing (unless an `OWNER` explicitly
  grants it `billing.manage` — ADR-0053 Decision 5A); `MANAGER` manages work,
  not people, and is `GROUP`-scoped by role. **`disclosure.none` and `video.share` are granted by
  no template**, so neither is reachable by assigning a role.
- **`permission.manage` is authority within a grant ceiling, not unlimited
  delegation** (ADR-0052 Decision 10). `OWNER` may assign every role; **`ADMIN`
  may assign only `MANAGER`, `CREATOR` and `VIEWER`**; `BILLING`, `MANAGER`,
  `CREATOR` and `VIEWER` have no role-assignment authority by default.
- **`OWNER`-only protected authority:** granting or revoking `permission.manage`,
  `billing.manage` or **`disclosure.none`**; assigning or removing the `OWNER`,
  `ADMIN` or `BILLING` role; ownership-equivalent changes; and any operation
  affecting the last `OWNER`. Do not implement `ADMIN` as having unrestricted
  permission delegation.
- **No self-escalation past the ceiling.** `ADMIN` and every lower role must not
  reach a protected authority they could not grant directly — and the ceiling
  must be checked on **every** grant path, not just direct role change: direct
  role change, individual grant, group membership, group permission, and Scope
  manipulation. Specifically, `ADMIN` cannot self-grant `billing.manage`, cannot
  re-grant `permission.manage` across the protected boundary, **cannot acquire
  `disclosure.none` for itself or any other user**, and cannot promote itself to
  `OWNER` or into `BILLING`. The additive group model is not a loophole.
- **`disclosure.none` is individual-only** (ADR-0052 Decision 10). It is an
  explicit grant to a specific user and may **not** arrive through a group
  permission, group inheritance, a role template or implicit Scope expansion —
  so group-based authorization is never a route to it, for any actor. Holding it
  is a *use* privilege, not a *delegation* privilege: a holder gains no authority
  to grant or revoke it.
- **Row access is Property-rooted** (ADR-0052 Decision 10): tenant boundary AND
  permission AND a Property-derived scope predicate. `OWN` means explicit
  responsible-user assignment, never authorship; `GROUP` is the union of the
  user's groups; children inherit their Property's reachability; and an
  individual grant never widens scope.
- **Scope is fixed by role; there is no standalone scope change.** Only a role
  change moves a member's scope, under the role-assignment ceiling, so an `ADMIN`
  cannot widen anyone to `ORGANIZATION`. Changing a Property's responsible user
  or group is an `OWNER`/`ADMIN`-only authorization mutation; `property.edit`
  alone does not authorize it (ADR-0052 Decision 10). **Group deletion**, which
  ungroups Properties, is equally `OWNER`/`ADMIN`-only, and a granted
  `group.manage` does not satisfy it (Decision 11).
- **The `property.create` role ceiling bounds the effective permission, not
  only grants.** `property.create` is never effective for a `VIEWER` or
  `BILLING` user, whether it arrives by direct grant or through a group; the
  ceiling is applied after every grant source is combined. Creation-time
  Property assignments are fixed by role: a `MANAGER` is the responsible user
  and must choose one of its own groups, a `CREATOR` is the responsible user
  with no group (ADR-0052 Decision 10).
- **Audit every role, permission, group and Property-assignment change**,
  including a refused escalation attempt. Each `disclosure.none` grant and
  revocation must leave durable evidence of the organization, affected user,
  acting `OWNER`, action and timestamp. **Revocation is prospective**: it blocks
  new Mode C initiations but deletes no consent evidence, modifies no completed
  video, and removes no audit history. Because the authority is `OWNER`-only, it
  is always exercised by a mandatory-MFA actor; no additional step-up mechanism
  is introduced. **Mode C eligibility is frozen at admission**: a job admitted as
  Mode C keeps it through delivery, and revocation or organization-level
  disablement governs only jobs admitted later (ADR-0052 Decision 10).
- **Charge-changing customer actions require `billing.manage`** (ADR-0053
  Decision 5A) — `OWNER`/`BILLING` by default; an `ADMIN` only through an explicit
  `OWNER` grant, never by role alone. `billing.view`
  authorizes no mutation, and no member-management or upload action may create a
  charge implicitly.
- **The Clean Master is internal**: never customer-exposed or downloadable, and
  deleted with its content's lifecycle (ADR-0052 Decision 17).
- **Recovery from a terminal internal technical failure is not a customer
  capability.** No role template reaches it — not `OWNER`, not `ADMIN`. It is an
  internal operator privilege, separate from support-content access, billing
  mutation and permission mutation (ADR-0052 Decision 20, ADR-0054 Decision 6).
- **At least one `OWNER` must always exist, and the last `OWNER` cannot be
  deleted.**
- Organization scope resolved from authenticated session
- Least privilege for services, workers, storage, and databases
- Privileged support access is time-limited, approved, and audited — and
  **generic customer impersonation is not implemented** (ADR-0054 Decision 6)

Password reset, MFA changes, recovery-related changes and security-sensitive
identity events must be auditable.

**Post-release, and explicitly retained on the roadmap:** Microsoft Entra ID SSO,
Google SSO, organization-level SSO-required mode, and possible password-login
disablement for SSO-enforced organizations.

## Tenant isolation

- `organization_id` required on tenant-owned records
- Repository/data-access layer enforces organization scope
- Automated cross-tenant authorization tests
- Organization-prefixed storage keys
- No public buckets or permanent asset URLs

## Upload security

- Direct upload using short-lived signed URLs
- Allowlisted formats and size/dimension limits
- Verify MIME type from file bytes, and validate magic bytes
- **Malware scanning before processing is mandatory in production.**
  `PassthroughMalwareScanner` is **not permitted in production** — a real engine
  (ClamAV or an approved vendor) runs behind the `MalwareScanner` port
  (ADR-0054 Decision 5).
- Uploads stay **quarantined** until required validation and scanning succeed
- **Failed or unscanned prohibited input is never sent to the AI Provider**
- Strip sensitive EXIF and GPS metadata from processing copies
- Detect people, addresses, documents, personal information, suspicious
  watermarks, and unsafe content
- **Near-duplicate similarity produces no customer warning and no block**; it is
  internal analysis data only (ADR-0052 Decision 14)
- Keep originals immutable until retention/deletion policy applies

## AI provider security

Provider-neutral by design; WaveSpeedAI is the primary candidate for the initial
release and **is not activated** (ADR-0054 Decision 2).

- Provider API keys are **server-side only**
- Secrets use environment variables or managed secret stores
- Never log Authorization headers, API keys, signed input URLs, temporary output URLs, or raw provider payloads
- Input URLs are single-purpose and short-lived
- Provider output is downloaded, validated, and copied to managed storage
- Provider webhooks are authenticated where supported, deduplicated, replay-safe, and tenant-resolved from internal records
- Current commercial terms, data handling, retention, and model policy must be
  re-verified before production — the full re-verification list is ADR-0054
  Decision 2
- **Provider and model identity never reaches a customer-facing surface**

## Application security

- Schema validation and output encoding
- CSRF protection where cookie-based mutations are used
- CSP, secure headers, and dependency scanning
- **Defense-in-depth rate limiting** across account, organization, IP and
  endpoint/action dimensions, covering login, password reset, MFA recovery,
  uploads, generation, downloads and billing. Login failures use progressive
  cooldown; a working starting value such as 5 failures / 15 minutes is a
  **configurable starting point, not a commercial contract**. A rate-limited
  request **must not consume a Unit or cause a Provider POST**, and plan
  generation concurrency is a **separate control** from abuse rate limiting
  (ADR-0054 Decision 5).
- Idempotency for generation and financial commands
- SSRF protections for any server-side URL retrieval
- FFmpeg runs in a restricted container with resource/time limits

## Privacy and data lifecycle

- Collect the minimum property/customer information needed
- Clearly document processing purpose and subprocessors
- Configurable retention for originals, processing copies, and outputs
- Scheduled physical deletion after recovery window
- Export and deletion request processes
- Separate legal retention for billing and audit records
- Never use customer assets for model training unless explicit opt-in terms are implemented

## Advertising and AI transparency

The exact in-video disclosure text is:

```text
本コンテンツは生成AIを使用して作成しています。
```

- **Mode A (default)** shows it for the whole video; **Mode B** for the first and
  last 2 seconds; **Mode C** omits it from the file entirely.
- **Mode C is gated by all three of**: organization-level enablement by
  OWNER/ADMIN, an explicit individual `disclosure.none` grant that only an
  `OWNER` can give, and explicit per-video consent with two affirmative
  checkboxes (ADR-0052 Decisions 8 and 10). **Enabling Mode C at organization
  level does not by itself authorize anyone** to omit the disclosure; an `ADMIN`
  who enables it still cannot use it without an `OWNER`'s grant. No dual control
  is required — the control is grant authority.
- Do not present output as a measured floor plan, dimensional proof, or an actual
  captured walkthrough.
- **There is no human approval gate, and no Reviewer role.** The former
  "never publish without human approval" rule is superseded: **VTaVision performs
  no external publication at all.** Delivery is to the customer's private
  workspace, and the customer decides after preview whether anything leaves it
  (ADR-0052 Decision 2).
- The transparency obligation is met by the in-video disclosure and the Mode C
  consent record, not by an approval gate (ADR-0052 Decision 3).
- Preserve a record of source assets, settings, internal route/model identity,
  generation version, and the disclosure mode used.

**Mode C consent evidence** retains at minimum: `organizationId`, `userId`, the
target generation/video, `disclosureMode = NONE`, `consentTextVersion`,
`consentedAt`, and the organization-level Mode C permission/enabled state.
Retention is 10 years (ADR-0053 Decision 7).

**Final legal wording requires review by counsel familiar with Japanese IT/SaaS
and real-estate advertising before Commercial Launch.** Its purpose is to
validate the responsibility boundary, not to make VTaVision an
external-publication approver.

## Responsibility boundary

The customer is responsible for the decision to externally publish or
commercially use generated content, for holding rights to source material, and
for compliance with applicable law, real-estate advertising rules, industry rules
and destination-platform rules.

VTaVision must **not** claim a generated video is guaranteed legally compliant
for every external commercial use. This is **not** a blanket exemption:
VTaVision remains responsible for appropriate service operation, customer-data
handling and security obligations, and liabilities that cannot or should not
lawfully be excluded — including intentional misconduct and gross negligence as
applicable (ADR-0053 Decision 8).

## Audit events

Audit uploads, deletions, analysis changes and corrections, generation requests,
retries, cancellations, provider failures, deliverable availability, downloads,
disclosure-mode changes, **Mode C consent**, logo changes, billing changes,
user/group/role/permission changes, subscription/plan changes and cancellations, seat purchases and scheduled seat
reductions,
and privileged support access including break-glass use.

**Operator recovery from a terminal technical failure is separately audited**
with, at minimum: operator identity, organization, target Job / Deliverable /
row, recovery reason, the original block or verdict cause, timestamp, and the
resulting new recovery-cycle identifier. The original terminal evidence is
immutable and is never rewritten by the recovery (ADR-0052 Decision 20).

Share-link audit events are reserved for the post-release share feature and have
no initial-release surface.

Audit metadata must be sanitized and tamper-evident. Do not store full secrets or unnecessary personal data.

## Incident response

- Defined severity levels and on-call ownership
- Secret rotation and access revocation procedures
- Tenant notification assessment
- Provider outage and data exposure playbooks
- Evidence preservation with privacy controls
- Post-incident review and corrective action tracking

## Production readiness checks

- Threat model reviewed
- Dependency and container scans pass
- Tenant-isolation tests pass
- Restore test succeeds
- Secrets are not committed
- Provider terms/data handling re-verified (ADR-0054 Decision 2)
- Real malware scanning in place; `PassthroughMalwareScanner` absent from
  production
- Rate limiting in place across the sensitive surfaces
- Privileged support access time-limited, audited, and without generic
  impersonation
- Privacy policy, terms, subprocessor list, Mode C consent wording and AI
  disclosure approved by counsel
- Vulnerability reporting channel established

**Paid Provider Activation and production scheduler activation remain BLOCKED**
and require explicit CTO authorization (ADR-0054 Decision 7).