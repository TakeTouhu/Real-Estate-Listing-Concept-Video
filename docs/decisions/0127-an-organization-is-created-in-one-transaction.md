# ADR-0127 — An organization is created in one transaction

Status: Accepted (AT-2, 2026-11-09). Second milestone of the
accounts-and-team plan the product owner approved on 2026-11-09
(`/mnt/project-files/cto/accounts-team-proposal.md`).
Closes the open item *Create an organization in one transaction* in
`docs/decisions/TODO.md`, found during Phase 6E.
Builds on: ADR-0059 (a change and its audit entry in one repository
transaction).

## Context

Creating an organization (`POST /api/organizations`, reachable today) made
three writes in three steps: the organization, the founding `OWNER`
membership, then `organization.created`. A crash or a failed write between
them left one of two states:

- an organization no one belongs to, which no one can reach or remove;
- an organization created with no audit entry.

The same steps chose the slug by reading which slugs were taken, then
writing. Two organizations of the same name created at once both chose the
same slug, and the second failed on the unique key with a generic error.

The plan's team pages, invitations and seat limit all start from an
organization and its first `OWNER`, so this is closed first.

---

## Decision 1 — One repository call writes all three

`OrganizationRepository.createWithOwner` writes the organization, its
founding `OWNER` membership and `organization.created` in one database
transaction. All three are written, or none is, whichever write fails.

The service still decides everything: the name, the slug, the identifier and
the audit entry's content, which is as before (`metadata: { slug }`). The
organization starts `ACTIVE`, requiring no MFA, as before.

`OrganizationRepository.create` and `MembershipRepository.create` remain for
test fixtures. No product code calls either; a test pins that, and that
`createWithOwner` is called only by `OrganizationService.createOrganization`.

## Decision 2 — A slug taken meanwhile is looked for again

When the slug's unique key refuses the organization, because an organization
of the same name committed it first, the whole creation rolls back and the
repository answers `SLUG_TAKEN`. It recognizes this from the error itself:
a unique conflict on the organization's `slug`. Any other failure, a taken
identifier included, is raised as it was.

The service then looks for a free slug again and tries with a new
identifier, up to three attempts (`ORGANIZATION_SLUG_ATTEMPTS`). Three
organizations of one name created at once are all created. After three
refusals it answers `VALIDATION_FAILED` ("Other organizations of the same name
were being created at the same moment; try again"), having written nothing.

The slug's form is unchanged: the name in lower-case ASCII, then `-1`, `-2`
and so on when taken. A name with no ASCII letter or digit, such as a
Japanese name, still becomes `org`. The slug appears on no page and in no
address.

## Consequences

- No organization can exist without its first `OWNER` or without its
  `organization.created` entry.
- Creating two organizations of one name at once creates both.
- The route, the page and the success path are unchanged; the one new answer
  is the refusal after three attempts.
- **Not here:** the search for a free slug reads one slug at a time, so the
  hundredth organization named in Japanese reads a hundred; recorded in
  `docs/decisions/TODO.md`. The route still has no `Origin` check; it is one
  of the routes the open item *Extend the same-origin check to every
  cookie-based mutation route* covers.
- **No migration**, no new route, permission or page.
