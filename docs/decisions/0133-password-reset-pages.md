# ADR-0133 — The password reset pages

Status: Accepted (AT-4c, 2026-11-10). Last part of the accounts-and-team
plan's AT-4, password reset, which the product owner approved on 2026-11-09
(`/mnt/project-files/cto/accounts-team-proposal.md`): "Forgot your password?"
sends a single-use link; the page answers the same whether or not the email
has an account; a reset ends every session, and MFA is still asked at the next
sign-in.
Builds on: ADR-0129 (the verify page), ADR-0131 (asking for a link), ADR-0132
(resetting with a link).

## Context

ADR-0131 and ADR-0132 built the reset in the domain and the database, and
nothing reached it. This ADR adds the page and the two routes that do, and the
link to them from the sign-in page.

---

## Decision 1 — One page, `/reset-password`, with no sign-in

The sign-in page links to it ("Forgot your password?"). Like the verify page
(ADR-0129), it is one page with its states chosen by the address:

- **No token:** a form asking for the account's email address.
- **`?token=…`:** `checkResetLink(token)`. Only a `USABLE` link shows the
  new-password form, which posts the token and the new password; it says that
  choosing one signs the account out everywhere. Any other link shows "Link
  not valid" and the form to ask for a new one, whatever the reason. Opening
  the link writes nothing, so a mail scanner that fetches it uses nothing, and
  no extra button is needed: the form needs the new password.
- **`?notice=…`:** one of `sent`, `invalid`, `too-short`, `failed` and
  `reset`, never text the address carries. `reset` says the password was
  changed and the account signed out everywhere, and links to sign in.

The page sets `Referrer-Policy: strict-origin`, as the verify page does,
because its address may hold a token.

## Decision 2 — Asking for a link answers the same, always

`POST /api/auth/reset-password/request` (form `email`) calls `requestReset`
and answers 303 to `/reset-password?notice=sent` whatever happened: an address
with an account or without, a disabled account, an address mail cannot reach,
no outbox or no `APP_BASE_URL`, or any other error (ADR-0131 Consequences). The
notice says a link was sent if an account uses the address. A failure is
logged by its error code alone, never the address, the link or the message.

The route needs no sign-in and checks no origin, like sign-in itself: it uses
no cookie, and anyone may ask for a link to any address from the page anyway.
Asking is not rate limited yet; the rate-limiting item in
`docs/decisions/TODO.md` already lists password reset.

## Decision 3 — Choosing the password

`POST /api/auth/reset-password` (form `token`, `password`) needs no sign-in:
the token is the proof. It calls `resetPassword` and answers 303 to
`/reset-password?notice=`:

| Outcome | Notice |
| --- | --- |
| `RESET` | `reset` |
| `INVALID`, for any reason and any password | `invalid` |
| `VALIDATION_FAILED` (under 10 characters); the link stays usable | `too-short` |
| Any other error, logged by its code alone; nothing is written | `failed` |

The redirect never carries the token. After `too-short` or `failed` the page
says to open the link from the email again, which still works. The form
already asks the browser for at least 10 characters, so `too-short` is rare.

The session cookie of the browser that posted is left as it is. If it was the
account's, its session is gone with the others (ADR-0132) and the next page
sends it to sign in; if it was another account's, that one stays signed in.

## Decision 4 — Wiring

The web app's email goes through one mailer, shared with email verification:
the development outbox (`EMAIL_OUTBOX_DIR`), links on `APP_BASE_URL`, and
`CONFIGURATION_ERROR` before anything is written when either is unset. Only
the reset page and the web app's reset wiring use `PasswordResetService`; the
worker never does, and a test pins it.

## Consequences

- **Password reset is reachable.** No migration, permission or audit action;
  two routes and one page.
- Production has no email service yet (ADR-0126). There, asking for a link
  answers `sent` and mails nothing, as the outbox refuses production. Choosing
  the production email service is already a pre-launch item.
- After a reset, the next sign-in asks for the MFA code of an account that has
  MFA, and sends an account whose address is not verified to the verify page,
  as before. A browser test runs the whole reset.
- The TODO item "Take back an account someone else made with your address"
  stays open: with MFA set up by the other person, the owner still needs
  operator-assisted MFA recovery (ADR-0132).
