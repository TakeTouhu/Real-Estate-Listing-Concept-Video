# Phase 6I completion — Property reach

Branch: `claude/project-thread-az06z2`
Base: `5c6a74d` (PR #82 merge commit on `main`)
ADR: `docs/decisions/0064-property-reach.md`
Gap analysis: `docs/phase-6i-gap-analysis.md`

This is the completion record of the seventh authorization package of Phase 6,
not of Phase 6. The package ships as two pull requests: **6I-1** (Properties
and photos, PR #83, merged as `16b52c5`) and **6I-2** (analyses, video
projects, storyboards and generation admission), each recorded below.

## 6I-1 — Properties and photos

Commits, oldest first:

| Commit | What it carries |
| --- | --- |
| `daf373f` | `reach.ts` (`Reach`, `reachOf`, `reaches`, `findReachableProperty`); `PropertyRepository.listReachable` replacing `listByOrganization`, in PostgreSQL and in the in-memory double; reach on `PropertyService` list, get, update and remove and on the six `AssetService` paths; the predicate, per-path, route and database suites; two existing tests that now assign their `VIEWER` |
| *(this commit)* | ADR-0064, the gap analysis, the documentation updates and this record |

The exact head SHA is reported with the pull request rather than written into a
file that would have to contain its own hash.

### What this milestone changes

- **Reach.** A member reaches a Property by its role's fixed scope:
  `ORGANIZATION` (`OWNER`, `ADMIN`, `BILLING`) every Property of the
  organization; `GROUP` (`MANAGER`) those in any of its current groups; `OWN`
  (`CREATOR`, `VIEWER`) those it is the responsible user of. The predicate reads
  the Property's organization and assignments only; `createdBy` authorizes
  nothing.
- **The Property list** is filtered in the query by the member's reach.
- **Property get, update and remove**, and **every photo path** (request,
  complete and retry upload; list; download URL; deletion request), answer a
  Property out of reach, and a photo under it, exactly as one that does not
  exist: the same `404` and message, or the same empty list. The permission is
  checked first and the photo's state last.
- No migration, no route added or removed, no response shape changed.

Behaviour a member can notice: none today. No live route adds a member, so
every live organization has only `OWNER` members, and an `OWNER` reaches every
Property.

### A CREATOR asking for a photo of a Property it does not reach

```mermaid
sequenceDiagram
  autonumber
  participant C as CREATOR
  participant API as download-url route
  participant AS as AssetService
  participant DB as PostgreSQL

  C->>API: GET /api/assets/{photo}/download-url?organizationId=org
  API->>AS: createDownloadUrl(creator, org, photo)
  AS->>DB: membership and effective permissions
  Note over AS: property.view held
  AS->>DB: SELECT media_assets WHERE id = photo AND organizationId = org
  AS->>DB: SELECT properties WHERE id = photo's Property AND organizationId = org
  Note over AS: OWN scope; the Property's responsible user is someone else
  AS-->>API: NOT_FOUND "Asset not found" (no signed URL, no audit entry)
  API-->>C: 404, the same body as for a photo id that does not exist
```

A `MANAGER` is judged the same way, except that reach reads its current groups
(`listGroupIdsForMember`) and compares the Property's group.

### Verification

Measured on the committed tree `bdfc706f1ae7bec78666fb194cebcb1cc18f898d` (commit `daf373fccb16f2e0a89362a7bcd11798b3ba6e75`),
against a local PostgreSQL 16 configured like CI.

| Check | Result |
| --- | --- |
| `pnpm lint` | clean |
| `pnpm typecheck` (root, all packages, `tests/`) | clean |
| `pnpm test` | **5100 / 5100, 167 files (the predicate: 7; every path by role: 21; the routes: 9)** |
| `pnpm test:db` | **1324 / 1324, 46 files (the reach suite: 6)** |
| `pnpm build` | Next.js production build succeeded |
| `prisma migrate diff` (migrations → schema) | no difference |
| `prisma migrate status` | 25 migrations, schema up to date |

Every database test passed, including the provider-output race test that `docs/decisions/TODO.md` has recorded since Phase 6F as able to fail on a legal interleaving; this change touches neither that test nor the code it exercises.

CI on the pull request's exact head is reported with the pull request.

New tests:
- **The predicate** (`reach.test.ts`): each scope against assigned, unassigned,
  grouped and ungrouped Properties and another organization's; the scope of
  every role; a `MANAGER`'s groups read as they are now; a deleted Property
  returned for its caller to judge; the creator reaching nothing by authorship.
- **Every path by role** (`property-reach.test.ts`): six Properties (unassigned,
  the `CREATOR`'s, the `VIEWER`'s, two of the `MANAGER`'s groups, and one in
  another group with the `MANAGER` as responsible user) against every role.
  The list names exactly the Properties each role reaches. Every read and write
  out of reach is answered exactly as a missing id and changes nothing: no audit
  entry, no signed URL, no row. The permission is checked before reach, and
  reach before a photo's state. A reassignment, a group membership change and a
  role change each take effect on the next request, with no assignment
  rewritten.
- **Routes** (`tests/api/property-reach-routes.test.ts`): `GET /api/properties`
  and the upload, completion, download-URL and retry routes, against the real
  services. Out of reach, each answers the same status and body (without the
  per-request id) as a missing id, and issues no signed URL.
- **PostgreSQL** (`property-reach.db.test.ts`): `listReachable` for each scope,
  including a `MANAGER` in no group, another organization's group, and a
  deleted Property; the services through the Prisma repositories; a
  reassignment and a group membership change on the next request.

### Mutation ledger

Each mutant removes or weakens one piece of reach, at an anchor that must occur
exactly once, and runs against the suites listed for it. Every mutated file is
restored and re-hashed. A SHA-256 manifest of all 775 files in the
working tree is compared before and after the pass. A kill counts only when
tests ran and failed; a mutant that does not parse would count as broken.

**Authoritative: 28 run, 28 killed, 0 survivors, 0 broken, 0 anchor-missing**, in one uninterrupted pass against the tree
`bdfc706f1ae7bec78666fb194cebcb1cc18f898d` (commit `daf373fccb16f2e0a89362a7bcd11798b3ba6e75`), the reviewed runtime tree. The only
later commit is this one, which changes documentation only. All 775
files were byte-identical after the pass.

| # | Area | Mutation | File | Suites | Killed by |
| --- | --- | --- | --- | --- | --- |
| Q01 | predicate | no organization check in the predicate | `reach.ts` | unit + database | unit: 1 of 192 failed |
| Q02 | predicate | GROUP reaches any grouped Property | `reach.ts` | unit + database | unit: 7 of 192 failed |
| Q03 | predicate | GROUP also reaches an ungrouped Property | `reach.ts` | unit + database | unit: 5 of 192 failed |
| Q04 | predicate | OWN is read from the creator | `reach.ts` | unit + database | unit: 19 of 192 failed |
| Q05 | predicate | OWN also reaches an unassigned Property | `reach.ts` | unit + database | unit: 15 of 192 failed |
| Q06 | reachOf | a MANAGER is ORGANIZATION-scoped | `reach.ts` | unit + database | unit: 7 of 192 failed |
| Q07 | reachOf | a CREATOR or VIEWER is ORGANIZATION-scoped | `reach.ts` | unit + database | unit: 17 of 192 failed |
| Q08 | reachOf | a MANAGER's reach includes every group of the organization | `reach.ts` | unit + database | unit: 7 of 192 failed |
| Q09 | helper | findReachableProperty ignores reach | `reach.ts` | unit + database | unit: 16 of 192 failed |
| P01 | property | the list is the whole organization | `property-service.ts` | unit + database | unit: 4 of 192 failed |
| P02 | property | get skips reach | `property-service.ts` | unit + database | unit: 3 of 192 failed |
| P03 | property | update skips reach | `property-service.ts` | unit | unit: 2 of 192 failed |
| P04 | property | remove skips reach | `property-service.ts` | unit | unit: 1 of 192 failed |
| P05 | order | update checks its permission after reach | `property-service.ts` | unit | unit: 1 of 192 failed |
| A01 | photo | requesting an upload skips reach | `asset-service.ts` | unit + database | unit: 2 of 192 failed |
| A02 | photo | completing an upload skips reach | `asset-service.ts` | unit + database | unit: 2 of 192 failed |
| A03 | photo | listing a Property's photos skips reach | `asset-service.ts` | unit + database | unit: 1 of 192 failed |
| A04 | photo | a download URL skips reach | `asset-service.ts` | unit + database | unit: 4 of 192 failed |
| A05 | photo | retrying an upload skips reach | `asset-service.ts` | unit + database | unit: 2 of 192 failed |
| A06 | photo | a deletion request skips reach | `asset-service.ts` | unit | unit: 1 of 192 failed |
| A07 | order | a download URL checks the photo's state before reach | `asset-service.ts` | unit + database | unit: 1 of 192 failed |
| A08 | photo | the photo helper skips reach | `asset-service.ts` | unit + database | unit: 9 of 192 failed |
| R01 | prisma | the GROUP filter is dropped | `property-repositories.ts` | database | database: 3 of 32 failed |
| R02 | prisma | the OWN filter is dropped | `property-repositories.ts` | database | database: 2 of 32 failed |
| R03 | prisma | a MANAGER in no group lists every grouped Property | `property-repositories.ts` | database | database: 1 of 32 failed |
| R04 | prisma | the list includes deleted Properties | `property-repositories.ts` | database | database: 4 of 32 failed |
| R05 | prisma | the list ignores the organization | `property-repositories.ts` | database | database: 3 of 32 failed |
| R06 | in-memory | the in-memory list ignores reach | `in-memory-property.ts` | unit | unit: 4 of 192 failed |

"unit" is the property domain suites, the reach route suite and the web
library suites. "database" is `property-reach.db.test.ts` and
`property-assignment.db.test.ts`.

### Required documentation

| Item | Where |
| --- | --- |
| Architecture diagram | `docs/architecture.md` status table (a Phase 6I-1 row; the Phase 6H row no longer says reach is unbuilt) |
| Entity-relationship diagram | Not applicable: no table, column or constraint changes. `docs/er-diagram.md` notes that the Phase 6H assignments are now enforced |
| Critical sequence diagram | this record, *A CREATOR asking for a photo of a Property it does not reach* |
| OpenAPI / API change summary | HTTP: `GET /api/properties` lists only the Properties the member reaches. `POST /api/properties/{id}/assets/upload-url`, `POST /api/assets/{id}/complete`, `GET /api/assets/{id}/download-url` and `POST /api/assets/{id}/retry` answer `404` for a Property or photo out of reach, with the body they give for a missing id. No route added or removed; no response shape changed. Internal API: `Reach`, `reachOf`, `reaches` and `findReachableProperty`; `PropertyRepository.listReachable` replaces `listByOrganization` |
| Change log / release notes | the commit list above and the pull request description |
| Database migration notes | Not applicable: no migration. `docs/migration-notes.md` records that migration 23's indexes serve the reach filter |
| Phase completion report | this file (6I-1; 6I-2 extends it) |

Also updated: `docs/Roadmap.md`, `docs/decisions/TODO.md` (the scope items'
progress, the four choices recorded for confirmation) and the `Scope` comment
in `roles.ts`.

### Activation status

No timer, cron or loop is introduced. Paid Provider Activation, production
Provider credentials, production paid AI calls, production scheduler activation
and live Stripe charges all remain **BLOCKED**.

### Carried forward to 6I-2

- `AnalysisService` (analyze, refresh, list, read, approve, reject, correct) and
  `StoryboardService` (create and list projects, compose, read a storyboard),
  and generation admission through them. Until then the API routes that reach
  them without passing a Property or photo check are organization-wide:
  `GET /api/properties/{id}/analyses`, the video-project routes and the
  storyboard routes. No live organization has a member they would expose.
- Refusing a video project under a deleted Property.
- Two comments that still describe the removed duplicate-approved invariant.

Carried forward from earlier packages, unchanged: MFA before any member, grant,
group or assignment screen; user and organization deletion releasing
assignments; the earlier packages' choices recorded in `TODO.md`; the
provider-output race test that asserts too much (Phase 6F).

## 6I-2 — Analyses, video projects and storyboards

Base: `16b52c5` (PR #83 merge commit on `main`).

Commits, oldest first:

| Commit | What it carries |
| --- | --- |
| `90e1f55` | reach on the seven `AnalysisService` paths (start, refresh, list, read, approve, reject, correct) and the `StoryboardService` paths (create and list projects, compose, read a storyboard, freshness), which generation admission runs first; `AnalysisService` taking the Property repository; a deleted Property taking no new video project and listing none; the per-path, route and database suites; existing suites whose acting member is not organization-wide now making it reach its Property; two comments that described the removed duplicate-approved invariant |
| *(this commit)* | ADR-0064 extended, the gap analysis, the documentation updates and this section |

### What this milestone changes

- **Analyses and their review.** Starting or refreshing an analysis, listing a
  Property's analyses, reading one, and approving, rejecting or correcting one
  judge the photo's own Property. Out of reach, a read or a review is answered
  as a photo with no analysis ("Analysis not found for this asset"), starting
  one as a missing photo ("Asset not found"), and the list as empty.
- **Video projects and storyboards.** Creating and listing projects judge the
  Property ("Property not found"); composing, reading a storyboard and the
  freshness check judge the project's Property ("Video project not found").
- **Generation admission.** `GenerationService.startScene` runs the freshness
  check and reads the storyboard as the acting member first, so a project out
  of reach is refused as a missing project before any model is chosen or any
  row written.
- **Order.** The permission is checked first and the row's state last: an
  analysis not yet succeeded or already reviewed, a photo not ready, too few
  approved photos to compose, a storyboard never composed or out of date.
- **A deleted Property** takes no new video project and lists none, for every
  role, as one that does not exist (ADR-0064 Decision 9).
- No migration, no route added or removed, no response shape changed.

Behaviour a member can notice: only the deleted-Property refusal. Creating or
listing video projects of a deleted Property through the API is now answered
`404` "Property not found", for an `OWNER` too; the pages already showed a
deleted Property as not found. Every other change concerns members who are not
organization-wide, and no live organization has one.

### A CREATOR composing a storyboard under a Property it does not reach

```mermaid
sequenceDiagram
  autonumber
  participant C as CREATOR
  participant API as storyboard route
  participant SS as StoryboardService
  participant DB as PostgreSQL

  C->>API: POST /api/video-projects/{project}/storyboard
  API->>SS: compose(creator, org, project, bounds)
  SS->>DB: membership and effective permissions
  Note over SS: video.generate held
  SS->>DB: SELECT video_projects WHERE id = project AND organizationId = org
  SS->>DB: SELECT properties WHERE id = project's Property AND organizationId = org
  Note over SS: OWN scope; the Property's responsible user is someone else
  SS-->>API: NOT_FOUND "Video project not found" (no photo read, no moderation, no scene written)
  API-->>C: 404, the same body as for a project id that does not exist
```

Generation admission takes the same path: `startScene` calls `assertFresh`,
which stops at the same reach check.

### Verification

Measured on the committed tree `cc1001ec892044c8eb6481ce79a5f22c57d9383e` (commit `90e1f55e4c71b88b9646cc85c75b72d5f849b3b3`),
against a local PostgreSQL 16 configured like CI.

| Check | Result |
| --- | --- |
| `pnpm lint` | clean |
| `pnpm typecheck` (root, all packages, `tests/`) | clean |
| `pnpm test` | **5132 / 5132, 169 files (every content path by role: 21; the routes: 11)** |
| `pnpm test:db` | **1328 / 1328, 47 files (the content reach suite: 4)** |
| `pnpm build` | Next.js production build succeeded |
| `prisma migrate diff` (migrations → schema) | no difference |
| `prisma migrate status` | 25 migrations, schema up to date |

CI on the pull request's exact head is reported with the pull request.

New tests:
- **Every content path by role** (`content-reach.test.ts`): the six Properties
  of the Property suite, each with a photo, an analysis and a video project,
  against every role, through the real `PropertyService`, `AnalysisService`,
  `StoryboardService` and `GenerationService`. Each role lists the analyses and
  projects of exactly the Properties it reaches. Every read and each of the six
  writes out of reach (start, refresh, approve, reject, correct, create a
  project) is answered exactly as a missing id and changes nothing; composing
  and generation admission out of reach write nothing and ask for no model. A
  `MANAGER` reviews in its groups' Properties, not in one it is only the
  responsible user of. The permission is checked before reach, and reach before
  a photo's, an analysis's or a storyboard's state. A deleted Property takes no
  new project and lists none. A reassignment and a group membership change
  take effect on the next request.
- **Routes** (`tests/api/content-reach-routes.test.ts`): `GET
  /api/properties/{id}/analyses`, `GET` and `POST
  /api/properties/{id}/video-projects`, and `GET` and `POST
  /api/video-projects/{id}/storyboard`, against the real services. Out of
  reach, each answers the same status and body (without the per-request id) as
  a missing id and creates no project. On the member's own Property each goes
  on to the path's own checks: the reads and the project creation succeed, and
  composing a single unapproved photo is refused for the minimum (`422`).
- **PostgreSQL** (`content-reach.db.test.ts`): a `CREATOR` reading and
  reviewing only under the Property it is responsible for, with no review
  written elsewhere; a `MANAGER` through its group; a deleted Property refusing
  a new project and its list, with no project row written; a reassignment on
  the next request.

### Mutation ledger

Each mutant removes or weakens one piece of reach, at an anchor that must occur
exactly once, and runs against the suites listed for it, stopping at the first
that fails. Every mutated file is restored and re-hashed. A SHA-256 manifest of
all 781 files in the working tree is compared before and after the pass. A kill
counts only when tests ran and failed; a mutant that does not parse would count
as broken.

**Authoritative: 18 run, 18 killed, 0 survivors, 0 broken, 0 anchor-missing**, in one uninterrupted pass against the tree
`cc1001ec892044c8eb6481ce79a5f22c57d9383e` (commit `90e1f55e4c71b88b9646cc85c75b72d5f849b3b3`), the reviewed runtime tree. The only
later commit is this one, which changes documentation only. All 781 files were
byte-identical after the pass.

| # | Area | Mutation | File | Suites | Killed by |
| --- | --- | --- | --- | --- | --- |
| N01 | analysis | starting or refreshing an analysis skips reach | `analysis-service.ts` | unit | unit: 3 of 1174 failed |
| N02 | order | starting an analysis checks the photo's state before reach | `analysis-service.ts` | unit | unit: 1 of 1174 failed |
| N03 | analysis | listing a Property's analyses skips reach | `analysis-service.ts` | unit + database | unit: 4 of 1174 failed |
| N04 | analysis | reading one analysis skips reach | `analysis-service.ts` | unit + database | unit: 2 of 1174 failed |
| N05 | analysis | approve, reject and correct skip reach | `analysis-service.ts` | unit + database | unit: 5 of 1174 failed |
| N06 | order | review checks the analysis's state before reach | `analysis-service.ts` | unit | unit: 5 of 1174 failed |
| N07 | answer | review answers a photo out of reach with `403` | `analysis-service.ts` | unit + database | unit: 5 of 1174 failed |
| N08 | order | review checks its permission after reach | `analysis-service.ts` | unit | unit: 7 of 1174 failed |
| N09 | helper | a photo is judged by its organization only | `analysis-service.ts` | unit + database | unit: 9 of 1174 failed |
| S01 | project | creating a project skips reach | `storyboard-service.ts` | unit | unit: 2 of 1174 failed |
| S02 | deleted | creating a project accepts a deleted Property | `storyboard-service.ts` | unit + database | unit: 1 of 1174 failed |
| S03 | project | listing projects skips reach | `storyboard-service.ts` | unit + database | unit: 2 of 1174 failed |
| S04 | deleted | listing projects accepts a deleted Property | `storyboard-service.ts` | unit + database | unit: 1 of 1174 failed |
| S05 | storyboard | composing skips reach | `storyboard-service.ts` | unit | unit: 3 of 1174 failed |
| S06 | order | composing checks the minimum before reach | `storyboard-service.ts` | unit | unit: 3 of 1174 failed |
| S07 | storyboard | reading a storyboard, freshness and generation admission skip reach | `storyboard-service.ts` | unit + database | unit: 5 of 1174 failed |
| S08 | order | freshness reads "never composed" before reach | `storyboard-service.ts` | unit | unit: 5 of 1174 failed |
| S09 | order | creating a project checks its permission after reach | `storyboard-service.ts` | unit | unit: 1 of 1174 failed |

"unit" is the property, analysis, storyboard and generation domain suites, the
content reach, analysis, review and storyboard route suites and the web library
suites. "database" is `content-reach.db.test.ts` and
`review-look-alike-approval.db.test.ts`. The unit suites killed every mutant
first, so the database suites did not run for any.

### Required documentation

| Item | Where |
| --- | --- |
| Architecture diagram | `docs/architecture.md` status table (a Phase 6I-2 row; the Phase 6I-1 row no longer says the rest is organization-wide) |
| Entity-relationship diagram | Not applicable: no table, column or constraint changes. `docs/er-diagram.md` notes that analyses and video projects now inherit their Property's reach |
| Critical sequence diagram | this section, *A CREATOR composing a storyboard under a Property it does not reach* |
| OpenAPI / API change summary | HTTP: `GET /api/properties/{id}/analyses` answers `{ "analyses": [] }` for a Property out of reach. `GET` and `POST /api/properties/{id}/video-projects` and `GET` and `POST /api/video-projects/{id}/storyboard` answer `404` out of reach, with the body they give for a missing id; the two video-project routes also answer `404` for a deleted Property. No route added or removed; no response shape changed. Internal API: `AnalysisServiceDeps.properties` |
| Change log / release notes | the commit list above and the pull request description |
| Database migration notes | Not applicable: no migration. `docs/migration-notes.md` records that no query or index changes |
| Phase completion report | this file |

Also updated: ADR-0064 (status, Decisions 3 to 6, Decision 9, consequences),
`docs/phase-6i-gap-analysis.md` (status, what 6I-2 found), `docs/Roadmap.md`
and `docs/decisions/TODO.md` (the Scope items closed, and one new open item).

### Activation status

No timer, cron or loop is introduced. Paid Provider Activation, production
Provider credentials, production paid AI calls, production scheduler activation
and live Stripe charges all remain **BLOCKED**.

### Found during 6I-2, not changed

A video project created before its Property was deleted can still be read and
composed through the storyboard paths, and generation admission accepts its
storyboard if it is fresh. This was so before 6I and ADR-0052 does not settle
it, so it is recorded in `docs/decisions/TODO.md` for a decision rather than
changed here.

### Carried forward

MFA before any member, grant, group or assignment screen; user and organization
deletion releasing assignments; the deleted-Property question above; the
choices recorded in `TODO.md` for confirmation; the provider-output race test
that asserts too much (Phase 6F).
