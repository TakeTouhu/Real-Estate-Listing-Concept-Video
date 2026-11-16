# API Changes — AT-11b

Giving and taking back a member's individual permissions on their
permissions page (ADR-0147). **No migration, permission or audit action.**
Two form posts; the page gains their buttons.

## HTTP

### Added

| Route | Who | Does |
| --- | --- | --- |
| `POST /api/organizations/{organizationId}/members/{userId}/permissions/grant` | a member holding `permission.manage`, within the grant ceiling | Form field `permission`. `PermissionGrantService.grant`: gives the member the permission individually and audits `permission.granted` with it; one held individually already writes nothing. `303` to the member's permissions page with `notice=granted`, or `error=permission` (not a permission, or `disclosure.none`; the service is not asked), `may-not-grant` (refused and audited as `permission.grant_refused`) or `grant-failed`. Not a member, or a `userId` over 64 characters: `303` to the members page with `error=not-a-member`. Another origin: `403`, nothing read. Signed out: `303` to `/login` |
| `POST /api/organizations/{organizationId}/members/{userId}/permissions/revoke` | as above | Form field `permission`. `PermissionGrantService.revoke`: takes back the member's individual grant and audits `permission.revoked`. `303` to the member's permissions page with `notice=revoked`, or `error=permission` (not a permission), `may-not-revoke` (refused and audited), `not-granted` (no such grant, or no such member) or `revoke-failed`. A `userId` over 64 characters: the members page with `error=not-a-member`. Origin and sign-in as above |

### Changed

| Route | Change |
| --- | --- |
| `GET /organizations/{organizationId}/members/{userId}/permissions` | A viewer the ceiling allows sees "Give" on each permission the member cannot use now (never `disclosure.none`), and "Take back" on each one they hold individually, with a paragraph on what giving does. Giving `permission.manage` or `billing.manage` says whoever holds it must use two-step sign-in. Shows the `notice` or `error` a route sent back, and nothing for any other code |

## Domain

| Export | What |
| --- | --- |
| `MemberPermission.mayGrant`, `MemberPermission.mayRevoke` | Whether the viewer may give the member the permission individually (no such grant yet), or take back their grant of it, as `PermissionGrantService` decides (`permission.manage`, `grantRefusal`) |

### Sequence

```mermaid
sequenceDiagram
  actor V as Viewer
  participant W as Permissions page
  participant R as Grant or revoke route
  participant S as PermissionGrantService
  participant D as Database
  V->>W: GET .../members/{userId}/permissions
  W-->>V: rows with Give and Take back where allowed
  V->>R: POST .../permissions/grant (permission)
  alt another origin
    R-->>V: 403
  else not a permission, disclosure.none, or id over 64
    R-->>V: 303 page, error=permission (members page for the id)
  else
    R->>S: grant(viewer, organization, member, permission)
    S->>D: viewer's membership and permissions; member's membership
    alt refused by permission.manage or the ceiling
      S->>D: audit permission.grant_refused
      S-->>R: FORBIDDEN
      R-->>V: 303 page, error=may-not-grant
    else allowed
      S->>D: grant and permission.granted, in one transaction
      R-->>V: 303 page, notice=granted
    end
  end
```
