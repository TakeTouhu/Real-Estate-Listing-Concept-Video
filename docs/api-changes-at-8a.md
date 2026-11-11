# API Changes — AT-8a

The members page gives another member a new role, within the viewer's
ceiling (ADR-0139). **No migration, permission or audit action.**

## HTTP

### Added: `POST /api/organizations/{organizationId}/members/{userId}/role`

A form post from the members page. Fields: `role`, and `from`, the role the
page showed.

| Answer | When |
| --- | --- |
| `403` JSON `FORBIDDEN` | the `Origin` is not this site; nothing is read |
| `303` to `/login` | signed out, or a sign-in that is not complete |
| `303` to the members page, `notice=role-changed` | changed (`member.role_changed`), or the member holds that role already (nothing written) |
| `303` to the members page, `error=<code>` | `new-role` (`role` not a role), `may-not-change-role` (`FORBIDDEN`, audited for a member), `not-a-member` (also an id over 64 characters, refused unread), `last-owner`, `member-changed` (the member no longer holds `from`, or `from` is not a role), `role-change-failed` |

### Changed: `GET /organizations/{organizationId}/members`

For a viewer with roles to give, a line on what a role change does, and on
each other member whose role the viewer may give, a role select (`New role
for {email}`) offering the other roles it may give, the role shown as a
hidden `from`, and a **Change role** button. Never on the viewer's own row.
It shows the sentence of each new code.

## Internal API

### Changed: `@app/domain`

| Export | Shape |
| --- | --- |
| `MembersOverview.assignableRoles` | new: with `permission.manage`, the roles the viewer's role may assign, in `ROLES` order; else none |
| `MembersOverviewMember.userId` | new: the member's account id |
| `MembershipService.changeRole(actor, organizationId, member, role, seenRole?)` | new optional `seenRole`: a member holding another role is refused `STALE`, after the ceiling; a change to the role the member holds returns the membership and writes nothing |
| `MembershipChangeRefusal` | new: `LAST_OWNER` or `STALE`, the `details.reason` of the `VALIDATION_FAILED` a role change or removal is refused with |

### Changed: `apps/web` (`lib/members.ts`)

| Export | Shape |
| --- | --- |
| `changeMemberRole(actor, organizationId, memberUserId, { role, from })` | new: the route's work, a notice or an error code; a failure that is not a refusal logged by its code alone |
| `MEMBER_ID_MAX_LENGTH` | new: 64, the longest member id the route asks the service about |
| `MEMBERS_NOTICES`, `MEMBERS_ERRORS` | the codes above and their sentences |

## Sequence

```mermaid
sequenceDiagram
    participant B as Browser (OWNER or ADMIN)
    participant P as Members page
    participant R as POST .../members/{userId}/role
    participant S as MembershipService
    B->>P: GET /organizations/{id}/members
    P->>S: overview: assignableRoles, members with userId
    P-->>B: a role form on each member the viewer may move
    B->>R: role, from (same-origin form post)
    R->>S: changeRole(actor, org, member, role, from)
    S->>S: permission.manage, ceiling of both roles (refusal audited)
    S->>S: the member still holds from, else STALE
    S->>S: role locked as read; last OWNER kept (ADR-0059)
    R-->>B: 303 members page ?notice=role-changed or ?error=code
```
