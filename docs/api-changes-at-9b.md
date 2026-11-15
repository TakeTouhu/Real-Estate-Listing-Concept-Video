# API Changes — AT-9b

The groups page renames and deletes a group (ADR-0142).
**No migration, permission or audit action.**

## HTTP

### Changed: `GET /organizations/{organizationId}/groups`

Each group also shows:
- for a holder of `group.manage`, a closed **Rename…** form holding the
  group's name, with the name shown as a hidden `from`;
- for an `OWNER` or `ADMIN` holding `group.manage`, a closed **Delete…**
  form that says what deleting does;
- the sentence of each code below.

### Added: `POST /api/organizations/{organizationId}/groups/{groupId}/rename`

A form post from the groups page. Fields: `name`, `from`.

| Answer | When |
| --- | --- |
| `403` JSON `FORBIDDEN` | the `Origin` is not this site; nothing is read |
| `303` to `/login` | signed out, or a sign-in that is not complete |
| `303` to the groups page, `notice=group-renamed` | renamed (`group.renamed`), or the name it had (nothing written) |
| `303` to the groups page, `error=<code>` | `group-name` (`INVALID_NAME`, or no `name`), `group-name-taken` (`NAME_TAKEN`), `group-changed` (`STALE`, or no `from`, once the permission is asked), `group-gone` (`NOT_FOUND`, or an id over 64 characters), `may-not-rename-group` (`FORBIDDEN`, audited for a member), `rename-group-failed` |

### Added: `POST /api/organizations/{organizationId}/groups/{groupId}/delete`

A form post from the groups page. No field.

| Answer | When |
| --- | --- |
| `403` JSON `FORBIDDEN` | the `Origin` is not this site; nothing is read |
| `303` to `/login` | signed out, or a sign-in that is not complete |
| `303` to the groups page, `notice=group-deleted` | deleted (`group.deleted`, with the name, the members removed and the Properties ungrouped) |
| `303` to the groups page, `error=<code>` | `group-gone` (`NOT_FOUND`, or an id over 64 characters), `may-not-delete-group` (`FORBIDDEN`, audited for a member), `delete-group-failed` |

## Internal API

### Changed: `@app/domain`

| Export | Shape |
| --- | --- |
| `GroupService.rename(actor, organizationId, groupId, name, seenName?)` | given `seenName`, renames only a group still named so (line breaks compared alike); a stale rename's `VALIDATION_FAILED` now carries `details.reason` `STALE` |
| `GroupRenameRefusal` | new: `GroupNameRefusal \| "STALE"` |

### Added: `apps/web` (`lib/groups.ts`)

| Export | Shape |
| --- | --- |
| `renameGroup(actor, organizationId, groupId, { name, from })` | the rename route's work, a notice or an error code |
| `deleteGroup(actor, organizationId, groupId)` | the delete route's work, a notice or an error code |
| `GROUP_ID_MAX_LENGTH` | 64; a longer id is answered `group-gone` unread |

Each logs a failure that is not a refusal by its error code alone.
`GROUPS_NOTICES` and `GROUPS_ERRORS` gain the codes above.

## Sequence

```mermaid
sequenceDiagram
    participant B as Browser (an OWNER or ADMIN)
    participant R as POST .../groups/{groupId}/delete
    participant S as GroupService
    participant D as Database
    B->>R: Delete group (same-origin form post)
    R->>S: delete(actor, org, groupId)
    S->>S: group.manage, then OWNER or ADMIN (refusals audited)
    S->>D: lock the group; ceiling; ungroup Properties
    D->>D: remove member rows; group.deleted, one transaction
    R-->>B: 303 groups page ?notice=group-deleted or ?error=code
```
