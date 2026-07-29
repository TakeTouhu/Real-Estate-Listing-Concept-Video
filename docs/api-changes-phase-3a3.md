# API Changes — Phase 3A-3

Four new endpoints expose the analysis service. No existing endpoint changes.

All routes are session-authenticated (`rev_session` cookie). `organizationId` is
supplied by the caller — in the JSON body for `POST`, in the query string for
`GET` — and membership is verified server-side by `authorizeOrganization`. There
is no active-organization concept in the session; this matches the Phase 1/2
convention for `/api/properties` and `/api/assets/*`, and is recorded in
**ADR-0010 — organization context resolution**.

## Endpoints

### `POST /api/properties/{propertyId}/assets/{assetId}/analysis`

Start the analysis for one asset, or return the existing one.

Body: `{ "organizationId": "org_…" }`
Permission: `property:write` (OWNER / ADMIN / CREATOR). `REVIEWER` → `403`.

Idempotent: an asset that already has a `SUCCEEDED` analysis returns that
analysis and the provider is **not** called again. Always `200` — see
"Status codes" below for why there is no `201`.

### `POST /api/properties/{propertyId}/assets/{assetId}/analysis/refresh`

Recompute a completed analysis, reusing the same row and calling the provider
again.

Body: `{ "organizationId": "org_…" }`
Permission: `property:write`. `REVIEWER` → `403`.

A separate route rather than a flag on the endpoint above: re-running spends
provider work, so it should not be reachable by editing one field of an
ordinary retry.

### `GET /api/properties/{propertyId}/assets/{assetId}/analysis?organizationId=org_…`

One asset's analysis. `404` when the asset has no analysis.
Permission: read-level — any member, including `REVIEWER`.

### `GET /api/properties/{propertyId}/analyses?organizationId=org_…`

Analyses for a property's assets: `{ "analyses": [ … ] }`.
Permission: read-level — any member, including `REVIEWER`.

## Response model

```jsonc
{
  "id": "ana_…",
  "assetId": "ast_…",
  "status": "PENDING | SUCCEEDED | FAILED",
  "roomType": "KITCHEN",          // null until an analysis succeeds
  "confidence": 0.8,              // 0..1, null when not yet computed
  "qualityScore": 0.7,
  "brightnessScore": 0.5,
  "blurScore": 0.2,
  "duplicateGroup": "dup_ast_…",  // null when the asset has no perceptual hash
  "detectedObjects": [{ "label": "sink", "confidence": 0.9 }],
  "safetyFlags": [{ "code": "LOW_RESOLUTION", "severity": "WARNING", "message": "…" }],
  "suggestedOrder": 5,
  "failureReason": "Analysis timed out",   // sanitized; null unless FAILED
  "lowConfidence": false,         // derived server-side from the documented threshold
  "hasBlockingFlag": false,       // derived server-side
  "createdAt": "2026-07-28T00:00:00.000Z",
  "updatedAt": "2026-07-28T00:00:00.000Z"
}
```

**Deliberately absent:** `organizationId` (implied by the authorized request),
`provider` (an internal adapter name), and `reviewedBy` / `reviewedAt` (unwritten
until the Phase 3B review surface). Storage keys are not part of the entity and
so cannot appear. `failureReason` is the provider's *normalized* message; no
vendor payload, URL, or host reaches a response body. A test asserts all of this
against the serialized response.

`lowConfidence` and `hasBlockingFlag` are computed server-side from the Phase
3A-1 helpers, so clients cannot drift from the documented thresholds.

## Status codes

| Code | When |
| --- | --- |
| `200` | Success, including an idempotent re-request and a refresh |
| `401` | No session |
| `403` | Not a member, or role lacks `property:write` |
| `404` | Unknown asset, an asset owned by another organization, or no analysis yet |
| `422` | Missing/malformed `organizationId`, invalid JSON, or an asset that is not `READY` |
| `500` | Unexpected internal error (envelope only, no internals) |

Two deliberate deviations from the Phase 3A-3 plan, both consequences of the
"routes are thin adapters" rule:

- **No `201`.** Distinguishing "created" from "returned existing" is a business
  fact only the service knows. Inferring it in the route (by comparing
  timestamps, say) would put a business decision in the web layer, so `POST`
  returns `200` in both cases.
- **`422`, not `400`/`409`.** Statuses come from the existing shared
  `AppError` → HTTP mapping (`VALIDATION_FAILED` → 422). Re-mapping a
  non-`READY` asset to `409` would require the route to interpret *why* the
  service refused, which is the same violation.

A foreign asset returns `404`, not `403`: existence in another tenant is never
disclosed.

## Not included

- **No rate limiting yet.** See `docs/phase-3a3-completion.md` and
  `docs/decisions/TODO.md`.
- No review/approval endpoints — Phase 3B.
- No OpenAPI document; this file is the API change summary, as in Phase 2.
