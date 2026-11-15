# API Changes — AT-9c

The groups page adds and removes a group's members (ADR-0143).
**No migration, permission or audit action.**

## HTTP

### Changed: `GET /organizations/{organizationId}/groups`

Each group also shows:
- when the viewer may add someone, a closed **Add member…** form listing
  the organization's members not in the group whose role the viewer may
  assign;
- on each member whose role the viewer may assign, a closed **Remove…**
  form that says what removing does;
- the sentence of each code below.

### Added: `POST /api/organizations/{organizationId}/groups/{groupId}/members`

A form post from the groups page. Field: `userId`.

| Answer | When |
| --- | --- |
| `403` JSON `FORBIDDEN` | the `Origin` is not this site; nothing is read |
| `303` to `/login` | signed out, or a sign-in that is not complete |
| `303` to the groups page, `notice=group-member-added` | added (`group.member_added`, with the member's role), or already in the group (nothing written) |
| `303` to the groups page, `error=<code>` | `group-gone` (`GROUP`, or a group id over 64 characters), `group-member-gone` (`MEMBER`, or a member id over 64 characters), `group-members-changed` (`STALE`), `may-not-add-group-member` (`FORBIDDEN`, audited for a member), `add-group-member-failed` |

### Added: `POST /api/organizations/{organizationId}/groups/{groupId}/members/{userId}/remove`

A form post from the groups page. No field.

| Answer | When |
| --- | --- |
| `403` JSON `FORBIDDEN` | the `Origin` is not this site; nothing is read |
| `303` to `/login` | signed out, or a sign-in that is not complete |
| `303` to the groups page, `notice=group-member-removed` | removed (`group.member_removed`, with the member's role) |
| `303` to the groups page, `error=<code>` | `group-gone`, `group-member-gone`, `not-in-group` (`NOT_IN_GROUP`), `may-not-remove-group-member` (`FORBIDDEN`, audited for a member), `remove-group-member-failed` |

## Internal API

### Changed: `@app/domain`

| Export | Shape |
| --- | --- |
| `GroupService` | a missing group, and each `NOT_FOUND` of adding or removing a member, now carries `details.reason`, a `GroupNotFoundReason`; revoking a permission the group lacks does not yet (AT-11) |
| `GroupNotFoundReason` | new: `"GROUP" \| "MEMBER" \| "STALE" \| "NOT_IN_GROUP"` |
| `GroupsOverviewGroup` | gains `addable`: the members the viewer may add; its `members` are `GroupsOverviewGroupMember` |
| `GroupsOverviewGroupMember` | new: a `GroupsOverviewMember` with `mayRemove` |

### Added: `apps/web` (`lib/groups.ts`)

| Export | Shape |
| --- | --- |
| `addGroupMember(actor, organizationId, groupId, { userId })` | the add route's work, a notice or an error code |
| `removeGroupMember(actor, organizationId, groupId, memberUserId)` | the remove route's work, a notice or an error code |

Each bounds a member id by `MEMBER_ID_MAX_LENGTH` (64, from
`lib/members.ts`) and logs a failure that is not a refusal by its error code
alone. `GROUPS_NOTICES` and `GROUPS_ERRORS` gain the codes above.

## Sequence

```mermaid
sequenceDiagram
    participant B as Browser (an OWNER or ADMIN)
    participant R as POST .../groups/{groupId}/members
    participant S as GroupService
    participant D as Database
    B->>R: Add to group (same-origin form post, userId)
    R->>S: addMember(actor, org, groupId, userId)
    S->>S: group.manage, the group, the member, the role ceiling (refusals audited)
    S->>D: share-lock the group; grant ceiling; insert the member row
    D->>D: group.member_added, one transaction
    R-->>B: 303 groups page ?notice=group-member-added or ?error=code
```
