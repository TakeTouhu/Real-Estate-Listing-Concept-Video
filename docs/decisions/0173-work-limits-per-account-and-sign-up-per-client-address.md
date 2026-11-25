# ADR-0173 — Work limits per account, and sign-up per client address

Status: Accepted (RD-8a, 2026-11-25). The first part of the eighth
milestone of production readiness, part 1, which the product owner
approved on 2026-11-16
(`/mnt/project-files/cto/production-readiness-proposal.md`, design item
5). It decides how all of RD-8 limits signed-in work and sign-up. RD-8a
builds the sign-up limit (Decision 2) and the failure text of sign-in,
its code step and sign-up (Decision 9); every other decision names the
later RD-8 pull request that builds it, and nothing here says it is
built before then.

Builds on: ADR-0169 (the rule; count first; a limiter that fails
refuses), ADR-0170 (the settings, the client address and the subjects),
ADR-0171 (the limiter, its keys in order, refusals logged by code),
ADR-0172 (the emails), ADR-0054 Decision 5 (dimensions that "may
include" account, organization, IP and action). Amends ADR-0171
Decision 6 (Decision 6 here).

## Context

The approved plan limits invitations, uploads, analysis, generation
start, downloads and Unit purchase "by account, organization, IP and
action", at documented, configurable values, and refuses a limited
request before any Unit is reserved or any provider is called. Nothing
limits them today, and sign-up is limited only through its verification
email (`TODO.md`, "Open in RD-7e"). Five reports in
`/mnt/project-files/cto/rd-8/` read the routes and the values and
checked each other; `decision.md` there records the CTO's choices, all
as the critic recommended (`critic.md` §2 and §5.1).

## Decision 1 — Signed-in work is limited per account only

Each signed-in action is counted by one key: the signed-in account's
(`user` subject family). RD-8 adds no organization key and no
invited-address key:

- **An organization key lets one member hold the organization.** Every
  proposed pair had an hourly account value whose day exceeds the daily
  organization value, so one member, a buggy client or a stolen session
  alone would fill the tenant's key in 3 to 10 hours (critic R1).
- **It does not bound an attacker.** Any signed-in account may create
  organizations without limit, and one without a plan may create
  Properties and upload; each brings a fresh organization budget. Only
  the account key follows the attacker (critic R2).
- **An invited-address key gives a stranger a lever and a signal.** Any
  account could fill a real organization's key for a named person, and a
  refusal would tell an inviter that someone else invited that address
  (critic R4).

The product owner has been asked whether per account only is acceptable
(PO-1); work goes on per account meanwhile. An organization key can be
added later as a setting and a policy, without undoing anything here.
No signed-in action is limited in RD-8a; each is built by the PR that
Decision 4 names.

## Decision 2 — Sign-up is counted per client address, first

`POST /api/auth/register` hits `sign-up.client`, the request's client
address's key, before its form is read, before any account is looked
up and before any password is hashed. A request with no client address,
as with `FORWARDED_FOR_TRUSTED_ENTRIES` unset, is not counted at all
(ADR-0170 Decision 4): sign-up has no other key, so that means no limit,
not one key fewer. A refusal answers 303 to `/login?error=` with "Too
many sign-ups. Try again in N minutes." and makes no account, sign-in
or email. **Built in RD-8a.**

## Decision 3 — Plain windows; every admitted request counts

No RD-8 policy has a cooldown: nothing here guesses a secret, so each
key waits for its window to end. Every request that reaches the hit is
counted, a failed one included (a refused one leaves its window as it
is), and nothing gives a hit back: no success, no error of ours. Each
policy has one key, so the limiter's give-back of earlier keys (ADR-0171
Decision 7) never applies. Sign-up's policy follows this from RD-8a;
each other, from its PR.

## Decision 4 — Where the hit sits

In the route, before the service, after the cheap checks of shape and
session, so no Unit, provider call, signed link or email follows a
refusal. The services stay the authority on permission.

| Route | Policy | Hit | PR |
| --- | --- | --- | --- |
| `POST /api/auth/register` | `sign-up.client` | first, before the form | 8a |
| `POST .../invitations` | `invitation.user` | after session and form | 8c |
| `upload-url`, `retry`, `complete` | `upload.user` | after body check | 8b |
| `.../analysis`, `.../analysis/refresh` | `analysis.user` | before the service | 8d |
| `POST .../generations` | `generation-start.user` | after the 404 check | 8f |
| video `download`, photo `download-url` | `download.user` | in the routes | 8e |
| `POST .../unit-purchases` | `unit-purchase.user` | after the form | 8g |

The start route hits only after its 404 outside development, so a
production build neither reveals it nor counts. Unit purchase is counted
before authorization, so a member's refused and audited attempts are
bounded too. The download hit never moves into `createDownloadUrl`.

## Decision 5 — The settings and their values

Seven settings, each `count/seconds` as ADR-0170 reads them, each with
the CTO's documented default, changeable by setting; the product owner
is told (PO-6). Each PR adds only the setting and policy it reads.

| Setting | Default | PR |
| --- | --- | --- |
| `RATE_LIMIT_SIGN_UP_PER_IP` | `60/3600` | 8a |
| `RATE_LIMIT_UPLOAD` | `1000/86400` | 8b |
| `RATE_LIMIT_INVITATION` | `50/86400` | 8c |
| `RATE_LIMIT_ANALYSIS` | `300/3600` | 8d |
| `RATE_LIMIT_DOWNLOAD` | `60/3600` | 8e |
| `RATE_LIMIT_GENERATION_START` | `30/3600` | 8f |
| `RATE_LIMIT_UNIT_PURCHASE` | `10/3600` | 8g |

Sign-up's 60, not 30: failed sign-ups count too, and the largest
included team is 30. Uploads are daily, so stored volume per account is
bounded by the day, about 12 GiB at 25 MiB a photo. No migration: the
table's CHECK takes each name.

## Decision 6 — Signed-in routes count on a second limiter client

This amends ADR-0171 Decision 6, which names one client. Signed-in
routes hit on a limiter client of their own, of 3 connections, chosen
by `WebRateLimits` per method, so an anonymous flood that holds the
first client's connections on sign-in, sign-up or reset cannot make
uploads, starts, downloads or purchases wait and fail closed. Sign-up
stays on the first client. A signed-in flood can still hold the second.
**Built in RD-8b.**

## Decision 7 — The answers

- **JSON routes** answer 429 with `Retry-After` in whole seconds,
  `Cache-Control: no-store` and the existing error envelope, whose
  `details` holds `retryAfterSeconds` alone. `appErrorToResponse` sets
  them, and a guard keeps `rate-limit.ts` the only maker of
  `RATE_LIMITED`. **Built in RD-8b.**
- **Forms** answer a 303 back, as ADR-0171 Decision 3 does, never with
  `Retry-After`: pages that show only fixed codes (members, a project's
  download) get `limited` plus `retry=N` in minutes, as ADR-0172
  Decision 2 does; free-text pages (generation start, Unit purchase,
  sign-up) get the sentence. Sign-up's from RD-8a; each other form's
  with the PR that limits it.
- **Texts** name no key, subject or value: "Too many sign-ups.", "Too
  many invitations.", "Too many uploads.", "Too many analysis
  requests.", "Too many downloads.", "Too many video starts. Nothing new
  was started.", "Too many purchase approvals. Nothing new was bought.",
  each followed by the wait.

## Decision 8 — Waits above 120 minutes read in hours, for RD-8 only

For the RD-8 actions, sign-up included, a wait above 120 minutes reads
in whole hours, rounded up ("Try again in 23 hours."). The RD-7 texts
keep minutes, as ADR-0171 Decision 3 and ADR-0172 Decision 2 fix them.
**Built in RD-8b**; until then sign-up reads in minutes, and its default
wait is at most 60.

## Decision 9 — A limiter that fails refuses, in the route's own words

A limiter error ends the request in the route's own failure answer,
never the limiter's own text: "Registration failed" for sign-up, a JSON
route's 500 envelope, the members page's `unavailable`, a project's
`download=failed`, the start and purchase pages' default failure text.
On the start, purchase and video download routes the hit is in a `try`
of its own, since they rethrow other errors. Paid work stops while the
limiter cannot answer (PO-4); no Unit is reserved, no charge is made and
no reservation is stranded, as the hit precedes every service. Sign-in
and its code step show an `AppError`'s text, so their limiter calls are
wrapped and a limiter error reaches them as a plain error, as ADR-0171
Decision 8 intends; sign-up's hit has a `try` of its own that answers
"Registration failed". **Built in RD-8a for sign-in, its code step and
sign-up**; each other route with the PR that limits it.

## Decision 10 — Not limited

- `POST /api/mfa/disable`: ADR-0171 Decision 4 stands.
- The token routes `PUT /api/storage/upload` and
  `GET /api/storage/download`, page renders that sign thumbnails or the
  video preview, invitation cancel, `POST /api/mfa/recovery-codes` and
  the storyboard route: none reserves a Unit, calls a provider or sends
  an email. Page renders still sign and audit a link per photo, without
  limit. `TODO.md` records what they leave open, from RD-8b to RD-8g.
- Organization and Property creation; whether an organization without a
  plan may upload is the product owner's (PO-2).

## Considered and not done

- **An organization key beside the account's.** Decision 1.
- **A cooldown on any RD-8 policy.** Decision 3.
- **Give a hit back on success, or on our own error.** The values leave
  room; ADR-0169 Decision 3 is kept.
- **A separate ADR for the start and purchase values.** The product
  owner approved them as documented and configurable; they are told.
- **A hit inside a service.** It would follow a reservation or a link.

## What was measured

`tests/api/email-verification-routes.test.ts` counts every sign-up from
one client address, a failed one included, refuses the next with its
wait before its form is read, making no account, sign-in or email,
counts another address on its own and lets the window's end through;
counts nothing with no client address; and answers "Registration
failed", making no account, when the limiter fails with an error or an
`AppError`. `tests/api/mfa-routes.test.ts` answers "Sign in failed",
never the limiter's text, when a hit or a forget fails with an
`AppError`. `rate-limit.test.ts` records that sign-up hits only the
client address's key and nothing without one, and that its refusal is
logged as `SIGN_UP`, `client`. A test failed for each change that undid
a part: no sign-up key, the limiter's text shown, the hit after the
form.

## Consequences

- `RATE_LIMIT_SIGN_UP_PER_IP` and `sign-up.client` exist; sign-up costs
  one statement more where a client address is configured, and none
  otherwise.
- The browser test is unaffected: it runs no client address.
- Each later PR adds one setting and policy, and the comments that list
  the settings and policies name no count.
- For the product owner: PO-1 (per account only) is asked; PO-2 (an
  organization without a plan may upload today), PO-3 (enforce the
  storage quota before production uploads), PO-4 (fail closed on paid
  work) and PO-5 (a day's wait past a daily limit) are told. The sign-up
  answer "Email is already registered" stays theirs (`TODO.md`).
