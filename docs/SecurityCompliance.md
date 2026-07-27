# Security and Compliance

Version: 1.0
Status: Draft

## Security objectives

Protect customer property images, generated videos, billing data, credentials, and tenant boundaries while preventing misleading or unauthorized real-estate advertising.

## Identity and access

- Strong session management and secure cookies
- Optional MFA for privileged roles
- RBAC: Owner, Admin, Creator, Reviewer
- Organization scope resolved from authenticated session
- Least privilege for services, workers, storage, queues, and databases
- Privileged support access is time-limited, approved, and audited

## Tenant isolation

- `organization_id` required on tenant-owned records
- Repository/data-access layer enforces organization scope
- Automated cross-tenant authorization tests
- Organization-prefixed storage keys
- No public buckets or permanent asset URLs

## Upload security

- Direct upload using short-lived signed URLs
- Allowlisted formats and size/dimension limits
- Verify MIME type from file bytes
- Malware scanning before processing
- Strip sensitive EXIF and GPS metadata from processing copies
- Detect people, addresses, documents, personal information, suspicious watermarks, and unsafe content
- Keep originals immutable until retention/deletion policy applies

## WaveSpeedAI security

- `WAVESPEED_API_KEY` is server-side only
- Secrets use environment variables or managed secret stores
- Never log Authorization headers, API keys, signed input URLs, temporary output URLs, or raw provider payloads
- Input URLs are single-purpose and short-lived
- Provider output is downloaded, validated, and copied to managed storage
- Provider webhooks are authenticated where supported, deduplicated, replay-safe, and tenant-resolved from internal records
- Current commercial terms, data handling, retention, and model policy must be reviewed before production

## Application security

- Schema validation and output encoding
- CSRF protection where cookie-based mutations are used
- CSP, secure headers, and dependency scanning
- Rate limits for login, upload, generation, downloads, and billing
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

- Default visible label: `AI生成イメージ`
- Do not present output as measured floor plan, dimensional proof, or actual captured walkthrough
- Human approval required before external publication
- Reviewer checks structural consistency, privacy exposure, misleading enhancement, and media-platform rules
- Preserve a record of source assets, settings, model ID, generation version, reviewer, and approval time

## Audit events

Audit uploads, deletions, analysis changes, generation requests, retries, cancellations, provider failures, output approval/rejection, downloads, share-link creation/revocation, billing changes, user/role changes, and support access.

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
- WaveSpeedAI terms/data handling verified
- Privacy policy, terms, subprocessor list, and AI disclosure approved
- Vulnerability reporting channel established