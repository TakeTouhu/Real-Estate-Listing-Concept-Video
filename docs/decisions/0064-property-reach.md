# ADR-0064 — Property reach: who reaches which Property, and what everyone else sees

Status: Accepted (Phase 6I-1: Properties and photos). Extended in Phase 6I-2 to
analyses and their review, video projects, storyboards and generation
admission.
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
- **6I-1:** the predicate; the Property paths; the photo paths.
- **6I-2:** the analysis and review paths, video projects and storyboards, and
  generation admission; refusing a new video project under a deleted Property
  (Decision 9).

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
- `404` with the message that path gives for a missing row where a single row
  is named: "Property not found", "Asset not found", "Analysis not found for
  this asset" or "Video project not found";
- an empty list where a list for an unknown Property is already empty
  (`AssetService.list`, `AnalysisService.listForProperty`).

A photo out of reach is answered as a photo with no analysis when its analysis
is read or reviewed, and as a missing photo when an analysis is started or
refreshed, because those are the answers each path gives for an id that does not
exist.

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
   "only pending or failed uploads can be retried" (6I-1); "only READY assets
   can be analyzed", an analysis not yet succeeded or already reviewed, too few
   approved photos to compose, a storyboard never composed or out of date
   (6I-2).

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

## Decision 5 — The paths covered

| Service | Path | How the Property is found | Package |
| --- | --- | --- | --- |
| `PropertyService` | `list` | `listReachable` | 6I-1 |
| | `get`, `update`, `remove` | the Property id | 6I-1 |
| `AssetService` | `requestUpload` | the Property id | 6I-1 |
| | `list` | the Property id | 6I-1 |
| | `completeUpload`, `createDownloadUrl`, `retryUpload`, `requestDeletion` | the photo's Property | 6I-1 |
| `AnalysisService` | `analyzeAsset` (start, refresh) | the photo's Property | 6I-2 |
| | `listForProperty` | the Property id | 6I-2 |
| | `getForAsset` | the photo's Property | 6I-2 |
| | `approve`, `reject`, `correct` (`requireReviewable`) | the photo's Property | 6I-2 |
| `StoryboardService` | `createProject`, `listProjects` | the Property id | 6I-2 |
| | `compose` | the project's Property | 6I-2 |
| | `getStoryboard`, `isFresh`, `assertFresh` (`freshnessOf`) | the project's Property | 6I-2 |

A signed upload or download URL is issued only after the reach check.

`AnalysisService` now takes the Property repository (`findById` only) to judge
a photo's Property. `GenerationService.startScene` has no Property lookup of its
own: it runs `assertFresh` and `getStoryboard` for the acting member first, so a
project out of reach is refused there, as a missing project, before any model
is chosen or any row written.

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
- **An existing video project of a deleted Property.** It can still be read and
  composed through the storyboard paths, as before 6I. Decision 9 covers only
  creating and listing. The pages under `/properties/{id}` already show a
  deleted Property as not found.

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
- From 6I-2, `GET /api/properties/{id}/analyses` answers a Property out of reach
  with `{ "analyses": [] }`, as for one that does not exist.
- From 6I-2, `GET` and `POST /api/properties/{id}/video-projects` and `GET` and
  `POST /api/video-projects/{id}/storyboard` answer `404` out of reach, with the
  body they give for a missing id, and create nothing.

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

## Decision 9 — A deleted Property takes no new video project

`StoryboardService.createProject` and `listProjects` checked that the Property
existed but not that it was deleted. From 6I-2 they answer a deleted Property
with `404` "Property not found", for every role, as the Property and photo paths
already do. Nothing else about a deleted Property's existing projects changes
(Decision 5).

## Consequences

- **HTTP.**
  - `GET /api/properties` lists only the Properties the member reaches.
  - The upload, completion, download-URL and retry routes answer `404` for a
    Property or photo out of reach.
  - From 6I-2, `GET /api/properties/{id}/analyses` lists nothing for a
    Property out of reach, and the video-project and storyboard routes answer
    `404` out of reach, and for a deleted Property's project list or new
    project.
  - No route is added or removed, and no response shape changes.
- **Ports.**
  - `PropertyRepository.listByOrganization` is replaced by
    `listReachable(reach)`.
  - `Reach`, `reachOf`, `reaches` and `findReachableProperty` are new exports
    of `@app/domain`.
  - `AnalysisServiceDeps` gains `properties` (6I-2).
- **Tests.** Two existing tests read a Property as a `VIEWER` the `OWNER`
  created. They now make the `VIEWER` its responsible user, as ADR-0052
  requires. In 6I-2, the existing analysis, review and storyboard suites whose
  acting member is a `MANAGER`, `CREATOR` or `VIEWER` make it reach its
  Property the same way.
- **MFA is still not built.** It must exist before any member, permission,
  group or assignment screen ships.

## Not decided here

- Whether a deleted Property's existing video projects can still be read,
  composed and admitted for generation (Decision 5). Recorded in
  `docs/decisions/TODO.md`.
- Any route or page for choosing or changing an assignment.
- User and organization deletion releasing assignments.
