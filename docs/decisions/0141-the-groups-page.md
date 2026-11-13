# ADR-0141 — The groups page: seeing the groups and creating one

Status: Accepted (AT-9a, 2026-11-13). First part of AT-9 in the
accounts-and-team plan, which the product owner approved on 2026-11-09
(`/mnt/project-files/cto/accounts-team-proposal.md`): "Groups page". AT-9 is
split in three:
- AT-9a (this ADR) shows the groups and creates one;
- AT-9b renames and deletes a group;
- AT-9c adds and removes a group's members.

Builds on: ADR-0052 Decisions 10 and 11 (groups, protected deletion),
ADR-0058 (effective permissions), ADR-0060 (groups and who may change them),
ADR-0064 (a `MANAGER` reaches the Properties of its groups), ADR-0134 (the
members page) and ADR-0136 (a form post answered with the page and a fixed
code).

## Context

`GroupService` has existed since Phase 6F (ADR-0060), with group permissions
since Phase 6G (ADR-0061). A Property can be assigned to a group (ADR-0062),
and a `MANAGER` reaches only the Properties of its groups (ADR-0064). No page
or route called the service, so no organization could have a group. This ADR
adds the groups page, which lists the groups and creates one. It adds no rule
about who may create a group: every refusal is the group service's, as built.

---

## Decision 1 — A groups page for a holder of `group.view`

`/organizations/{id}/groups` reads `GroupsOverviewService.overview`, new in
`@app/domain`. It needs `group.view`, an effective permission (ADR-0058):
- by template an `OWNER`, `ADMIN` or `MANAGER` holds it;
- a `CREATOR`, `VIEWER` or `BILLING` member holds it only by an individual
  grant or a group's permission (ADR-0058, ADR-0061).

Anyone else, member or not, sees the same refusal sentence. A signed-out
visitor goes to `/login`.

The page shows:
- the groups by name;
- each group's members, with name and role, in the members page's order
  (role, then the longest-standing member);
- how many members each group has.

**A member's address is shown only to a viewer who also holds
`member.view`**, the members page's own permission (ADR-0134). Every
template that holds `group.view` holds `member.view` too, so by template
everyone who sees the page sees the addresses. A member granted `group.view`
alone sees names and roles, and no address the members page would not show
them. ADR-0060 lets `group.view` list a group's members, but says nothing
about addresses, so the page takes the narrower reading; `TODO.md` asks to
confirm it.

The overview reads the groups, every member row of the organization's
groups (`listMembersByOrganization`, new on the group repository), the
memberships, and the accounts of the members in some group. That is the
same number of reads however many groups there are. A member removed
between the reads is left out. Viewing writes nothing and audits nothing,
as a `group.view` listing never has (ADR-0060).

The page says what a group does today: a `MANAGER` reaches the Properties
assigned to the groups it belongs to (ADR-0064). It shows neither a group's
permissions (AT-11) nor its Properties (AT-10). The dashboard links each
organization's groups page next to its members page, and the groups page
links back to the members page.

## Decision 2 — Creating a group: one form post, answered with the page and a fixed code

A holder of `group.manage` sees the **Create group** form: one name field,
required, at most 100 characters. Its post is
`POST /api/organizations/{id}/groups`, field `name`, which calls
`GroupService.create`.

Like the members page's routes (ADR-0136), it refuses a post whose `Origin`
is not this site with `403` before anything is read, and sends a signed-out
visitor to `/login`. Every other answer is `303` to the groups page with
exactly one code:

| Code | When | The page says |
| --- | --- | --- |
| `notice=group-created` | created (`group.created`, with the name) | the group was created |
| `error=group-name` | `INVALID_NAME`: empty or blank, longer than 100 characters once trimmed, or no field | enter a name of 1 to 100 characters |
| `error=group-name-taken` | `NAME_TAKEN`: another group of the organization has it | another group has that name |
| `error=may-not-create-group` | `FORBIDDEN`: a member without `group.manage` (audited before the name is read), or no member of this organization | cannot create groups |
| `error=create-group-failed` | anything else | check below whether the group was created |

The name never goes into the address or the log; anything unexpected is
logged with the error's code alone. The page shows a known code's fixed
sentence, and nothing for any other value or a repeated parameter.

## Decision 3 — A refused name says why

`GroupService` refused both bad names as `VALIDATION_FAILED`, told apart only
by their messages. Each now carries `details.reason`, as a refused membership
change does (ADR-0139):
- `INVALID_NAME` for a name that is not 1 to 100 characters once trimmed;
- `NAME_TAKEN` for a name another group of the organization has.

The type is `GroupNameRefusal`. A rename's name refusals carry the same
reasons. Codes, messages and audit entries do not change.

A name holding a NUL character is now `INVALID_NAME` too. PostgreSQL cannot
store that character in text, so such a name failed in the database before
and the page said something went wrong.

## Consequences

- One page, one route and one read service are new. There is no migration,
  permission or audit action. A creation is audited as `group.created`, and
  a refusal as `group.change_refused` with `operation: "create"`, as before.
- The groups dormancy test now allows `GroupService` and group repository
  calls in `apps/web/src/lib/groups.ts` only, `createGroup` from this route,
  and of the service's operations only `create`. AT-9b and AT-9c widen that
  list. The application's own tests are not counted as callers.
- The members page's order moves into one helper, `compareMembers`, shared
  by both overviews. The role names move to `lib/role-names.ts`, and the
  parsing of a page's code to `lib/page-codes.ts`, shared by both pages.
- A browser test signs up an owner, follows the Groups link, creates a
  group, and is refused a second group of the same name.
- AT-9b adds renaming and deleting. Deleting stays `OWNER`/`ADMIN`-only even
  with `group.manage` (ADR-0052 Decision 11). AT-9c adds and removes members
  under the role-assignment ceiling (ADR-0060).
