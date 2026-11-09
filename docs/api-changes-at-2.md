# API Changes — AT-2

An organization is created in one transaction (ADR-0127). **No migration, no
new route and no page.**

## HTTP

### `POST /api/organizations` (form post; changed inside, same shape)

| Case | Before | After |
| --- | --- | --- |
| Success | the organization, its `OWNER` and `organization.created`, written in three steps; redirect to `/` | the same three, in one transaction; same redirect |
| A write fails | the writes before it stayed: an organization with no `OWNER`, or with no audit entry | nothing is written; redirect to `/` with the error, as before |
| An organization of the same name takes the slug first | fails on the unique key; redirect with "Could not create organization" | the slug is looked for again and the organization is created |
| The slug is taken three times in a row | not possible as such | redirect with "Other organizations of the same name were being created at the same moment; try again", nothing written |

A blank name is refused as before ("Organization name is required").

## Internal API

### Added: `@app/domain`

| Export | Shape |
| --- | --- |
| `OrganizationRepository.createWithOwner({ organization, ownerUserId, audit })` | writes the organization, an `OWNER` membership for `ownerUserId` and `audit` in one transaction; answers `{ outcome: "CREATED", organization, membership }`, or `{ outcome: "SLUG_TAKEN" }` having written nothing when the slug's unique key refuses it; any other failure is raised |
| `CreateOrganizationWithOwnerInput`, `CreateOrganizationWithOwnerOutcome` | its input and answer |
| `ORGANIZATION_SLUG_ATTEMPTS` | `3`, the attempts `createOrganization` makes before it gives up |

### Changed: `@app/domain`

| Export | Change |
| --- | --- |
| `OrganizationService.createOrganization` | makes its writes through `createWithOwner`; retries a `SLUG_TAKEN` with a newly found slug and a new identifier; result unchanged |
| `OrganizationRepository.create` | documented as for test fixtures only; no product code calls it, nor `MembershipRepository.create` |
