# API Changes — Phase 3B-2

Two new endpoints expose the review decisions. One existing response shape gains
a nested object; **no existing field changes or moves**.

Both routes are session-authenticated (`rev_session` cookie), with
`organizationId` supplied in the JSON body and membership verified server-side
by `authorizeOrganization` (ADR-0010).

## Endpoints

### `POST /api/properties/{propertyId}/assets/{assetId}/analysis/approve`

Approve one analysis revision.

```jsonc
{
  "organizationId": "org_…",
  "primaryAssetId": "ast_…",  // required when the duplicate group has >1 member
  "reason": "Looks good"      // optional
}
```

Permission: `video:review` (OWNER / ADMIN / REVIEWER). **`CREATOR` → `403`** —
whoever runs an analysis is not whoever approves it.

### `POST /api/properties/{propertyId}/assets/{assetId}/analysis/reject`

Reject one analysis revision. Also sets the asset's status to `REJECTED`, in the
same database transaction as the review write.

```jsonc
{ "organizationId": "org_…", "reason": "Too blurry" }   // reason required
```

Permission: `video:review`. `CREATOR` → `403`.

Approve and reject are **separate routes**, not one endpoint with a decision
field: they are distinct consequential actions, and rejection additionally
mutates asset status. Neither should be reachable by flipping one body value.

## Response — the nested `review` object

Both routes return the standard analysis representation, which now carries review
state grouped under `review`:

```jsonc
{
  "id": "ana_…",
  "assetId": "ast_…",
  "status": "SUCCEEDED",
  // … existing analysis fields, unchanged …
  "review": {
    "status": "APPROVED",              // UNREVIEWED | APPROVED | REJECTED
    "note": "Looks good",              // null when absent
    "reviewedAt": "2026-07-31T…Z",     // null until reviewed
    "reviewedBy": "usr_…",             // reviewer USER ID only; null until reviewed
    "analysisRevision": 1
  },
  "createdAt": "…",
  "updatedAt": "…"
}
```

`reviewedBy` is the reviewer's **user id and nothing more**. It is deliberately
not expanded into name or email: that would turn every review response into a
directory lookup and disclose more about members than a review client needs. A
test asserts no user name or email appears in the body.

The `review` object also appears on the Phase 3A-3 analysis endpoints, since they
share one representation. That is **additive** — no previously returned field
changed name, type, or position, so existing clients are unaffected.

Still absent, as before: `organizationId` (implied by the authorized request),
`provider` (an internal adapter name), and any storage key.

## Status codes

| Code | When |
| --- | --- |
| `200` | Decision recorded |
| `401` | No session |
| `403` | Not a member, or role lacks `video:review` |
| `404` | Unknown asset, or an asset in another organization |
| `422` | Malformed body; blocking safety finding; revision already reviewed; analysis not `SUCCEEDED`; missing or mismatched `primaryAssetId`; blank rejection reason; **duplicate-group conflict** |
| `500` | Unexpected internal error (envelope only) |

**The duplicate-group conflict is `422`, not `409`.** The domain maps it to
`VALIDATION_FAILED`, and the route does not reinterpret it. Returning `409`
would require a distinct domain error kind; that is deliberately out of scope
here, and a test asserts the status is `422` and not `409` so the decision does
not drift silently.

A foreign asset returns `404`, not `403`: existence in another tenant is never
disclosed.

## What the routes do not decide

Whether a reason is required, whether `primaryAssetId` is needed, whether it
matches, whether the revision was already reviewed, and whether another group
member already holds the approval are **all domain rules**. The handlers
validate the *shape* of the body and delegate; `AnalysisService` has a zero-line
diff in this milestone.

## Not included

- No rate limiting — still the cross-cutting item in `docs/decisions/TODO.md`.
- No review UI — Phase 3B-3.
- No OpenAPI document; this file is the API change summary, as in Phase 2.
