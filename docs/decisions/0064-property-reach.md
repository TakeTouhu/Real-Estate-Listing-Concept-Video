# ADR-0064 — Property reach: who reaches which Property, and what everyone else sees

Status: Accepted (Phase 6I-1). Phase 6I-2 extends it to analysis, video
projects and generation.
Implements: ADR-0052 Decision 10:
- *`authorized = tenant boundary AND permission AND Property-derived scope
  predicate`*;
- *`ORGANIZATION` reaches every Property of the organization, `GROUP` the
  Properties assigned to any of the actor's groups, `OWN` the Properties the
  actor is the explicitly assigned responsible user of*;
- *scope is fixed by role*;
- *an ungrouped Property is not reachable through `GROUP`*;
- *`OWN` never means created-by, uploaded-by or requested-by*;
- *changes take effect through the Property*;
- *individual grants do not widen scope*;
- *non-Property permissions keep their own semantics*.

Seventh of the authorization packages, after ADR-0057 to ADR-0062. It uses the
responsible user and group that ADR-0062 stored.

## Context

Until now every content path checked two things: that the member belongs to the
organization, and that it holds the permission. Every member therefore reached
every Property of its organization. ADR-0062 added the data reach needs; this
package enforces it.

No live route adds a member to an organization, so every live organization has
only `OWNER` members, and an `OWNER` reaches every Property. Nothing a customer
can do today changes. Reach has to exist before the first member-management
screen; without it, the first invited `CREATOR` would see every Property.

The work is split in two pull requests of reviewable size:
- **6I-1 (this ADR):** the predicate; the Property paths; the photo paths.
- **6I-2:** the analysis and review paths, video projects and storyboards, and
  generation admission.

---

## Decision 1 — One predicate, judged from the Property's assignments

`packages/domain/src/property/reach.ts`:

- **`reachOf(identity, actor)`** turns an authorized member into its reach. The
  scope comes from the role (`scopeForRole`), never from a grant. For `GROUP` it
  also reads the member's current groups (`listGroupIdsForMember`), once per
  check.
- **`reaches(reach, property)`** is the predicate. It reads the Property's
  organization, responsible user and group, and nothing else:

  | Scope | Reaches a Property when… |
  | --- | --- |
  | `ORGANIZATION` | it belongs to the organization |
  | `GROUP` | its group is one of the member's groups |
  | `OWN` | its responsible user is the member |

  Every reach carries its organization and the predicate compares it, so no
  scope crosses a tenant even if a caller passes the wrong Property.
- **`findReachableProperty(identity, properties, actor, propertyId)`** returns
  the Property, or `null` when it does not exist in the organization or is out
  of reach. A deleted Property is returned as it is, and each caller keeps its
  own rule for it.

`createdBy` is never read. A `MANAGER` is judged by its groups only, so being a
Property's responsible user does not give a `MANAGER` reach to it. That follows
ADR-0052's `GROUP` row word for word.

## Decision 2 — The Property list is filtered in the query

`PropertyRepository.listByOrganization` is replaced by `listReachable(reach)`.
No caller can list Properties without saying whose reach the list is for.

The PostgreSQL implementation adds one condition to the organization and
not-deleted filter:
- `ORGANIZATION`: none;
- `GROUP`: `groupId IN (the member's groups)`;
- `OWN`: `responsibleUserId = the member`.

An empty group list matches nothing. Migration 23's indexes on
(`organizationId`, `responsibleUserId`) and on `groupId` serve both. No
migration is needed.

The in-memory double filters with `reaches` itself.

## Decision 3 — Out of reach is answered exactly as not found

Every path answers a Property out of reach, and anything under it, with the
same status and message it gives for an id that does not exist:
- `404` with "Property not found" or "Asset not found" where a single row is
  named;
- an empty list where a list for an unknown Property is already empty
  (`AssetService.list`).

It is never `403`, so a member cannot tell which Properties exist. This is
ADR-0010's cross-tenant rule applied inside the organization.

## Decision 4 — The order of the checks

On every service path (Decision 5):
1. Organization membership and the permission (`authorizeOrganization`). A
   member without the permission is refused `403` before anything is looked up,
   as before, whether the Property exists or not.
2. The row, and the Property it belongs to. For a photo, its own Property, never
   the one a URL names.
3. Reach.
4. Only then any check of the row's state: "not ready", "not awaiting upload",
   "only pending or failed uploads can be retried".

Checking state before reach would let a state message reveal a row the member
cannot reach.

The nested analysis routes (`/api/properties/{id}/assets/{photo}/analysis…`)
keep the check they already had in front of the analysis service:
`requireAssetInProperty` confirms, with `property.view`, that the photo belongs
to the Property the URL names, and answers `404` otherwise. It lists through
`AssetService.list`, so it now also answers `404` for a photo out of reach. A
member that holds `property.view` but not the action's own permission
(`analysis.review` or `asset.upload`) is therefore refused `403` only for a
photo it reaches. For a photo out of reach it gets the `404` that a missing
photo, a photo under another Property and another organization's photo already
got before this ADR (Decision 3). That tells the member nothing its own
Property list does not.

## Decision 5 — The paths 6I-1 covers

| Service | Path | How the Property is found |
| --- | --- | --- |
| `PropertyService` | `list` | `listReachable` |
| | `get`, `update`, `remove` | the Property id |
| `AssetService` | `requestUpload` | the Property id |
| | `list` | the Property id |
| | `completeUpload`, `createDownloadUrl`, `retryUpload`, `requestDeletion` | the photo's Property |

A signed upload or download URL is issued only after the reach check.

Not changed, and why:
- **`PropertyService.create`.** Creation sets the assignments by role
  (ADR-0062), so its creator always reaches the new Property.
- **`PropertyService.assign`.** Only `OWNER` and `ADMIN` reassign, and they are
  `ORGANIZATION`-scoped.
- **Organization, member, group, permission, billing and audit paths.** Not
  Property-rooted (ADR-0052).
- **Worker and system paths.** No member acts, so there is no reach to judge.
  They stay limited to the organization.
- **The storage upload and download routes.** They serve a signed token, now
  issued only after the reach check.

## Decision 6 — What reaches the web layer

Every route and page calls these services, so none needs a rule of its own:
- `GET /api/properties` lists the member's reach.
- The upload, completion, download-URL and retry routes answer `404` out of
  reach.
- The home page lists through `PropertyService.list`. The four pages under
  `/properties/{id}` read the Property through `PropertyService.get` first, so
  a Property out of reach shows the not-found page.
- The nested analysis routes check the photo through `AssetService.list`
  (`requireAssetInProperty`), so they answer `404` for a photo out of reach
  already.

Until 6I-2, `AnalysisService` and `StoryboardService` are still
organization-wide when called directly. The API routes that reach them without
one of the checks above are:
- `GET /api/properties/{id}/analyses`;
- `GET` and `POST /api/properties/{id}/video-projects`;
- `GET` and `POST /api/video-projects/{id}/storyboard`.

No live organization has a member they would expose.

## Decision 7 — Concurrency

Reach is read when the member is authorized, once per request.
- An action already authorized completes. A reassignment, group membership
  change or role change that commits during it gives the same result as if the
  action had finished just before. ADR-0058, ADR-0060 and ADR-0062 apply the
  same reasoning to role, group and assignment changes.
- A signed URL issued before reach was lost stays valid until it expires: 10
  minutes for an upload, 5 for a download. The same is true today when a
  permission is revoked.
- The next request reads the new reach.

## Decision 8 — Choices ADR-0052 does not make

Recorded in `docs/decisions/TODO.md` for confirmation:

1. **Out of reach is answered exactly as not found** (Decision 3), never `403`.
2. **An out-of-reach answer is not audited**, as a cross-tenant `404` is not.
3. **Reach is read at authorization** (Decision 7). In-flight actions and signed
   URLs already issued are not revoked.
4. **A `MANAGER` is judged by its groups only**, even for a Property it is the
   responsible user of (Decision 1).

## Consequences

- **HTTP.**
  - `GET /api/properties` lists only the Properties the member reaches.
  - The upload, completion, download-URL and retry routes answer `404` for a
    Property or photo out of reach.
  - No route is added or removed, and no response shape changes.
- **Ports.**
  - `PropertyRepository.listByOrganization` is replaced by
    `listReachable(reach)`.
  - `Reach`, `reachOf`, `reaches` and `findReachableProperty` are new exports
    of `@app/domain`.
- **Tests.** Two existing tests read a Property as a `VIEWER` the `OWNER`
  created. They now make the `VIEWER` its responsible user, as ADR-0052
  requires.
- **MFA is still not built.** It must exist before any member, permission,
  group or assignment screen ships.

## Not decided here

- Analysis, review, video projects, storyboards and generation admission
  (6I-2). 6I-2 also refuses a video project under a deleted Property.
- Any route or page for choosing or changing an assignment.
- User and organization deletion releasing assignments.
