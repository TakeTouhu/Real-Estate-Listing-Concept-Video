# Phase 6H completion — Property assignment

Branch: `claude/project-thread-az06z2`
Base: `e0b4d19` (PR #80 merge commit on `main`)
ADR: `docs/decisions/0062-property-assignment.md`
Gap analysis: `docs/phase-6h-gap-analysis.md`

This is the completion record of the sixth authorization package of Phase 6,
not of Phase 6. Later packages are listed under *Carried forward*.

Commits, oldest first:

| Commit | What it carries |
| --- | --- |
| `89c50b8` | the gap analysis |
| `8476740` | migration 23 and the Prisma model; the `PropertyRepository` port with creation and reassignment committed with their audit entries, and its Prisma and in-memory implementations; `PropertyService`'s creation-time rules and `assign`; group deletion and member removal releasing their Properties; the unit, shape and database suites; the earlier phases' migration pins moved to migration 23 |
| *(this commit)* | ADR-0062, the phase documentation and this record |

The exact head SHA is reported with the pull request rather than written into a
file that would have to contain its own hash.

## What this phase changes

- **Migration 23.** Two nullable columns on `properties`, `responsibleUserId`
  and `groupId`. Each foreign key carries the organization and refuses
  deletion (`NO ACTION`). Two indexes. No backfill: every existing Property
  starts unassigned.
- **Creation** sets both assignments by the creator's role (ADR-0052 Decision
  10): an `OWNER` or `ADMIN` chooses either or neither; a `MANAGER` is its own
  responsible user, in one of its own groups; a `CREATOR` is its own
  responsible user, ungrouped. Refusals are audited as
  `property.assignment_refused`. `property.created` records the creator's role
  and both assignments, and now commits with the Property.
- **`PropertyService.assign`** changes either assignment. `OWNER` and `ADMIN`
  only, by role; compare-and-set against the assignments it checked; audited
  as `property.assignment_changed` with the previous and new values.
- **Group deletion** ungroups its Properties and records
  `ungroupedPropertyCount`. **A member's removal** unassigns its Properties and
  records `unassignedPropertyCount`.
- **Concurrency.** An assignment takes the foreign key's share lock on the
  member or group it names; a removal or deletion takes `FOR UPDATE` on that
  row, then locks the Properties in id order before releasing them.

Behavior a member can notice: none. No route or page assigns anything, the
create route passes no assignment, and reach is not enforced yet.
`GET /api/properties` returns two more fields, `null` on every Property.

## An assignment racing a member's removal

```mermaid
sequenceDiagram
  autonumber
  participant O as OWNER
  participant PS as PropertyService
  participant MS as MembershipService
  participant DB as PostgreSQL

  O->>PS: assign(org, property, responsible user M)
  PS->>PS: OWNER or ADMIN; M an eligible member; the Property's assignments
  PS->>DB: BEGIN; UPDATE properties ... WHERE assignments are still as read
  Note over DB: the foreign key share-locks M's membership row
  O->>MS: removeMember(org, M)
  MS->>DB: BEGIN; SELECT M's membership FOR UPDATE
  Note over MS,DB: waits for the assignment
  PS->>DB: INSERT property.assignment_changed; COMMIT
  MS->>DB: SELECT M's Properties ORDER BY id FOR UPDATE
  MS->>DB: UPDATE them: no responsible user
  MS->>DB: DELETE the membership (grants and group rows cascade)
  MS->>DB: INSERT member.removed (unassignedPropertyCount 1); COMMIT

  Note over O,DB: the other order
  O->>MS: removeMember(org, M)
  MS->>DB: BEGIN; SELECT M's membership FOR UPDATE
  O->>PS: assign(org, property, responsible user M)
  PS->>DB: BEGIN; UPDATE properties ...
  Note over PS,DB: the foreign key waits for the removal
  MS->>DB: no Property names M; DELETE the membership; member.removed (0); COMMIT
  DB-->>PS: foreign key violation: M is gone
  PS->>DB: ROLLBACK
  PS-->>O: VALIDATION_FAILED, the assignment changed meanwhile
```

A group's deletion races an assignment the same way, under 6G's lock on the
group row.

## Verification

Measured on the committed tree `7083dd81831ff6963f598865ff2d46b3ef0f5ee8` (commit `84767401bc9487c5a7925570e180477856747f4f`), against a local
PostgreSQL 16 configured like CI.

| Check | Result |
| --- | --- |
| `pnpm lint` | clean |
| `pnpm typecheck` (root, all packages, `tests/integration`) | clean |
| `pnpm test` | **5062 / 5062**, 163 files (the assignment suite: 35; the shape test: 6) |
| `pnpm test:db` | **1319 / 1320**, 45 files (the assignment suite: 26 / 26); the one failure is the known race test below |
| `pnpm build` | Next.js production build succeeded |
| `prisma migrate diff` (migrations → schema) | no difference |
| `prisma migrate status` | 24 migrations, schema up to date |

**The one database failure is not this change's.** Both full runs failed one
test, "gives two PROCESSING runners one history and at most one transfer" in
`tests/integration/provider-output-orchestration.db.test.ts`.
`docs/decisions/TODO.md` has recorded it since Phase 6F as asserting too much:
a legal interleaving makes the losing runner answer
`OUTPUT_VERIFICATION_REPLAYED`, which the test does not expect. This change
touches neither that file nor the provider-output code it exercises; its
fixture writes its Properties directly, and they start unassigned. Run alone
five times on this tree, it passed four.

CI on the pull request's exact head is reported with the pull request.

The database races are deterministic. A third transaction holds a lock, or
makes the competing change and holds it uncommitted, until every contender is
waiting on a lock; contenders start one at a time, each once the one before it
waits, so they queue in a known order. The cases:
- an assignment, and a creation, committing while a member's removal waits,
  and a removal committing while an assignment or creation waits;
- the same for a group's deletion, including a `MANAGER`'s creation in its
  only group;
- a reassignment taking a Property away from the member or group first, which
  the release then neither clears nor counts;
- two reassignments checked against the same assignments;
- a group's deletion and a member's removal releasing the same two Properties,
  in each order, without deadlock.

## Mutation ledger

One textual edit per definition, at an anchor that must occur exactly once, run
against the suite or suites listed for it. Every mutated file is restored and
re-hashed. A SHA-256 manifest of all 763 files in the working tree is
compared before and after the pass. A kill counts only when tests ran and
failed; a mutant that does not parse would count as broken.

**Authoritative: 73 run, 73 killed, 0 survivors, 0 broken, 0
anchor-missing**, in one uninterrupted pass against the tree `7083dd81831ff6963f598865ff2d46b3ef0f5ee8` (commit
`84767401bc9487c5a7925570e180477856747f4f`), the reviewed runtime tree. The only later commit is this one, which
changes documentation only. All 763 files were byte-identical after the
pass.

| # | Area | Mutation | File | Suites | Killed by |
| --- | --- | --- | --- | --- | --- |
| A01 | authority | only an OWNER chooses freely and reassigns; an ADMIN is held to the fixed rules | `property-service.ts` | property + identity + assignment database | property + identity: 6 of 397 failed |
| A02 | authority | a MANAGER chooses freely and reassigns | `property-service.ts` | property + identity + assignment database | property + identity: 6 of 397 failed |
| A03 | authority | anyone in the organization reassigns | `property-service.ts` | property + identity + assignment database | property + identity: 4 of 397 failed |
| A04 | authority | property.edit authorizes reassignment | `property-service.ts` | property + identity + assignment database | property + identity: 2 of 397 failed |
| A05 | lookup | a deleted Property can be reassigned | `property-service.ts` | property + identity + assignment database | property + identity: 1 of 397 failed |
| R01 | partial | an omitted responsible user is unset | `property-service.ts` | property + identity + assignment database | property + identity: 3 of 397 failed |
| R02 | partial | an omitted group is unset | `property-service.ts` | property + identity + assignment database | property + identity: 2 of 397 failed |
| R03 | no-op | a change that changes nothing still writes | `property-service.ts` | property + identity + assignment database | property + identity: 1 of 397 failed |
| R04 | no-op | a change of the group alone writes nothing | `property-service.ts` | property + identity + assignment database | property + identity: 3 of 397 failed |
| R05 | eligibility | a reassignment may name a BILLING member or a non-member | `property-service.ts` | property + identity + assignment database | property + identity: 1 of 397 failed |
| R06 | eligibility | an unchanged responsible user is checked again | `property-service.ts` | property + identity + assignment database | property + identity: 1 of 397 failed |
| R07 | group | a reassignment may name another organization's group | `property-service.ts` | property + identity + assignment database | property + identity: 1 of 397 failed |
| R08 | audit | the change records the new responsible user as the previous one | `property-service.ts` | property + identity + assignment database | property + identity: 2 of 397 failed |
| R09 | audit | the change records the new group as the previous one | `property-service.ts` | property + identity + assignment database | property + identity: 2 of 397 failed |
| R10 | stale | a reassignment that lost its race is answered as done | `property-service.ts` | property + identity + assignment database | property + identity: 1 of 397 failed |
| R11 | stale | a creation that lost its race is answered as done | `property-service.ts` | property + identity + assignment database | assignment database: 2 of 69 failed |
| C01 | owner/admin | an OWNER or ADMIN may name a BILLING member or a non-member | `property-service.ts` | property + identity + assignment database | property + identity: 1 of 397 failed |
| C02 | owner/admin | an OWNER or ADMIN may name another organization's group | `property-service.ts` | property + identity + assignment database | property + identity: 1 of 397 failed |
| C03 | owner/admin | an OWNER's or ADMIN's Property defaults to its creator | `property-service.ts` | property + identity + assignment database | property + identity: 4 of 397 failed |
| C04 | fixed | a MANAGER or CREATOR may name anyone | `property-service.ts` | property + identity + assignment database | property + identity: 2 of 397 failed |
| C05 | fixed | a MANAGER or CREATOR may not even name itself | `property-service.ts` | property + identity + assignment database | property + identity: 2 of 397 failed |
| C06 | creator | a CREATOR may name a group, which is ignored | `property-service.ts` | property + identity + assignment database | property + identity: 1 of 397 failed |
| C07 | creator | a CREATOR is treated as a MANAGER | `property-service.ts` | property + identity + assignment database | property + identity: 2 of 397 failed |
| C08 | manager | a MANAGER may name a group it does not belong to | `property-service.ts` | property + identity + assignment database | property + identity: 1 of 397 failed |
| C09 | manager | a MANAGER's named group is replaced by its first | `property-service.ts` | property + identity + assignment database | property + identity: 1 of 397 failed |
| C10 | manager | a MANAGER in no group creates an ungrouped Property | `property-service.ts` | property + identity + assignment database | property + identity: 1 of 397 failed |
| C11 | manager | a MANAGER in several groups gets its first without naming one | `property-service.ts` | property + identity + assignment database | property + identity: 1 of 397 failed |
| C12 | manager | a MANAGER is not its Property's responsible user | `property-service.ts` | property + identity + assignment database | property + identity: 1 of 397 failed |
| C13 | eligibility | a BILLING member is eligible | `property-service.ts` | property + identity + assignment database | property + identity: 2 of 397 failed |
| C14 | eligibility | a non-member is eligible | `property-service.ts` | property + identity + assignment database | property + identity: 2 of 397 failed |
| C15 | group | any group id is a group of the organization | `property-service.ts` | property + identity + assignment database | property + identity: 2 of 397 failed |
| C16 | audit | creation records no initial assignments | `property-service.ts` | property + identity + assignment database | property + identity: 6 of 397 failed |
| C17 | audit | creation records the creator as the OWNER | `property-service.ts` | property + identity + assignment database | property + identity: 4 of 397 failed |
| F01 | refusal | a refusal is not audited | `property-service.ts` | property + identity + assignment database | property + identity: 9 of 397 failed |
| F02 | refusal | a creation's refusal names a Property | `property-service.ts` | property + identity + assignment database | property + identity: 1 of 397 failed |
| F03 | refusal | a refusal records no requested responsible user | `property-service.ts` | property + identity + assignment database | property + identity: 6 of 397 failed |
| F04 | refusal | a refusal is not an error | `property-service.ts` | property + identity + assignment database | property + identity: 9 of 397 failed |
| G01 | audit | a group's deletion records no ungrouped count | `group-service.ts` | property + identity + assignment database | property + identity: 4 of 397 failed |
| G02 | audit | a member's removal records no unassigned count | `membership-service.ts` | property + identity + assignment database | property + identity: 2 of 397 failed |
| P01 | atomic audit | a creation commits outside its audit entry's transaction | `property-repositories.ts` | assignment database | assignment database: 1 of 69 failed |
| P02 | atomic audit | a reassignment commits outside its audit entry's transaction | `property-repositories.ts` | assignment database | assignment database: 1 of 69 failed |
| P03 | stale | a creation the foreign key refused is an error | `property-repositories.ts` | assignment database | assignment database: 3 of 69 failed |
| P04 | stale | a reassignment the foreign key refused is an error | `property-repositories.ts` | assignment database | assignment database: 3 of 69 failed |
| P05 | stale | an audit entry's foreign key failure is answered as stale | `property-repositories.ts` | assignment database | assignment database: 2 of 69 failed |
| P06 | compare-and-set | a reassignment ignores the responsible user it expected | `property-repositories.ts` | assignment database | assignment database: 2 of 69 failed |
| P07 | compare-and-set | a reassignment ignores the group it expected | `property-repositories.ts` | assignment database | assignment database: 1 of 69 failed |
| P08 | compare-and-set | a deleted Property can be reassigned | `property-repositories.ts` | assignment database | assignment database: 1 of 69 failed |
| P09 | tenant | a reassignment ignores the organization | `property-repositories.ts` | assignment database | assignment database: 1 of 69 failed |
| P10 | compare-and-set | a reassignment that matched nothing still writes its audit entry | `property-repositories.ts` | assignment database | assignment database: 2 of 69 failed |
| P11 | mapping | a Property reads no responsible user | `property-repositories.ts` | assignment database | assignment database: 3 of 69 failed |
| P12 | create | a creation writes no group | `property-repositories.ts` | assignment database | assignment database: 3 of 69 failed |
| P13 | update | an edit writes the assignments from its snapshot | `property-repositories.ts` | assignment database | assignment database: 1 of 69 failed |
| L01 | release | ungrouping takes no lock on the Properties | `property-release.ts` | assignment database | assignment database: 1 of 69 failed |
| L02 | release | unassigning takes no lock on the Properties | `property-release.ts` | assignment database | assignment database: 1 of 69 failed |
| L03 | release | unassigning reaches the member's Properties in another organization | `property-release.ts` | assignment database | assignment database: 1 of 69 failed |
| L04 | release | a release clears the other assignment | `property-release.ts` | assignment database | assignment database: 3 of 69 failed |
| G03 | deletion | a group's deletion ungroups nothing | `group-repository.ts` | assignment database | assignment database: 5 of 69 failed |
| G04 | deletion | a group's deletion counts no Property | `group-repository.ts` | assignment database | assignment database: 4 of 69 failed |
| G05 | tenant | a member's groups are read across organizations | `group-repository.ts` | assignment database | assignment database: 2 of 69 failed |
| M01 | removal | a member's removal takes no lock on the membership | `repositories.ts` | assignment database | assignment database: 2 of 69 failed |
| M02 | removal | a member's removal ignores the role it was checked against | `repositories.ts` | assignment database | assignment database: 1 of 69 failed |
| M03 | removal | a member's removal unassigns nothing | `repositories.ts` | assignment database | assignment database: 7 of 69 failed |
| M04 | removal | a member's removal counts no Property | `repositories.ts` | assignment database | assignment database: 6 of 69 failed |
| I01 | double | the in-memory group deletion ungroups nothing | `in-memory.ts` | property + identity | property + identity: 1 of 397 failed |
| I02 | double | the in-memory removal unassigns nothing | `in-memory.ts` | property + identity | property + identity: 1 of 397 failed |
| I03 | double | the in-memory MANAGER's groups ignore the organization | `in-memory.ts` | property + identity | property + identity: 1 of 397 failed |
| I04 | double | the in-memory edit writes the assignments from its snapshot | `in-memory-property.ts` | property + identity | property + identity: 1 of 397 failed |
| I05 | double | the in-memory assignment ignores the foreign key on members | `in-memory-property.ts` | property + identity | property + identity: 2 of 397 failed |
| I06 | double | the in-memory reassignment ignores the responsible user it expected | `in-memory-property.ts` | property + identity | property + identity: 1 of 397 failed |
| S01 | migration | a member's removal silently clears its Properties | migration 23 | property + identity | property + identity: 1 of 397 failed |
| S02 | migration | the responsible user is any user, of any organization | migration 23 | property + identity | property + identity: 1 of 397 failed |
| S03 | migration | the group is any organization's | migration 23 | property + identity | property + identity: 1 of 397 failed |
| S04 | dormancy | the create route passes an assignment | `route.ts` | property + identity | property + identity: 1 of 397 failed |

"Killed by" names the first suite that failed and how many of its tests failed.
Mutations with both suites listed run the property and identity unit suites
first, then the three database suites (assignment, groups, membership
changes). S01 to S04 edit the migration's text or the create route and are
killed by the shape test; the migration as applied is what the database suite
tests.

Not defined, because they are not observable by a test:

- **A release locking its Properties in another order.** PostgreSQL's scans
  over these indexes already visit equal keys in physical order, so the
  `ORDER BY` is the guarantee rather than an observable difference.
- **Locking the group row explicitly before an assignment.** The foreign key's
  lock already excludes a concurrent deletion (ADR-0062 Decision 6).
- **A group's release dropping the organization from its filter.** The group's
  foreign key carries the organization, so every Property naming a group is
  already in that group's organization. A first pass ran this mutation and it
  survived for that reason; the filter stays, as in the member's release, where
  it is needed because one user can be a member of several organizations (L03).

## Required phase documentation

| Item | Where |
| --- | --- |
| Architecture diagram | `docs/architecture.md` status table (Phase 6H row) |
| Entity-relationship diagram | `docs/er-diagram.md`: the two `PROPERTIES` foreign keys in the implemented schema, and *Phase 6H* |
| Critical sequence diagram | this record, *An assignment racing a member's removal* |
| OpenAPI / API change summary | HTTP: `GET /api/properties` returns `responsibleUserId` and `groupId` on each Property (additive; `null` on every existing Property). No route added, removed or otherwise changed; `POST /api/properties` accepts no assignment. Internal API: `PropertyService.assign` and the creation-time assignment fields of `CreatePropertyInput`; `PropertyRepository.create` (with its audit entry, answering `CREATED` or `STALE`) and `PropertyRepository.assign`; `MembershipRepository.remove` taking an audit builder; `DeletedGroup.ungroupedPropertyCount`; `GroupRepository.listGroupIdsForMember`; two `property.assignment_*` audit actions |
| Change log / release notes | the commit list above and the pull request description |
| Database migration notes | `docs/migration-notes.md`, *Phase 6H* (migration 23) |
| Phase completion report | this file |

## Activation status

**Dormant.** No HTTP route or page assigns a Property, and reach is not
enforced. No timer, cron or loop is introduced. Paid Provider Activation,
production Provider credentials, production paid AI calls, production scheduler
activation and live Stripe charges all remain **BLOCKED**.

## Carried forward

- **Enforcing reach (6I).** The `GROUP` and `OWN` predicates on every content
  path, children reached through their Property, and the answer for a Property
  out of reach. Until then every role reaches every Property of its
  organization. Recommended first: removing the near-duplicate review screen
  (ADR-0052 Decision 14), which groups photos across the whole organization.
- **MFA** for `OWNER`, `ADMIN` and every holder of `permission.manage` or
  `billing.manage`, before any member-management, grant, group or assignment UI
  ships.
- **User and organization deletion** must release assignments as a member's
  removal does.
- The Phase 6C, 6D, 6F, 6G and 6H choices ADR-0052 did not make, recorded in
  `TODO.md` for confirmation.
- Recorded in `TODO.md` from earlier packages:
  - two concurrent invitations of the same email can both be created;
  - organization creation writes its rows separately;
  - a provider-output race test asserts too much (test-only).
- **Open decision gates** from earlier packages:
  - what a customer regeneration costs in Units;
  - what happens to a self-service renewal whose payment fails.
- Later Phase 6 commercial packages:
  - the customer-approved Unit purchase;
  - cancellation, upgrade and downgrade;
  - seats and storage blocks;
  - Stripe billing;
  - charged disclosure recomposition and Mode C admission;
  - the internal recovery budget;
  - the Cost Safety Guard threshold;
  - reconciliation and admin controls.
