# ADR-0147 — Giving and taking back a member's individual permissions

Status: Accepted (AT-11b, 2026-11-16). Second part of AT-11 in the
accounts-and-team plan, which the product owner approved on 2026-11-09
(`/mnt/project-files/cto/accounts-team-proposal.md`): "Individual grants and
group permissions, for holders of `permission.manage`, inside the ceilings
already built".

Builds on: ADR-0052 Decision 10 (the grant ceiling; `disclosure.none` only
from an `OWNER`, to an individual), ADR-0058 (individual grants:
`PermissionGrantService`, its ceiling, its audit entries, grants surviving a
role change), ADR-0065 Decision 18 (who must use MFA), ADR-0139 (the members
page's form posts) and ADR-0146 (a member's permissions page).

## Context

Since AT-11a a member's permissions page shows what they may do and where
each permission comes from, and nothing on it changes anything. Individual
grants have been built and enforced since Phase 6D, with every refusal
audited, but no route reaches them: an `OWNER` cannot give an `ADMIN`
`billing.manage`, nor a `CREATOR` `member.view`, except through the
database.

---

## Decision 1 — Who may give and take back, and how the page knows

Nothing changes who may grant what. `PermissionGrantService` decides every
post as built (ADR-0058): `permission.manage`, then `grantRefusal`. So an
`OWNER` gives any member anything grantable; an `ADMIN` gives a `MANAGER`,
`CREATOR` or `VIEWER` member only what it holds itself, never
`permission.manage`, `billing.manage` or `disclosure.none`; every other role
reaches no one, even one given `permission.manage`. Every refusal of a
member is audited as `permission.grant_refused`, and every grant and
revocation commits with its own audit entry, as before. Someone who is not
a member is refused unaudited, as any access to an organization is.

The page's reading, `MemberPermissionsService.view`, now also answers, for
each permission:
- `mayGrant`: the member holds no individual grant of it, and the viewer's
  `permission.manage` and the ceiling allow giving it;
- `mayRevoke`: the member holds one, and they allow taking it back.

They are asked of the same `grantRefusal`, with the viewer's role and
effective permissions and the member's role. A test checks, for an `OWNER`,
an `ADMIN`, a `MANAGER` given `permission.manage` and a `BILLING` viewer, and
every member and permission, that each answer is what the service then does.

## Decision 2 — What the page offers

- **Give**, on a permission the member **cannot use now**, when `mayGrant`.
  A grant that changes nothing today, of a permission their role or a group
  already gives, is not offered: it would only matter after a later role or
  group change, and a button that seems to do nothing reads as broken. The
  service still accepts such a post, as before.
- **Take back**, on every permission the member holds individually, when
  `mayRevoke`. The page then shows what is left: taking back a grant of
  something their role or a group also gives leaves it in effect.

Above the list, a viewer offered either reads that a permission from the
role or groups changes only with them, that one given individually never
widens which Properties the member reaches (Scope stays fixed by role) and
that it stays if their role changes (ADR-0058 Decision 4).

Giving says what holding the permission brings besides itself:
- `permission.manage` and `billing.manage`: "Whoever holds it must use
  two-step sign-in." It is read from the memberships on every request, so a
  member given one is asked to set it up at their next page (ADR-0065
  Decision 18);
- `member.manage`, `group.manage` and `permission.manage` for any role but
  `OWNER` and `ADMIN`: what their role still keeps them from, in the words
  the page already uses for a held one (ADR-0146 Decision 3).

A permission nothing in the product uses yet is offered like any other, and
still says so (ADR-0146 Decision 4). Given now, it takes effect when the
feature that checks it is built, as a template's does.

## Decision 3 — `disclosure.none` is not offered before Mode C

Mode C, the organization's enablement of it and the consent each video
needs are not built, so the grant would authorize nothing, and the page
could not say what it will do. Giving it is therefore not offered, and the
grant service the web app builds withholds it.

`PermissionGrantService` takes an optional list of permissions a deployment
withholds. Giving one is refused after `permission.manage` and the ceiling,
and audited as `permission.grant_refused` with the reason `withheld`. So an
`OWNER`'s forged post is recorded, and an `ADMIN`'s is still refused and
recorded as `protected`, the reason that matters more. A forged attempt on
the permission ADR-0052 guards most strictly leaves a trace like any other.
The domain's own default withholds nothing, so its tests of the ceiling for
`disclosure.none` stand.

The milestone that builds Mode C offers it, with what it allows. Taking back
a grant of it is offered, to an `OWNER` only, as the ceiling already
decides. Recorded in `TODO.md` for confirmation.

## Decision 4 — Two form posts, answered with the page and a fixed code

`POST /api/organizations/{id}/members/{userId}/permissions/grant` and
`.../revoke`, field `permission`, call `PermissionGrantService.grant` and
`revoke`. Like the members page's routes (ADR-0139), each refuses a post
whose `Origin` is not this site with `403` before anything is read, and
sends a signed-out visitor to `/login`. A `userId` over 64 characters is
refused before the service is asked, so it never reaches the audit log.
Every other answer is `303` to the member's permissions page with exactly
one code:

| Code | When | The page says |
| --- | --- | --- |
| `notice=granted` | given, or held individually already (nothing written) | the permission was given; what they can do now is shown below |
| `notice=revoked` | taken back | their individual permission was taken back |
| `error=permission` | `permission` is missing or not one; the service is not asked | that permission cannot be given or taken back here |
| `error=may-not-grant` | the service refused giving: no `permission.manage`, past the ceiling, `video.share`, `property.create` to a `VIEWER` or `BILLING` member, `disclosure.none` (withheld), or the viewer is not a member | you cannot give that member that permission |
| `error=may-not-revoke` | the service refused taking back | you cannot take that permission back from that member |
| `error=not-granted` | taking back a grant the member does not hold | they do not hold it individually, so there was nothing to take back |
| `error=grant-failed`, `error=revoke-failed` | anything else, logged by its error code alone | something went wrong; check below |

A holder of `permission.manage` giving to someone who is not a member, and
either post naming an id over 64 characters, lands on the members page with
`error=not-a-member` instead, since there is no member page to show. Anyone
else is refused before the member is read. Taking back from someone who is
not a member is `NOT_FOUND` like a grant not held; their permissions page
then says they are not a member. A member removed between the ceiling and
the write is refused by the membership foreign key (ADR-0058 Decision 3):
the post answers `grant-failed`, logged, and the page then says they are not
a member.

A post carries no role shown, unlike a role change: the ceiling is asked
again of the member's current role when the post arrives, so a page shown
before a role change can never give more than the ceiling allows then, and
a grant gives the same permission whatever the role.

## Decision 5 — Reached through one module only

The Phase 6D shape test said no application calls the grant service. It
now says the web app's member permissions module alone constructs it (with
`disclosure.none` withheld), asks it only to grant and to revoke, and is
called for that from the two routes alone.

## Consequences

- No migration, permission or audit action: the entries are Phase 6D's,
  with one new refusal reason, `withheld`.
- An `OWNER` can give an `ADMIN` `billing.manage`, the only way an `ADMIN`
  may buy Units or make any other charge-changing action (ADR-0053
  Decision 5A).
- The browser test of joining by invitation now has the owner give the
  colleague a permission from their permissions page and take it back.

## Not decided here

- A group's permissions (AT-11c), and whether the groups page then offers
  Delete, and adding and removing a member, per group (`TODO.md`, AT-9b).
- Offering `disclosure.none`, with Mode C.
- A member given `permission.manage` whose role reaches no one can tell a
  member from a non-member by the code a grant post answers, as with a role
  change (ADR-0139). Recorded in `TODO.md`.
