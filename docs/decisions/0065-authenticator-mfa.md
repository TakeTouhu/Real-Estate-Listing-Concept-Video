# ADR-0065 — Authenticator-app MFA and recovery codes

Status: Accepted. MFA-1 built the foundation (Decisions 1 to 11). MFA-2 adds
the screens and the two-step sign-in (Decisions 12 to 14, superseding
Decision 10). MFA-3 makes MFA mandatory (Decisions 15 to 17). MFA-4 adds the
organization-wide requirement (Decisions 18 and 19).
Implements: ADR-0052 Decision 18:
- *authenticator-app (TOTP) MFA, recovery codes*;
- *MFA is mandatory for `OWNER`, `ADMIN`, any user with `permission.manage`, and
  any user with `billing.manage`. Other users may enable it optionally*;
- *MFA changes, recovery-related changes and security-sensitive identity events
  must be auditable*.

And `docs/SecurityCompliance.md`: the rule is capability-based, so it follows a
grant wherever it comes from, and `BILLING` is mandatory through
`billing.manage`. ADR-0052 Decision 10 adds no step-up mechanism.

Approved by the product owner on 2026-10-15 as four pull requests with no grace
period (`/mnt/project-files/cto/mfa-proposal.md`).

## Context

Phase 6 built every authorization piece ADR-0052 Decision 10 asks for (6C to
6I). None has a screen yet, and the Roadmap requires MFA before the first
member, permission, group or assignment screen ships. Nothing about MFA existed:
no table, no service, no screen.

Every route and page that needs a signed-in user goes through one function,
`getCurrentUser()` → `AuthService.resolveSession()`. Enforcing MFA there
(MFA-3) covers all of them at once. This ADR builds what that enforcement will
read.

---

## Decision 1 — MFA belongs to the session

A sign-in passes MFA once. `sessions` gains:

| Column | Meaning |
| --- | --- |
| `mfaVerifiedAt` | when this sign-in passed MFA; null until then |
| `mfaFailedAttempts` | wrong codes entered in this sign-in |
| `mfaPendingSecret` | the sealed secret of an authenticator set-up started in this sign-in |

A new session starts with none passed, so every existing session reads as not
having passed MFA. Nothing reads that before MFA-2.

A set-up belongs to the sign-in that started it: it is finished in that session
or not at all, and it ends with the session.

## Decision 2 — The factor and its recovery codes

- **`user_mfa_factors`**, one row per user, exists exactly while MFA is on. It
  holds the sealed secret, the step of the last code accepted
  (`lastUsedStep`) and when the factor was set up.
- **`user_mfa_recovery_codes`** holds the unused codes, keyed by user and hash.
  Using a code deletes it. Its foreign key is to the factor, so turning MFA off
  deletes them all; the factor's is to the user. A `CHECK` admits only a
  64-character hex hash, so a code as typed can never be stored.

## Decision 3 — TOTP

RFC 6238 with the setting every authenticator app supports: HMAC-SHA-1, 6
digits, 30-second steps, a 160-bit secret. Written with Node's `crypto`, with no
new dependency, and checked against the RFC 4226 and RFC 6238 test values.

- A code is accepted for the current step or one step either side, for clock
  drift.
- **Each code works once.** A code is accepted only for a step later than
  `lastUsedStep`, and the factor is updated only where `lastUsedStep` is still
  lower, so two concurrent requests with one code accept it once.
- **A code counts only for the authenticator it was checked against.** The same
  update, and the delete that turns MFA off, also match the sealed secret the
  code was checked against. If another sign-in moved MFA to a new device in
  between, the old authenticator's code is refused.
- Set-up returns the secret in base32 and an `otpauth://` URI naming the issuer
  `VTaVision` and the user's email, for a QR code (MFA-2 draws it).

## Decision 4 — The secret is sealed

The secret is stored as `<key id>.<payload>`: AES-256-GCM under a new server
secret, `MFA_SECRET_KEY` (32 bytes as 64 hex characters), with a random 12-byte
IV and the user id as associated data. It therefore opens only for its own user,
and a secret sealed under another key says so instead of failing as tampering.
The key id is the first 12 hex characters of the key's SHA-256.

`MFA_SECRET_KEY` is optional in the environment schema while no route uses it;
MFA-2 makes it required. *MFA-2: it stays optional in the schema, and the web
app fails closed without it (Decision 14).* Rotating the key (re-sealing every secret) is not
built; a changed key makes existing set-ups unusable.

## Decision 5 — Recovery codes

10 codes of 16 characters each, 80 random bits, in Crockford base32 and written
`XXXX-XXXX-XXXX-XXXX`. They are read back however they are typed: any case,
with or without dashes and spaces, `O` as `0` and `I` or `L` as `1`. Only the
SHA-256 of the normalized code is stored; 80 random bits need no slow hash.

They are shown once, when set-up finishes and when a new set is made. A new set
replaces the old one whole.

## Decision 6 — What the service does

`MfaService` acts for the user of the session it is given:

| Method | What it does | Who may |
| --- | --- | --- |
| `status` | MFA on, MFA mandatory, recovery codes left | the user |
| `beginSetup` | a new secret, kept sealed on the session | anyone with MFA off; with MFA on, only a session that passed it (moving to a new device) |
| `confirmSetup` | the first code turns MFA on, or moves it to the new device; a new set of recovery codes; the session passes | the session that began it |
| `verify` | an authenticator code or a recovery code; the session passes | any session of a user with MFA on |
| `regenerateRecoveryCodes` | a new set | a session that passed MFA |
| `disable` | MFA off, with a current authenticator code | a session that passed MFA, of a user who need not use it |

**Moving to a new device.** A session that passed MFA may set it up again; the
new authenticator replaces the old one, and the old authenticator's codes and
the old recovery codes stop working. Without this, a person who must use MFA
and changes phone could neither turn it off nor set it up again.

A set-up started in a session that has not passed MFA can never replace a
factor: if MFA was turned on in another session meanwhile, finishing it is
refused (`STALE`), inside the same transaction that would write it.

**The session is read again where it authorizes.** The service first checks the
session it was given. A new set of recovery codes and turning MFA off then lock
the stored session row and require it, inside the transaction that writes the
change, to still exist, to be the user's and to have passed MFA. (Finishing a
set-up that replaces the factor already requires the stored session to have
passed it.) A sign-in that ended after the caller read it, by signing out or by
a lock-out, changes nothing and is asked to sign in again.

Wrong codes while setting up are not counted: the person setting up already
holds the secret, so guessing gains nothing.

## Decision 7 — Who must use MFA

`isMfaRequired(userId)` reads the user's memberships on every call. It is true
when, in any organization, the user is an `OWNER` or `ADMIN`, or holds
`permission.manage` or `billing.manage` effectively: by template, individual
grant or group. A grant made today applies on the next call; no session is
rewritten.

In MFA-1 it decides only whether MFA may be turned off. MFA-3 uses it to refuse
every other route to a session that must pass MFA and has not (Decision 15).
MFA-4 adds a third reason: membership of an organization that requires MFA of
all its members (Decision 18).

The `OWNER` and `ADMIN` clause repeats what both templates grant today
(`permission.manage`). It is kept so the rule still names the roles ADR-0052
names if a template changes.

## Decision 8 — Five wrong codes end the sign-in

A wrong code, a code already used, or a recovery code already used counts
against the session. The fifth deletes the session and records
`mfa.challenge_locked`; the person signs in again with their password. A code
accepted resets the count. The counter is one atomic `UPDATE … RETURNING`, so
concurrent wrong codes are counted exactly and the session ends once.

This is a local guard, not the rate limiter ADR-0054 Decision 5 asks for, which
stays its own milestone.

## Decision 9 — Each change commits with its audit entry

Every write is one transaction with its audit row, or nothing:

| Action | Resource | Metadata |
| --- | --- | --- |
| `mfa.enabled` | user | `recoveryCodes: 10` |
| `mfa.replaced` | user | `recoveryCodes: 10` |
| `mfa.challenge_passed` | session | `method` (`authenticator` or `recovery_code`), `recoveryCodesLeft` for a recovery code |
| `mfa.challenge_locked` | session | `failedCodes: 5` |
| `mfa.recovery_codes_regenerated` | user | `recoveryCodes: 10` |
| `mfa.disabled` | user | none |

MFA belongs to the person, so these entries name no organization, as
`user.logged_in` does not. No secret, code or hash is ever written.

Each transaction locks the session row before the factor row, so no two MFA
changes wait on each other in opposite orders. Using a recovery code locks the
factor, so concurrent uses report exactly how many codes are left.

## Decision 10 — Nothing calls it yet (MFA-1; superseded by Decision 12)

No route, page or worker calls `MfaService` or reads `MFA_SECRET_KEY`, and
`AuthService` does not consult MFA. A shape test keeps it so until MFA-2.

## Decision 11 — Choices ADR-0052 does not make

Recorded in `docs/decisions/TODO.md` for confirmation, as proposed and approved
on 2026-10-15:

1. MFA is checked **once per sign-in**; there is no re-prompt later in it.
2. **No grace period** once MFA is mandatory (MFA-3).
3. A grant to someone without MFA is **allowed**; MFA is required from their
   next request (MFA-3).
4. Mandatory in **any** organization means MFA for **every** sign-in.
5. **5 wrong codes** end a sign-in; **10 recovery codes of 16 characters**.
6. The organization-wide requirement (MFA-4) is changed by an `OWNER` or `ADMIN`.

And two this ADR adds:

7. A session that passed MFA may **move it to a new authenticator**, and that
   issues a new set of recovery codes.
8. MFA is turned off with a **current authenticator code**, not a recovery
   code. Someone who lost their device signs in with a recovery code and sets
   up the new device instead.

## Decision 12 — Signing in takes a code once MFA is on (MFA-2)

`mfaSignInStep` says how far a sign-in has got: `SIGNED_IN` when the session
passed MFA or the user has no factor, otherwise `CODE_REQUIRED`.

- **One gate.** `getCurrentUser()`, through which every route and page gets its
  user, returns one only for `SIGNED_IN`. A sign-in that owes a code is not
  signed in anywhere. Only the sign-in page, the code page and the code route
  read it, through `getSignIn()` (MFA-3 adds MFA set-up, Decision 16).
- **Signing in.** After the password, a user with MFA on is sent to
  `/login/mfa`. Opening `/login` with such a sign-in goes there too.
- **The code step** (`POST /api/auth/mfa`) takes an authenticator code or a
  recovery code (`MfaService.verify`).
  - A wrong code goes back to the code page with the attempts left.
  - When the sign-in ends (the fifth wrong code, or it is gone), its cookie is
    cleared and the person goes back to the password.
- **Other sessions.** Once MFA is on, the user's other sign-ins that have not
  passed it are asked for a code at their next request. A sign-in that has
  passed MFA stays signed in when MFA is moved or turned off elsewhere.
- **`AuthService` is unchanged.** The step is applied in the web app's session
  gate. A shape test pins that only `lib/auth.ts` resolves a session and which
  files call `getSignIn()`.

## Decision 13 — The security page and its routes (MFA-2)

`/security`, linked from the dashboard, shows whether MFA is on and how many
recovery codes are left, and offers:
- setting it up: a QR code and the key, then a first code, then the recovery
  codes, shown once;
- new recovery codes;
- moving to a new device, through the same set-up;
- turning it off with a current code, offered only to someone who need not use
  MFA.

| Route | Body | Success |
| --- | --- | --- |
| `POST /api/mfa/setup` | none | `200 { secret, qrCode }` |
| `POST /api/mfa/setup/confirm` | `{ code }` | `200 { recoveryCodes }` |
| `POST /api/mfa/recovery-codes` | none | `200 { recoveryCodes }` |
| `POST /api/mfa/disable` | `{ code }` | `204` |

Each route acts for the signed-in user only, so a sign-in that owes a code gets
`401`. Every response carries `Cache-Control: no-store`. Errors use the usual
envelope, and a wrong code's carries `details.attemptsLeft`.

The QR code is an SVG drawn on the server with `qrcode` 1.5.4 and sent as a data
URL, so the browser runs no QR library. The `otpauth://` URI is not sent
separately.

## Decision 14 — Without `MFA_SECRET_KEY`, MFA fails closed (MFA-2)

Decision 4 planned to make the key required in MFA-2. The environment schema is
shared with the worker, which never needs the key, so it stays optional there.
The web app refuses without it instead:
- `getMfaService()` throws `CONFIGURATION_ERROR`;
- the security page says MFA is not available, and the MFA routes answer `500`;
- no code is checked, so someone with MFA on cannot finish signing in.

Nothing falls back to the password alone. Users without MFA sign in as before.

## Decision 15 — Someone who must use MFA sets it up first (MFA-3)

`mfaSignInStep` gains a third step, `SETUP_REQUIRED`: the user has no factor
and `isMfaRequired` (Decision 7) is true. A user with a factor is decided as in
Decision 12, by whether this sign-in has passed MFA.

- **Read on every request.** The step is worked out from current memberships,
  so a grant applies from the user's next request and no session is rewritten
  (Decision 11, choice 3). There is no grace period (choice 2): every existing
  `OWNER`, `ADMIN`, `BILLING` and holder of `permission.manage` or
  `billing.manage` without MFA sets it up at their next request.
- **A sign-in that passed MFA before** and has since turned it off is asked to
  set it up again once a grant makes it mandatory. Passing MFA counts only
  while there is a factor.
- **Not signed in.** `getCurrentUser()` returns no user for `SETUP_REQUIRED`, as
  for `CODE_REQUIRED`. Every route answers `401`, and every page sends the
  person to `/login`, which forwards them to `/security`.
- **After the password**, such a user goes straight to `/security`.
  `nextPageFor(step)` in `lib/auth.ts` names the page for each step
  (`/login/mfa`, `/security` or `/`). The login route, `/login`, `/login/mfa`
  and the code route all use it.
- **Once set-up is confirmed**, the sign-in that did it has passed MFA
  (Decision 6) and is signed in. The page goes on to `/` once the recovery
  codes are saved.
- **Creating an organization** makes its creator an `OWNER`, so the next page
  after creating one is MFA set-up.

## Decision 16 — What a sign-in that must set MFA up can reach (MFA-3)

- `/security`, in a set-up-first form: it says the role (since MFA-4, the role
  or an organization) requires MFA and offers set-up and sign-out, with no link
  back to the dashboard.
- `POST /api/mfa/setup` and `POST /api/mfa/setup/confirm`. `mfaRoute` serves
  `SETUP_REQUIRED` only when a route passes `{ duringSetup: true }`, and only
  these two do.
- `POST /api/auth/logout`.

`POST /api/mfa/recovery-codes` and `/disable` stay for signed-in users only.
The code route sends such a sign-in to `/security` without checking a code, and
`/login/mfa` does the same. A shape test pins which files read a sign-in that has
not passed MFA, and which routes pass `duringSetup`.

## Decision 17 — The readiness probe reports the MFA key (MFA-3)

Since MFA-3, without `MFA_SECRET_KEY` no one who must use MFA can sign in, every
`OWNER` included (Decision 14). The authenticated readiness probe
(`GET /api/health/ready`) gains an `mfa` check. It passes when the key is set;
without the key the probe reports `degraded` and answers `503`. It reports
only whether the key is set, never anything derived from it.

## Decision 18 — An organization may require MFA of all its members (MFA-4)

`organizations.mfaRequired` (migration 26) says whether every member must use
MFA, whatever their role. It is `false` for every existing organization and for
every new one, so nothing changes for anyone until an organization turns it on.

`isMfaRequired` (Decision 7) is also true for a member of an organization that
requires it. That is the only change to the rule, so the requirement applies
exactly as every other reason does:

- from each member's next request, existing sessions included, with no grace
  period (Decision 15): a member without MFA is `SETUP_REQUIRED` and reaches
  only set-up and sign-out;
- MFA cannot be turned off while it holds;
- one organization requiring it means MFA for every sign-in of its members,
  whatever other organizations they belong to (Decision 11, choice 4).

Turning it off removes only that reason. No one's set-up is removed, and a
member it no longer applies to may turn MFA off as before. The messages that
explained a requirement by role now say "Your role or organization requires".

## Decision 19 — Who changes it, and how (MFA-4)

`OrganizationService.setMfaRequirement(actor, organization, required)`:

- **By role, `OWNER` or `ADMIN`** (Decision 11, choice 6), through
  `mayChangeMfaRequirement(role)`. A grant of `organization.manage` does not
  confer it: the setting governs every member's sign-in, and both roles that may
  change it must themselves use MFA, so it is never changed from a sign-in that
  has not passed MFA.
- **A non-member** is refused as on every organization route
  (`authorizeOrganization`), with nothing recorded about the requirement.
- **Any other member** is refused (`FORBIDDEN`), and the refusal is audited as
  `organization.mfa_requirement_refused`, as Phase 6H audits refused
  reassignments.
- **A request that changes nothing** writes nothing and reports
  `changed: false`.
- **A change** is written in one transaction with its audit entry,
  `organization.mfa_requirement_changed`. Both entries record the actor's role
  and the value asked for. The transaction share-locks the actor's membership
  (`FOR SHARE`) and reads the role again under it. That role must be exactly
  the one the request was authorized under: any change, even between `OWNER`
  and `ADMIN`, counts, so the audit entry always records the role actually
  held. The update is a compare-and-set on the value read. If the value or the
  actor's role changed meanwhile, nothing is written and the actor is asked to
  reload (`VALIDATION_FAILED`). A role change in flight therefore either waits
  for the change or commits first and is seen.

The web app adds `POST /api/organizations/{organizationId}/mfa-requirement`, a
form route that redirects back to the dashboard, which shows every member
whether the requirement is on and gives an `OWNER` or `ADMIN` the button.

## Consequences

- **Schema.** Migration 25: two tables, three `sessions` columns, two `CHECK`s.
  Additive; no row rewritten.
- **Ports.**
  - `Session` gains `mfaVerifiedAt` and `mfaFailedAttempts`;
    `SessionRepository.create` takes neither.
  - `IdentityRepositories` gains `mfa: MfaRepository`.
  - New exports of `@app/domain`: `MfaService`, `isMfaRequired`,
    `createMfaSecretCipher`, the TOTP and recovery-code functions.
  - New exports of `@app/shared`: `hotp`, `base32Encode`, `sealAesGcm`,
    `openAesGcm`, `keyFingerprint`, `secureRandomBytes`.
- **Environment.** `MFA_SECRET_KEY`, optional, validated as 64 hex characters.
- **Nothing visible changes** in MFA-1.
- **MFA-2.**
  - No migration.
  - New: the `/login/mfa` and `/security` pages, `POST /api/auth/mfa`, the
    four `/api/mfa` routes, and `mfaSignInStep` in `@app/domain`.
  - `getCurrentUser()` returns a user only once the sign-in has passed MFA.
  - New dependency of the web app: `qrcode` 1.5.4 (and `@types/qrcode` 1.5.6
    for development).
- **MFA-3.**
  - No migration, no new route and no new dependency.
  - `MfaSignInStep` gains `SETUP_REQUIRED`. `lib/auth.ts` gains `nextPageFor`,
    and `mfaRoute` gains its `duringSetup` option.
  - The readiness probe gains its `mfa` check.
  - Everyone who must use MFA and has not set it up does so at their next
    request, before reaching anything else.
  - `MFA_SECRET_KEY` must be set for any `OWNER` to sign in.
- **MFA-4.**
  - Migration 26: `organizations.mfaRequired`, `BOOLEAN NOT NULL DEFAULT
    false`. Additive; no row rewritten.
  - `Organization` gains `mfaRequired`, which `OrganizationRepository.create`
    does not take; the repository gains `setMfaRequired`.
  - `OrganizationService` gains `setMfaRequirement`; `@app/domain` exports
    `mayChangeMfaRequirement`. Two audit actions.
  - One new route and the dashboard control. No new dependency or
    environment variable.
  - Nothing changes at deploy: no organization requires it until an `OWNER` or
    `ADMIN` turns it on.

## Not decided here

- Email verification and password reset (also Decision 18): they need an
  email-sending service.
- Rate limiting across login, MFA recovery and the rest (ADR-0054 Decision 5).
- Operator-assisted recovery for someone who has lost both their device and
  their recovery codes. Since MFA-3 this can lock any `OWNER` out of their
  organization.
- Re-sealing secrets under a new `MFA_SECRET_KEY`.
- Whether turning MFA on, moving it or turning it off should end the user's
  other sessions. Since MFA-2, turning it on asks the other sign-ins for a code
  (Decision 12); moving it or turning it off leaves them as they were.
- Whether members should be told, other than at their next request, when an
  organization turns the requirement on. There is no email-sending service.
