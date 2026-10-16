# API Changes — MFA-3

Mandatory MFA (ADR-0065 Decisions 15 to 17). No route is added or removed and
no request body changes. What changes is who counts as signed in, where the
sign-in redirects go, and one readiness check.

Who must use MFA is unchanged from MFA-1 (Decision 7): an `OWNER` or `ADMIN` of
any organization, or a holder there of `permission.manage` or `billing.manage`
by template, individual grant or group. `BILLING` is covered through
`billing.manage`. It is read from current memberships on every request.

## Changed

### Every session-authenticated route and page

A sign-in of a user who must use MFA and has not set it up is **not signed in**.
Until it has, every route answers `401` and every page redirects to `/login`,
exactly as without a session. The sign-in page then sends it to `/security`.

This applies to sessions that already existed before the deploy, from their
next request. A grant that makes MFA mandatory applies the same way.

### `POST /api/auth/login` (form)

Unchanged input. After a correct password it redirects (`303`) to:

| The user | Redirect |
| --- | --- |
| has MFA on | `/login/mfa` |
| must use MFA and has not set it up | `/security` (new) |
| anyone else | `/` |

### `POST /api/auth/mfa` (form) — the code step

A sign-in that must set MFA up, and so owes no code, is redirected to
`/security` without a code being checked. Every other outcome is as in MFA-2.

### `POST /api/mfa/setup` and `POST /api/mfa/setup/confirm`

Also serve a sign-in that must set MFA up, so it can do so. Responses are as in
MFA-2. Once the confirmation succeeds, that sign-in is signed in.

### `POST /api/mfa/recovery-codes` and `POST /api/mfa/disable`

Unchanged: signed-in users only, so a sign-in that must set MFA up gets `401`.

### `GET /api/health/ready` (operator bearer token)

Gains an `mfa` check:

```json
{ "name": "mfa", "ok": true, "detail": "key set" }
{ "name": "mfa", "ok": false, "detail": "MFA_SECRET_KEY not set" }
```

Without the key the probe reports `"status": "degraded"` and answers `503`. It
reports only whether the key is set.

## Pages

- `/login` and `/login/mfa` send a sign-in that must set MFA up to `/security`.
- `/security`, for such a sign-in, says the role requires MFA and offers set-up
  and sign-out only, with no link back to the dashboard. Once the recovery codes
  are saved it goes on to `/`. It sends a sign-in that owes a code to
  `/login/mfa`.
