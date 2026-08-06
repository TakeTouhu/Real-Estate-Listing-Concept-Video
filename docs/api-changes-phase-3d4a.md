# API Changes — Phase 3D-4a

One new endpoint exposing the correction operation completed in Phase 3D-2, an
additive extension to the existing `AnalysisDto`, and a correctness fix applied
to every nested analysis action route.

**No UI consumes any of this yet.** The reviewer-facing controls are Phase
3D-4b, and Phase 3 is not complete until they ship.

## New — `POST /api/properties/{propertyId}/assets/{assetId}/analysis/correction`

```jsonc
{
  "organizationId": "org_…",
  "roomType": "KITCHEN",   // optional — see below
  "order": 3               // optional — see below
}
```

Session-authenticated. Requires `video:review`, so OWNER, ADMIN and REVIEWER may
call it and **CREATOR may not** — decided by the existing role map in
`AnalysisService.correct`, not by the route.

### The three JSON states

| Body | Meaning |
| --- | --- |
| key **omitted** | leave the stored override unchanged |
| key present, `null` | **clear** the override |
| key present, value | set the override |

The adapter decides this by **property presence** (`"roomType" in body`), never
by truthiness — `null` is a meaningful value, and `if (body.roomType)` would
silently turn a deliberate clear into a no-change. The three states map onto the
domain's `CorrectionField<T>`; `AnalysisService.correct` is unchanged and knows
nothing about JSON.

### Responses

`200` with the standard `AnalysisDto` (below). There is no correction-specific
response shape: analysis reads, review decisions and corrections all return one
representation.

| Code | When |
| --- | --- |
| `200` | Correction applied — **or** a no-op, where the request restated the stored values. The domain writes nothing and audits nothing in that case |
| `401` | No session |
| `403` | Member without `video:review` |
| `404` | Unknown asset, another tenant's asset, **or an asset that does not belong to the property in the URL** |
| `422` | Neither field supplied; unknown room type; an order priority that is not a whole number above zero; or an analysis that is not `SUCCEEDED` + `UNREVIEWED` |
| `500` | Unexpected internal error (envelope only) |

An unknown room type is refused **without echoing the submitted value** into the
message or details.

Correcting an already approved or rejected revision is refused. Refreshing the
analysis starts a new reviewable revision — that rule is unchanged.

## Changed — `AnalysisDto` gains five correction fields (additive)

```jsonc
{
  "roomType": "KITCHEN",            // the ANALYZER's classification, preserved
  "roomTypeOverride": "LIVING_ROOM", // the reviewer's correction, or null
  "effectiveRoomType": "LIVING_ROOM",// what composition uses; derived server-side
  "orderOverride": 3,                // the reviewer's global priority, or null
  "corrected": true                  // whether either override is set
  // …every existing field unchanged
}
```

Every existing field keeps its name, type, nesting and semantics — including the
nested `review` object. The extension is purely additive.

`effectiveRoomType` is resolved on the server through the domain helper so the
browser never reimplements the resolution.

**Still never returned:** `correctedBy`, `correctedAt`, audit metadata,
`compositionFingerprint`, provider internals, storage keys, moderator internals,
and organization internals. `correctedBy`/`correctedAt` are deliberately withheld
until a concrete product requirement appears — a reviewer needs the current
state, and the audit log holds provenance.

## Fixed — nested property/asset route integrity

**A correctness fix, not a feature.** Every nested analysis action route
destructured `propertyId` from the URL and then ignored it:

```
POST   …/assets/{assetId}/analysis          (analyze)
GET    …/assets/{assetId}/analysis          (read)
POST   …/assets/{assetId}/analysis/approve
POST   …/assets/{assetId}/analysis/reject
POST   …/assets/{assetId}/analysis/refresh
```

The services take `organizationId + assetId` and resolve the asset
organization-scoped — correct, and the tenant boundary is intact — but they were
never told which property the URL named. A same-organization asset filed under a
*different* property could therefore be approved, rejected, refreshed or read
through a hand-built path. This is the same defect class found on the storyboard
detail page in Phase 3C-6b.

All five handlers, plus the new correction route, now call
`requireAssetInProperty` before delegating. A mismatch and a genuinely unknown
asset produce the **same** `404` with the same message, so the response never
reveals that the asset exists under another property.

The check is URL integrity only. It authorizes organization membership — exactly
as every read on these routes already did — and grants no new capability. The
action's own `video:review` or `property:write` check still runs afterwards in
the domain: a member without permission still receives `403` on a well-formed
path. No unrelated error is converted into `404`.

**No request or response contract changed** for those five handlers. A caller
using a correct URL sees identical behaviour.

## Not included

No UI, no client error mapper, no schema or migration change, no change to
correction semantics, storyboard ordering, the composition fingerprint, or any
provider.
