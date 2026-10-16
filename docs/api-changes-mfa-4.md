# API Changes — MFA-4

An organization may require MFA of all its members (ADR-0065 Decisions 18 and
19). One route is added. No other route, request body or response changes.

## Added

### `POST /api/organizations/{organizationId}/mfa-requirement` (form)

Require MFA of every member of the organization, or stop requiring it.

| Field | Value |
| --- | --- |
| `required` | `true` or `false` |

Signed-in users only. Every outcome is a `303` redirect:

| Case | Redirect |
| --- | --- |
| not signed in, or the sign-in has not passed MFA | `/login` |
| changed, or already as asked | `/` |
| `required` is neither `true` nor `false` | `/?error=Choose whether to require MFA` |
| not a member of the organization, or no such organization | `/?error=You do not have access to this organization` |
| a member who is not an `OWNER` or `ADMIN` | `/?error=Role <ROLE> may not change whether MFA is required` |
| the value or the actor's role changed meanwhile | `/?error=The MFA requirement or your role changed meanwhile; reload and try again` |
| anything else | `/?error=Could not change the MFA requirement` |

It goes by role: an `organization.manage` grant does not let anyone else
change it. A change is written together with its audit entry,
`organization.mfa_requirement_changed`; a member's refused attempt is audited as
`organization.mfa_requirement_refused`. Both record the actor's role and the
value asked for. A request that would change nothing writes nothing.

## Changed

### Every session-authenticated route and page

Who must use MFA (ADR-0065 Decision 7) now also includes every member of an
organization that requires it. Such a member without MFA is handled exactly as
in MFA-3: signed in nowhere until set-up, from their next request. While the
requirement holds, `POST /api/mfa/disable` refuses them with
`Your role or organization requires MFA, so it cannot be turned off` (`403`),
which before read `Your role requires MFA, ...`.

## Pages

- `/` (the dashboard) says under each organization whether every member must
  use MFA. An `OWNER` or `ADMIN` also gets a button that posts the opposite
  value to the route above.
- `/security` says "Your role or organization requires" where it said "Your
  role requires".
