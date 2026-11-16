# ADR-0146 — A member's permissions page

Status: Accepted (AT-11a, 2026-11-15). First part of AT-11 in the
accounts-and-team plan, which the product owner approved on 2026-11-09
(`/mnt/project-files/cto/accounts-team-proposal.md`): "Individual grants and
group permissions, for holders of `permission.manage`, inside the ceilings
already built".

Builds on: ADR-0052 Decision 10 (the permission matrix, Scope fixed by role,
the role-assignment ceiling, `disclosure.none` individual-only, `video.share`
reserved), ADR-0058 (individual grants; listing a member's needs
`member.view`), ADR-0060 (groups; seeing them needs `group.view`), ADR-0061
(group permissions; a group never carries `disclosure.none` or
`video.share`), ADR-0134 (the members page) and ADR-0144 (a name or address
only for a viewer holding the permission that shows it).

## Context

A member's permissions add up from three places: the template of their role,
individual grants (Phase 6D) and the permissions of the groups they belong to
(Phase 6G). All three are built and enforced, but nothing shows them: an
`OWNER` cannot see what a colleague may do, nor why. Giving and taking
permissions, the rest of AT-11, needs that view first.

---

## Decision 1 — AT-11 in three parts

| Part | What |
| --- | --- |
| AT-11a (this ADR) | A member's permissions page: what they may do and where each permission comes from. Read only |
| AT-11b | Giving a member, and taking from them, an individual permission on that page |
| AT-11c | A group's permissions on the groups page: seeing them, giving and taking them |

Each part stays near the size the repository's pull request policy asks for.
None changes who may grant what: every refusal stays
`PermissionGrantService`'s or `GroupService`'s, as built.

## Decision 2 — Who sees a member's permissions

A holder of `member.view`, as listing a member's individual grants already
requires (ADR-0058): by template an `OWNER`, `ADMIN`, `MANAGER` or `BILLING`
member, or anyone granted it. Anyone else, a member of another organization
included, is refused alike, without the organization's name. A `userId`
naming no member of the organization is answered "not a member", as is a
member whose account is gone between the reads.

The names of the groups that give a permission are shown only to a viewer
holding `group.view`, which seeing groups needs (ADR-0060); a viewer without
it, such as a `BILLING` member, is told how many of the member's groups give
it. That is a little more than such a viewer could learn before: for a
member in one group, the count shows which permissions that group carries,
which `GroupService.listPermissions` refuses without `group.view`. It is
accepted, because a holder of `member.view` sees what the member may do in
any case, and a group's name and members stay hidden.

Viewing writes nothing and audits nothing, as a `member.view` listing never
has.

## Decision 3 — What the page shows

`MemberPermissionsService.view` is new. For the member, it answers their
name, address and role, the scope their role fixes, and, for **every
permission a member can hold** (the vocabulary less `video.share`, which no
template gives and no one may grant), in vocabulary order:
- whether it is **in effect**, as `effectivePermissions` decides;
- whether **their role** gives it, an **individual grant** gives it, and
  **which of their groups** give it.

The page, `/organizations/{organizationId}/members/{userId}/permissions`,
lists them in five areas (organization and team; Properties and photos;
videos; Units and billing; the audit log), each with a name saying what it
lets a member do, its key, and a sentence: "Yes, from their role, an
individual grant and the group "East"." or "No.". A group's name is quoted,
being the organization's own text. The page says that permissions add up and
nothing takes one away, and which Properties the member's permissions over
Properties apply to: every Property, those of their groups, or those they
are responsible for, as their role decides.

Only `property.create` can be given and still not be in effect, for a
`VIEWER` or `BILLING` member (ADR-0052 Decision 10). The page says so,
there and on that row: "No, although it comes from the group "East": it is
never in effect for a Viewer member."

Holding `member.manage`, `group.manage` or `permission.manage` reaches
another member only within the role-assignment ceiling, which gives every
role but `OWNER` and `ADMIN` no one. So for any other member holding one,
the row adds what their role still keeps them from: "Their role lets them
invite or remove no one.", "Their role lets them add no one to a group, nor
remove anyone." or "Their role lets them change no one's role or
permissions."

## Decision 4 — Saying what nothing uses yet

Seven permissions gate nothing in the product today, because what they are
for is not built: `organization.view` (membership alone opens an
organization), `organization.manage`, `video.regenerate`,
`disclosure.change`, `disclosure.none` (Mode C), `audit.view` and
`audit.export`. The page adds "Nothing in VTaVision uses it yet." to each,
so that holding one, or later giving one, does not look like it does
something. The list is the web app's (`NOT_YET_USED`). A test fails until a
feature that starts checking one takes it off: it compares the list with the
permissions no application or package code names.

## Decision 5 — The members page links to it

Each member on the members page links to their permissions page
("Permissions"). The members page already needs `member.view`, so everyone
who sees the link may open it.

## Consequences

- No migration, API route, permission or audit action.
- A browser test opens an owner's own permissions from the members page.

## Not decided here

- A member without `member.view` seeing their own permissions: the page
  follows the domain rule, and refuses them.
- Giving and taking individual permissions (AT-11b), including whether
  `disclosure.none` is offered before Mode C exists.
- A group's permissions (AT-11c).
