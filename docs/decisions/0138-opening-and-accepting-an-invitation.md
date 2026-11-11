# ADR-0138 — Opening and accepting an invitation in the web app

Status: Accepted (AT-7b, 2026-11-11). Fourth part of stage B, the team, of
the accounts-and-team plan, which the product owner approved on 2026-11-09
(`/mnt/project-files/cto/accounts-team-proposal.md`): "The emailed link leads
the person to sign in, or to create an account with the invited email. Once
that email is verified, they join with the invited role." Its end-to-end
story: "owner invites a colleague → colleague opens the emailed link, creates
an account, verifies the email → joins with the role they were given".
Builds on: ADR-0065 (MFA, and a sign-in's steps), ADR-0068 (same-origin form
posts), ADR-0129 (the verify page, and a sign-in that waits on it), ADR-0133
(a page opened from an emailed link), ADR-0136 (the invitation email and its
link), ADR-0137 (the acceptance rules).

## Context

AT-6b mails the invitation with a link to `/accept-invitation?token=…` on
`APP_BASE_URL`, and AT-7a built the rules that decide an acceptance, with no
caller. The person who opens the link is often not signed in, and often has
no account: before they can accept they create one, verify its address from a
second email, and may give an MFA code or set MFA up. Each of those steps ends
on its own page, and the organizations page (`/`) is where every one of them
lands once the sign-in is complete (`nextPageFor`, ADR-0129).

---

## Decision 1 — The link's page shows the offer and asks for one press

`/accept-invitation?token=…` reads the invitation and writes nothing, as the
verify and reset pages do (ADR-0129, ADR-0133), so a mail scanner that fetches
the link changes nothing: an expired invitation is not even marked. Its
referrer policy is `strict-origin`.

While the token names an open invitation, the page says what it offers:
"You are invited to join {organization} on VTaVision as {a Creator}", with the
organization's name as the invitation email quotes it
(`MembershipService.describeInvitation`). The token is the key, as the email
is, and the email already said as much, so no sign-in is asked. The page never
shows the invited address or who invited: a link that reached someone else
does not tell them where it was sent. Any other token (unknown, accepted,
cancelled, expired, empty, longer than 128 characters or given twice) shows
"Link not valid" and no button.

One button posts the token to `POST /api/invitations/accept`. To a complete
sign-in it reads **Accept invitation**, beside the account's own address, a
**Not now** and a **Sign out**; to anyone else it reads **Continue**, under
"Sign in, or create an account, with the email address this invitation was
sent to."

## Decision 2 — The invitation waits in the browser through the sign-in

A post that is not from a complete sign-in keeps the token in a cookie,
`rev_invitation`, and goes on to `/login`, which sends a sign-in that owes a
step (the MFA code, the verify page or MFA set-up) on to it, as it always
does. Neither the page nor the route reads a sign-in that is not complete
(the boundary of ADR-0065 and ADR-0129 is unchanged). The cookie is `HttpOnly`,
`SameSite=Lax`, `Secure` in production, on `/`, for 24 hours: as long as a
verification link works (ADR-0128), the longest step in between. It is set
only by that post, never by opening the link, and the token goes in no
address after the link's own.

While an open invitation waits:

- The sign-in page says "To join {organization}, sign in or create an account
  with the email address your invitation was sent to."
- The organizations page sends a complete sign-in to `/accept-invitation`,
  which shows the waiting invitation with **Accept invitation**. So the
  invitation comes back after a password, an MFA code, a verification or MFA
  set-up alike, with no change to any of their routes.

A waiting invitation that is no longer open is ignored, and the cookie
expires. A verification link opened in another browser verifies the address,
but the invitation waits only where it was opened: there, or after opening the
emailed link again, the person accepts. Signing out does not end the wait, so
a person signed in with the wrong account can sign in with the invited one.

On a shared computer, the next person to sign in within the day is shown the
waiting invitation's organization and role. They cannot accept it (ADR-0137),
and **Not now** ends the wait.

## Decision 3 — Accepting, and what the answer says

`POST /api/invitations/accept` is a same-origin form post (ADR-0068),
refused with `403` otherwise. It takes the form's token, else the waiting one;
a token of no characters or more than 128 is answered as invalid, unread.
For a complete sign-in, `MembershipService.acceptInvitation` decides
(ADR-0137):

- Joined: the organizations page, with `?joined={organizationId}`, says "You
  joined {organization} as {ROLE}." (only for an organization the account is
  in). If the organization or the role requires MFA and the account has none,
  the sign-in now owes MFA set-up and goes there first (ADR-0065).
- Refused: `/accept-invitation?error={code}`, which shows the code's fixed
  sentence and nothing for any other value. None names the invited address.

| Code | Refusal | Waits |
| --- | --- | --- |
| `invalid` | no open invitation (`NOT_FOUND`), or a token unread | no |
| `expired` | `EXPIRED` | no |
| `wrong-account` | `WRONG_ACCOUNT` | yes |
| `unverified` | `EMAIL_NOT_VERIFIED` | yes |
| `already-member` | `ALREADY_MEMBER` | no |
| `withdrawn` | `FORBIDDEN`: the inviter may no longer give the role | no |
| `no-plan` | `NO_PLAN` | no |
| `no-seat` | `NO_SEAT` | no |
| `failed` | anything else, logged by its error code alone | yes |

The invitation keeps waiting only while this browser can still accept it: by
signing in with the invited address, verifying it, or trying again. A
refusal for no plan or no seat leaves the invitation pending; its sentence
says to open the emailed link again once there is a seat.

**Not now** (`POST /api/invitations/dismiss`, same-origin) ends the wait and
opens the organizations page. The invitation stays pending, and the emailed
link still opens it.

## Consequences

- No migration, permission or audit action. The acceptance is audited as
  ADR-0137 says; opening, waiting and putting aside write nothing.
- `MembershipService.describeInvitation(token)` is new: the organization's name
  as the email quotes it, the role and its wording, or `null`.
- `acceptInvitation` now has one caller, the web app's `lib/invitations.ts`,
  called by the accept route; the dormancy test says so. Role change and
  removal still have none (AT-8).
- Neither route sends mail, so neither needs a limit before production's
  email service, unlike inviting (`TODO.md`).
