# API Changes — MFA-2

The two-step sign-in and the routes behind the security page (ADR-0065
Decisions 12 to 14). All are session-authenticated with the `rev_session`
cookie. None takes an `organizationId`: MFA belongs to the person, not to an
organization.

## Changed

### Every session-authenticated route and page

A sign-in of a user with MFA on is **not signed in until it has passed MFA**.
Until then every route answers `401` and every page redirects to `/login`,
exactly as without a session. The sign-in page then sends it to `/login/mfa`.

### `POST /api/auth/login` (form)

Unchanged input. After a correct password it now redirects (`303`) to
`/login/mfa` when the user has MFA on, and to `/` otherwise. Either way the
session cookie is set.

## Added

### `POST /api/auth/mfa` (form) — the code step

Field `code`: a 6-digit authenticator code or a recovery code (any case, with
or without dashes). Always answers `303`:

| Outcome | Redirect |
| --- | --- |
| passed | `/` |
| wrong code | `/login/mfa?error=That code is not valid. Attempts left: N` |
| the sign-in ended (the fifth wrong code, or it is gone) | `/login?error=…`, and the cookie is cleared |
| no sign-in | `/login?error=Sign in again` |
| already signed in | `/` |
| `MFA_SECRET_KEY` not set | `/login/mfa?error=MFA is not available right now` |

### The `/api/mfa` routes

Each acts for the signed-in user and answers `Cache-Control: no-store`. Errors
use the usual envelope; a wrong code's carries `details.attemptsLeft`.

| Route | Body | Success | Refusals |
| --- | --- | --- | --- |
| `POST /api/mfa/setup` | none | `200 { "secret": "BASE32…", "qrCode": "data:image/svg+xml;base64,…" }` | — |
| `POST /api/mfa/setup/confirm` | `{ "code": "123456" }` | `200 { "recoveryCodes": ["XXXX-XXXX-XXXX-XXXX", …] }` (10, shown only here) | `422` wrong code or no set-up started |
| `POST /api/mfa/recovery-codes` | none | `200 { "recoveryCodes": […] }` (10 new ones; the old ones stop working) | `403` or `422` MFA is off |
| `POST /api/mfa/disable` | `{ "code": "123456" }` | `204` | `403` the role requires MFA; `422` wrong code; `403` or `422` MFA is off |

All four answer `401` without a signed-in user, including a sign-in that still
owes a code, and `500 CONFIGURATION_ERROR` without `MFA_SECRET_KEY`. A body
without a `code` string, or one that is not JSON, gets `422`.

Starting set-up with MFA already on moves it to a new device: the confirmation
replaces the authenticator and issues new recovery codes.

## Pages

- `/login/mfa`: the code form and sign-out, for a sign-in that owes a code.
- `/security`: MFA status and its controls; linked from the dashboard.
