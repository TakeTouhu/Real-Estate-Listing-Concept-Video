# API Change Summary — Phase 2

Version: 1.0
Status: Describes **implemented** endpoints. `docs/API.md` remains the target
contract; the deviations below are intentional and explained.

## Summary of changes

| Method | Path | Status | Auth | Notes |
| --- | --- | --- | --- | --- |
| `POST` | `/api/properties` | **Added** | session cookie | Form post; redirects to the property page |
| `GET` | `/api/properties?organizationId=` | **Added** | session cookie | JSON list, organization-scoped |
| `POST` | `/api/properties/{propertyId}/assets/upload-url` | **Added** | session cookie | Returns a signed upload URL (600 s) |
| `POST` | `/api/assets/{assetId}/complete` | **Added** | session cookie | Validates + processes the uploaded bytes |
| `POST` | `/api/assets/{assetId}/retry` | **Added** | session cookie | Failed-upload recovery; re-issues a URL |
| `GET` | `/api/assets/{assetId}/download-url?organizationId=&variant=` | **Added** | session cookie | Signed download/preview URL (300 s) |
| `PUT` | `/api/storage/upload?token=` | **Added** | signed token only | No session; token binds one key + purpose |
| `GET` | `/api/storage/download?token=` | **Added** | signed token only | No session; hardened response headers |
| `POST` | `/api/auth/register` \| `/login` \| `/logout` | Unchanged (Phase 1) | — | — |
| `POST` | `/api/organizations` | Unchanged (Phase 1) | session cookie | — |
| `GET` | `/api/health`, `/api/health/ready` | Unchanged (Phase 0) | public / operator token | — |

No endpoints were removed or had breaking changes in Phase 2.

## Deviations from `docs/API.md`

| Target contract | Implemented | Reason |
| --- | --- | --- |
| `POST /properties/{id}/assets/complete` | `POST /assets/{assetId}/complete` | The asset id is globally unique and already carries its property; the flatter path avoids redundant ids. Organization scope is taken from the body and authorized. |
| `GET /outputs/{id}/download-url` | `GET /assets/{assetId}/download-url` | Phase 2 has assets, not video outputs; the outputs endpoint arrives in Phase 5. |
| `/api/v1` prefix | No version prefix yet | Versioning is introduced with the OpenAPI document before external consumers exist. Tracked in `docs/decisions/TODO.md`. |
| `Idempotency-Key` on commands | Not implemented | Required for generation and billing commands (Phases 4/6); no financial or generation command exists yet. |
| OpenAPI as contract source of truth | Partial (fragment below) | A full document is produced when the API stabilizes. Recorded as a follow-up. |

## Error envelope

All JSON endpoints use the documented envelope with stable internal codes and no
provider or infrastructure details:

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not have access to this organization",
    "requestId": "b5d1…",
    "details": {}
  }
}
```

Codes in use: `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404),
`VALIDATION_FAILED` (422), `INTERNAL_ERROR` (500).

## OpenAPI fragment (implemented Phase 2 surface)

```yaml
openapi: 3.1.0
info:
  title: Real Estate Virtual Tour AI — Phase 2 surface
  version: 0.2.0
components:
  securitySchemes:
    sessionCookie:
      type: apiKey
      in: cookie
      name: rev_session
    storageToken:
      type: apiKey
      in: query
      name: token
      description: >
        Short-lived HMAC token binding exactly one storage key to exactly one
        purpose (upload XOR download). Not a user credential.
  schemas:
    Error:
      type: object
      required: [error]
      properties:
        error:
          type: object
          required: [code, message, requestId]
          properties:
            code:
              type: string
              enum: [UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, VALIDATION_FAILED, INTERNAL_ERROR]
            message: { type: string }
            requestId: { type: string }
            details: { type: object, additionalProperties: true }
    SignedUrl:
      type: object
      required: [uploadUrl, expiresAt]
      properties:
        assetId: { type: string, example: ast_8sK2 }
        status: { type: string, example: PENDING_UPLOAD }
        uploadUrl:
          type: string
          description: Signed, single-purpose, expiring URL. The storage key is never exposed.
        expiresAt: { type: string, format: date-time }
    AssetStatus:
      type: string
      enum: [PENDING_UPLOAD, UPLOADED, SCANNING, QUARANTINED, PROCESSING, READY,
             REJECTED, FAILED, DELETION_PENDING, DELETED]
paths:
  /api/properties:
    get:
      summary: List properties in an organization
      security: [{ sessionCookie: [] }]
      parameters:
        - { name: organizationId, in: query, required: true, schema: { type: string } }
      responses:
        "200":
          description: Organization-scoped properties
        "403": { description: Not a member of the organization, content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } } }
    post:
      summary: Create a property (form post)
      security: [{ sessionCookie: [] }]
      requestBody:
        content:
          application/x-www-form-urlencoded:
            schema:
              type: object
              required: [organizationId, name, propertyType, rightsConfirmed]
              properties:
                organizationId: { type: string }
                name: { type: string, maxLength: 200 }
                propertyType: { type: string, enum: [APARTMENT, HOUSE, OFFICE, RETAIL, OTHER] }
                addressMasked: { type: string }
                description: { type: string }
                rightsConfirmed:
                  type: string
                  description: Must be present — the customer confirms photo rights.
      responses:
        "303": { description: Redirect to the created property }
  /api/properties/{propertyId}/assets/upload-url:
    post:
      summary: Reserve an asset and issue a signed upload URL
      security: [{ sessionCookie: [] }]
      parameters:
        - { name: propertyId, in: path, required: true, schema: { type: string } }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [organizationId, filename, sizeBytes]
              properties:
                organizationId: { type: string }
                filename: { type: string }
                sizeBytes: { type: integer, minimum: 1 }
      responses:
        "200": { description: Signed upload URL, content: { application/json: { schema: { $ref: "#/components/schemas/SignedUrl" } } } }
        "422": { description: Size or per-property count limit exceeded }
        "403": { description: Missing membership or property:write permission }
  /api/assets/{assetId}/complete:
    post:
      summary: Validate and process uploaded bytes
      security: [{ sessionCookie: [] }]
      parameters:
        - { name: assetId, in: path, required: true, schema: { type: string } }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [organizationId]
              properties: { organizationId: { type: string } }
      responses:
        "200":
          description: >
            Terminal status for this attempt. READY on success; REJECTED,
            QUARANTINED, or FAILED are returned as 200 with the status and a
            sanitized failureReason.
          content:
            application/json:
              schema:
                type: object
                properties:
                  assetId: { type: string }
                  status: { $ref: "#/components/schemas/AssetStatus" }
                  failureReason: { type: [string, "null"] }
                  width: { type: [integer, "null"] }
                  height: { type: [integer, "null"] }
                  duplicateOf: { type: array, items: { type: string } }
  /api/assets/{assetId}/retry:
    post:
      summary: Re-issue a signed upload URL (failed-upload recovery)
      security: [{ sessionCookie: [] }]
      parameters:
        - { name: assetId, in: path, required: true, schema: { type: string } }
      responses:
        "200": { description: Fresh signed upload URL for the same asset }
        "422": { description: Asset is not PENDING_UPLOAD or FAILED }
  /api/assets/{assetId}/download-url:
    get:
      summary: Issue a signed download/preview URL for a READY asset
      security: [{ sessionCookie: [] }]
      parameters:
        - { name: assetId, in: path, required: true, schema: { type: string } }
        - { name: organizationId, in: query, required: true, schema: { type: string } }
        - { name: variant, in: query, schema: { type: string, enum: [normalized, thumbnail] } }
      responses:
        "200": { description: Short-lived signed URL }
        "422": { description: Asset is not READY }
  /api/storage/upload:
    put:
      summary: Accept bytes for exactly one signed storage key
      security: [{ storageToken: [] }]
      requestBody:
        required: true
        content:
          application/octet-stream:
            schema: { type: string, format: binary }
      responses:
        "200": { description: Stored }
        "401": { description: Invalid, expired, tampered, or wrong-purpose token }
        "413": { description: Body exceeds the hard request cap }
  /api/storage/download:
    get:
      summary: Serve bytes for exactly one signed storage key
      security: [{ storageToken: [] }]
      responses:
        "200":
          description: >
            Object bytes with Cache-Control private/no-store,
            X-Content-Type-Options nosniff, and a sandboxing CSP.
        "401": { description: Invalid, expired, tampered, or wrong-purpose token }
        "404": { description: Object not found }
```

## Audit actions added

`property.created`, `property.updated`, `property.deleted`,
`asset.upload_requested`, `asset.upload_completed`, `asset.ready`,
`asset.quarantined`, `asset.rejected`, `asset.failed`,
`asset.download_url_issued`, `asset.deletion_requested`.
