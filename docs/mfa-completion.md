# Completion — MFA (authenticator app and recovery codes)

Branch: `claude/project-thread-az06z2`
ADR: `docs/decisions/0065-authenticator-mfa.md`
Gap analysis: `docs/mfa-gap-analysis.md`

MFA is built in four pull requests, approved by the product owner on
2026-10-15 with no grace period: MFA-1 (the foundation), MFA-2 (the screens
and two-step sign-in), MFA-3 (mandatory MFA) and MFA-4 (an
organization's requirement for all members). Each extends this record. MFA is
not a Roadmap phase, so it receives no `phase-N-complete` tag.

## MFA-1 — the foundation

Base: `108ecc0` (PR #84 merge commit on `main`).

Commits, oldest first:

| Commit | What it carries |
| --- | --- |
| `369c654` | migration 25; HOTP, base32 and AES-256-GCM in `@app/shared`; the `mfa` domain module (TOTP, recovery codes, who must use MFA, the cipher, `MfaService`); the PostgreSQL repository and the in-memory double; `MFA_SECRET_KEY`; the unit, shape and database tests; the earlier migration pins moved to migration 25 |
| `9c0858b` | tests calling the in-memory double directly, after a first mutation pass found its single-use guard untested (see the ledger) |
| `7d5216f` | ADR-0065, the gap analysis, this record and the documentation updates |
| `ea18438` | the two review fixes below, with their tests |
| `a011435` | ADR-0065 records them |
| `7b3d26d` | this record: the review, the verification and mutation ledger on the reviewed code |

The exact head SHA is reported with the pull request rather than written into a
file that would have to contain its own hash.

### Review

The automated review of `7d5216f` raised two findings. Both were real, and both
are fixed in `ea18438`:

- **A code could count for an authenticator replaced meanwhile.** Suppose
  `verify` or `disable` read the factor and matched a code. If another sign-in
  then moved MFA to a new device before the write, the old authenticator's next
  code still passed the `lastUsedStep` check against the new factor.
  `acceptTotpStep` and `disable` now carry the sealed secret the code was
  checked against, and their conditional `UPDATE` and `DELETE` match it.
- **A sign-in that had ended could still change the factor.** `regenerateRecoveryCodes`
  and `disable` trusted the `Session` they were given. A session signed out or
  locked out after it was read could still replace the recovery codes or turn
  MFA off. Both repository transactions now lock the stored session row and
  require it to exist, to be the user's and to have passed MFA.
  Otherwise they write nothing, and the service asks the person to sign in
  again.

### What MFA-1 does

- **Migration 25.** `user_mfa_factors` (one per user while MFA is on, the
  secret sealed), `user_mfa_recovery_codes` (SHA-256 hashes only, deleted with
  the factor), and three `sessions` columns: `mfaVerifiedAt`,
  `mfaFailedAttempts`, `mfaPendingSecret`.
- **TOTP** (RFC 6238: SHA-1, 6 digits, 30 seconds, one step either side), each
  code accepted once, with Node's `crypto` and no new dependency.
- **Sealed secrets.** AES-256-GCM under `MFA_SECRET_KEY`, bound to the user,
  prefixed with the key's id.
- **Recovery codes.** 10 codes of 16 Crockford characters (80 bits), shown once,
  read back in any case and with or without separators.
- **`MfaService`**: status; begin and confirm set-up (or move to a new
  authenticator from a session that passed MFA); pass a sign-in with an
  authenticator code or a recovery code; replace the recovery codes; turn MFA
  off for a user who need not use it, with a current code.
- **Who must use MFA**: an `OWNER` or `ADMIN` of any organization, or a holder
  there of `permission.manage` or `billing.manage` from any source.
- **Five wrong codes** end the sign-in.
- **Audit**: `mfa.enabled`, `mfa.replaced`, `mfa.challenge_passed`,
  `mfa.challenge_locked`, `mfa.recovery_codes_regenerated`, `mfa.disabled`, each
  committed with its change; never a secret, code or hash.

Behaviour anyone can notice: **none**. No route, page or worker calls the
service or reads `MFA_SECRET_KEY`, and signing in is unchanged.

### Passing MFA in a second sign-in (as MFA-2 will call it)

```mermaid
sequenceDiagram
  autonumber
  participant U as Person
  participant S as MfaService
  participant DB as PostgreSQL

  Note over U,DB: MFA is on; the person has signed in with their password (session X)
  U->>S: verify(session X, "492 039")
  S->>DB: read the factor (sealed secret, lastUsedStep)
  S->>S: open the secret for this user; match steps s-1, s, s+1 later than lastUsedStep
  S->>DB: BEGIN; lock session X
  S->>DB: UPDATE factor SET lastUsedStep = s WHERE lastUsedStep < s
  alt a concurrent request used this code first
    DB-->>S: 0 rows (nothing written)
    S->>DB: UPDATE sessions SET mfaFailedAttempts + 1 RETURNING (the fifth deletes X, audited)
    S-->>U: "That code is not valid", attempts left
  else
    S->>DB: session X: mfaVerifiedAt = now, mfaFailedAttempts = 0
    S->>DB: INSERT mfa.challenge_passed { method: authenticator }; COMMIT
    S-->>U: passed
  end
```

### Verification

Measured on the reviewed code against a local PostgreSQL 16 configured like CI:
commit `ea184383b1e12389c58c49977d73c6ce6f92c15c` (tree `1aa8285deaa23f058d568987bc19e719f030266d`), and for the
database suite's rerun, commit `a011435276959a386cf1420dcce05b4335e27dd9`. The
commits after `ea18438` change documentation only.

| Check | Result |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | clean |
| `pnpm test` | **5201 / 5201, 174 files** (MFA: service 27, primitives 19, shape 5, in-memory double 7, `@app/shared` crypto 10, environment 6) |
| `pnpm test:db` | **1350 / 1350, 48 files** (the MFA suite: 22), on the rerun |
| `pnpm build` | Next.js production build succeeded |
| `prisma migrate diff` (migrations → schema) | no difference |
| `prisma migrate status` | 26 migrations, schema up to date |

The first `pnpm test:db` run on `ea18438` passed 1349 of 1350. The failure was
one concurrency test of the dormant provider-output orchestration, which MFA
does not touch:
`provider-output-orchestration.db.test.ts`, "gives two PROCESSING runners one
history and at most one transfer". The losing runner reported
`OUTPUT_VERIFICATION_REPLAYED`, an outcome the test does not allow. It passed
three targeted reruns and the full rerun above. This is the known test-only race
already recorded in `docs/decisions/TODO.md` (*Found in Phase 6F*). That item
explains it: the product behaves correctly, and the test asserts too much. It is
not fixed here.

CI on the pull request's exact head is reported with the pull request.

New tests:
- **`@app/shared`** (`mfa-crypto.test.ts`, `env.test.ts`): the RFC 4648 base32
  vectors; the RFC 4226 HOTP values; the RFC 6238 SHA-1 values; sealing bound to
  key and associated data, a fresh IV each time, tampering and truncation
  refused; `MFA_SECRET_KEY` accepted only as 64 hex characters and not yet
  required.
- **Primitives** (`mfa-primitives.test.ts`): the drift window, single use,
  six digits only; recovery codes' form, reading back and hashing; the cipher
  refusing another user, another key and tampering; who must use MFA by role,
  by individual grant, by group, in any organization, read on every call.
- **Service** (`mfa-service.test.ts`, in memory): every method, its refusals and
  its audit entries; moving to a new device; a set-up started before MFA was
  turned on cannot replace it; the lock-out at the fifth wrong code; nothing
  secret in the audit log. An old authenticator's code, checked just before
  the authenticator was replaced, neither passes a sign-in nor turns MFA off.
  A sign-in that ended after it was read gets no new recovery codes and cannot
  turn MFA off.
- **In-memory double** (`in-memory-mfa.test.ts`): the double's own guards,
  called directly, give the outcomes the PostgreSQL suite pins.
- **Shape** (`mfa-shape.test.ts`): migration 25 is the newest and only adds;
  hash-only storage and the cascades; no application file reaches the service
  or the key; `AuthService` does not mention MFA.
- **Live PostgreSQL** (`mfa.db.test.ts`): the tables, `CHECK`s and cascades;
  the whole cycle through the real repositories with its audit rows; each
  repository guard; a set-up, a code acceptance or a lock-out whose audit row
  cannot be written leaves nothing behind; one authenticator code, and one
  recovery code, accepted once across six concurrent sign-ins; concurrent
  recovery codes reporting exactly how many are left; eight concurrent wrong
  codes counted exactly, ending the session once; two concurrent first set-ups,
  one winning. A code is accepted, or turns MFA off, only for the
  authenticator it was checked against. New recovery codes and turning MFA off
  need a stored session that is the user's and has passed MFA.

### Mutation ledger

Each mutant weakens one MFA guarantee at an anchor that must occur exactly
once, and runs against the suites listed for it. Every mutated file is restored
and re-hashed. A SHA-256 manifest of all files in the working tree is
compared before and after the pass. A kill counts only when tests ran and
failed; a mutant that does not parse would count as broken.

**Authoritative: 52 run, 52 killed, 0 survivors, 0 broken, 0 anchor-missing**,
in one uninterrupted pass against the reviewed code: tree
`532a219231d93cbd6d32088e843a3ad4afd69a14` (commit
`a011435276959a386cf1420dcce05b4335e27dd9`). All 801 files were
byte-identical after the pass.

Earlier passes:
- **`369c654`: 42 of 43 killed.** M01 survived. The service drops steps
  already used before it reaches the repository, so no service test reached the
  in-memory double's own single-use guard. `9c0858b` adds tests that call the
  double directly, and they kill it.
- **`9c0858b`: 43 of 43 killed.**
- **After the review.** The review fixes moved the anchors of P01, P07, M01, S02
  and P10. Nine mutants were added for the fixes:
  - P12 and P13: binding to the checked authenticator;
  - P14 to P17: the stored session;
  - M02 and M03: the same two guards in the in-memory double;
  - S12: the service's answer to an ended sign-in.

| # | Area | Mutation | File | Killed by |
| --- | --- | --- | --- | --- |
| C01 | hotp | dynamic truncation always reads offset 0 | `mfa-crypto.ts` | unit: 2 failed of 394 |
| C02 | base32 | the last partial group is dropped | `mfa-crypto.ts` | unit: 1 failed of 394 |
| C03 | sealing | every secret is sealed with the same IV | `mfa-crypto.ts` | unit: 1 failed of 394 |
| A01 | sealing | a sealed secret is not bound to its user | `adapters.ts` | unit: 1 failed of 394 |
| A02 | sealing | the key id is not checked | `adapters.ts` | unit: 1 failed of 394 |
| T01 | totp | no drift: only the current step | `totp.ts` | unit: 4 failed of 394 |
| T02 | totp | two steps ahead accepted | `totp.ts` | unit: 2 failed of 394 |
| T03 | totp | the last step used is offered again | `totp.ts` | unit: 1 failed of 394 |
| T04 | totp | any six digits match | `totp.ts` | unit: 10 failed of 394 |
| R01 | recovery | O, I and L are not read back | `recovery-codes.ts` | unit: 1 failed of 394 |
| R02 | recovery | a code is stored as typed | `recovery-codes.ts` | unit: 1 failed of 394 |
| R03 | recovery | 8 codes in a set | `recovery-codes.ts` | unit: 5 failed of 394 |
| R04 | recovery | 40-bit codes | `recovery-codes.ts` | unit: 24 failed of 394 |
| Q01 | requirement | billing.manage does not make MFA mandatory | `requirement.ts` | unit: 1 failed of 394 |
| Q02 | requirement | only the first organization is read | `requirement.ts` | unit: 1 failed of 394 |
| Q03 | requirement | grants and groups are ignored | `requirement.ts` | unit: 2 failed of 394 |
| S01 | service | a session that has not passed MFA may replace it | `mfa-service.ts` | unit: 1 failed of 394 |
| S02 | service | an ended session passes silently | `mfa-service.ts` | unit: 1 failed of 394 |
| S03 | service | wrong codes never end the sign-in | `mfa-service.ts` | unit: 2 failed of 394 |
| S04 | service | six wrong codes allowed | `mfa-service.ts` | unit: 1 failed of 394 |
| S05 | service | new recovery codes without having passed MFA | `mfa-service.ts` | unit: 1 failed of 394 |
| S06 | service | turning off without having passed MFA | `mfa-service.ts` | unit: 1 failed of 394 |
| S07 | service | someone who must use MFA turns it off | `mfa-service.ts` | unit: 1 failed of 394 |
| S08 | audit | the recovery code used is audited | `mfa-service.ts` | unit: 2 failed of 394 |
| S09 | audit | the new recovery codes are audited | `mfa-service.ts` | unit: 2 failed of 394 |
| S10 | audit | moving to a new device is audited as turning on | `mfa-service.ts` | unit: 1 failed of 394 |
| S11 | service | the otpauth URI names no issuer | `mfa-service.ts` | unit: 1 failed of 394 |
| P01 | repository | an authenticator code is accepted again | `mfa-repository.ts` | db: 1 failed of 22 |
| P02 | repository | using a recovery code does not lock the factor | `mfa-repository.ts` | db: 1 failed of 22 |
| P03 | repository | the limit counts one more wrong code | `mfa-repository.ts` | db: 3 failed of 22 |
| P04 | repository | a lock-out keeps the session | `mfa-repository.ts` | db: 2 failed of 22 |
| P05 | repository | an unpassed session's set-up replaces the factor | `mfa-repository.ts` | db: 1 failed of 22 |
| P06 | repository | set-up enables a secret the session does not hold | `mfa-repository.ts` | db: 1 failed of 22 |
| P07 | repository | turning off accepts a used step | `mfa-repository.ts` | db: 1 failed of 22 |
| P08 | repository | a code accepted does not reset the count | `mfa-repository.ts` | db: 1 failed of 22 |
| P09 | repository | set-up does not pass the session | `mfa-repository.ts` | db: 3 failed of 22 |
| P10 | atomicity | accepting a code survives a failed audit write | `mfa-repository.ts` | db: 1 failed of 22 |
| P11 | atomicity | set-up survives a failed audit write | `mfa-repository.ts` | db: 1 failed of 22 |
| P12 | binding | an authenticator code is accepted for a replaced authenticator | `mfa-repository.ts` | db: 1 failed of 22 |
| P13 | binding | turning off deletes a replaced authenticator | `mfa-repository.ts` | db: 1 failed of 22 |
| P14 | session | new recovery codes from an ended sign-in | `mfa-repository.ts` | db: 1 failed of 22 |
| P15 | session | turning off from an ended sign-in | `mfa-repository.ts` | db: 1 failed of 22 |
| P16 | session | a stored sign-in that has not passed MFA counts as passed | `mfa-repository.ts` | db: 1 failed of 22 |
| P17 | session | another user's passed sign-in counts | `mfa-repository.ts` | db: 1 failed of 22 |
| S12 | service | an ended sign-in gets new recovery codes | `mfa-service.ts` | unit: 1 failed of 394 |
| M01 | double | the in-memory double accepts a code again | `in-memory-mfa.ts` | unit: 2 failed of 394 |
| M02 | double | the in-memory double accepts a replaced authenticator | `in-memory-mfa.ts` | unit: 3 failed of 394 |
| M03 | double | the in-memory double trusts an ended sign-in | `in-memory-mfa.ts` | unit: 3 failed of 394 |
| X01 | migration | recovery codes may be stored as typed | `migration.sql` | unit: 1 failed of 394 |
| X02 | migration | recovery codes outlive the factor | `migration.sql` | unit: 1 failed of 394 |
| E01 | environment | a 16-byte key is accepted | `env.ts` | unit: 1 failed of 394 |
| D01 | dormancy | a web module reaches the MFA service | `auth.ts` | unit: 1 failed of 394 |

"unit" is `packages/shared/src/`, `packages/domain/src/mfa/`,
`packages/domain/src/identity/` and `in-memory-mfa.test.ts` (394 tests).
"db" is `tests/integration/mfa.db.test.ts` (22 tests). X01, X02 and D01 are
killed by the shape test, which reads the migration and the application sources
as text. P02 is killed by a concurrent test: five recovery codes used at once
must report 5 to 9 left. It killed P02 in all three passes, but a race could in
principle let it pass.

No mutant removes the `OWNER`/`ADMIN` role clause of `isMfaRequired`: both
templates already grant `permission.manage`, so no test can tell the clause
apart (ADR-0065 Decision 7).

### Required documentation

| Item | Where |
| --- | --- |
| Architecture diagram | `docs/architecture.md` status table (an MFA-1 row; the 6I-2 row no longer says MFA is not implemented) |
| Entity-relationship diagram | `docs/er-diagram.md`: `USER_MFA_FACTORS`, `USER_MFA_RECOVERY_CODES` and the new `SESSIONS` columns, and an MFA-1 section |
| Critical sequence diagram | this section, *Passing MFA in a second sign-in* |
| OpenAPI / API change summary | HTTP: none; no route added or changed. Internal API: `MfaService`, `isMfaRequired`, `createMfaSecretCipher` and the TOTP and recovery-code functions in `@app/domain`; `IdentityRepositories.mfa`; `Session.mfaVerifiedAt` and `mfaFailedAttempts`; `hotp`, `base32Encode`, `sealAesGcm`, `openAesGcm`, `keyFingerprint` and `secureRandomBytes` in `@app/shared` |
| Change log / release notes | the commit list above and the pull request description |
| Database migration notes | `docs/migration-notes.md`, *MFA-1* |
| Completion report | this file |

Also updated: `docs/Roadmap.md`, `docs/decisions/TODO.md` (an MFA item, the
choices recorded for confirmation, what MFA leaves open), `.env.example` and
`docs/local-setup.md` (`MFA_SECRET_KEY`).

### Activation status

Nothing is activated. MFA-1 adds no route, page, worker, scheduler, credential
or dependency. Paid Provider Activation, production credentials, the production
scheduler and live Stripe charges remain BLOCKED.

### Known limitations

- Nothing calls the service: MFA-2 adds the screens and the two-step sign-in,
  MFA-3 the enforcement.
- Re-sealing secrets under a new `MFA_SECRET_KEY` is not built; changing the key
  makes existing set-ups unusable.
- Turning MFA on, moving it or turning it off does not end the user's other
  sessions.
- The five-wrong-codes guard is per sign-in. A person with the password can sign
  in again and try five more; the rate limiter (ADR-0054 Decision 5) is its own
  milestone.
- Operator-assisted recovery for someone who has lost both their device and
  their codes is not built.

### Remaining work

MFA-2, MFA-3 and MFA-4, each asking before merge. Then email verification and
password reset, which need an email-sending service, and rate limiting.

## MFA-2 — the security page and two-step sign-in

Base: `e246b00` (PR #85 merge commit on `main`).

Commits, oldest first:

| Commit | What it carries |
| --- | --- |
| `e31d456` | `mfaSignInStep`; the session gate in `lib/auth.ts`; `lib/mfa.ts`; the code page and route; the security page, its panel and the four `/api/mfa` routes; the `qrcode` dependency; the tests; ADR-0065 Decisions 12 to 14, the API change summary, this record and the documentation updates |
| *(this commit)* | this record: the verification and the mutation ledger |

The exact head SHA is reported with the pull request.

### What MFA-2 does

- **A code after the password.** `mfaSignInStep` says whether a sign-in has
  passed MFA or owes a code. `getCurrentUser()`, through which every route and
  page gets its user, returns one only once it has passed.
  - A sign-in that owes a code gets `401` from every route, and every page
    sends it to `/login`, which forwards it to `/login/mfa`.
  - Signing in with the password sends a user with MFA on straight to
    `/login/mfa`.
- **The code step** (`/login/mfa`, `POST /api/auth/mfa`) takes an authenticator
  code or a recovery code.
  - A wrong code comes back with the attempts left.
  - The fifth ends the sign-in, clears its cookie and goes back to the password.
- **The security page** (`/security`, linked from the dashboard) offers:
  - turning MFA on: a QR code drawn on the server, the key, a first code, then
    the recovery codes shown once;
  - new recovery codes;
  - moving to a new device;
  - turning it off with a current code, offered only to someone who need not
    use MFA.
- **Four JSON routes** under `/api/mfa`. Each is for the signed-in user only,
  and every response is `Cache-Control: no-store`.
- **Without `MFA_SECRET_KEY`, MFA fails closed.** The page says MFA is not
  available, the routes answer `500`, and no code is checked. It stays optional
  in the environment schema, which the worker shares.

Behaviour anyone can notice: a *Sign-in security* link on the dashboard. Anyone
may turn MFA on, and once it is on, signing in asks for a code. Nobody is
required to yet; that is MFA-3.

### Signing in with MFA on

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant W as Web app
  participant S as MfaService
  participant DB as PostgreSQL

  B->>W: POST /api/auth/login (email, password)
  W->>DB: create session X (mfaVerifiedAt null)
  W->>DB: find the user's factor: found
  W-->>B: 303 /login/mfa, cookie X
  B->>W: any page or route
  W->>W: getCurrentUser(): X owes a code, so no user
  W-->>B: pages 303 /login (forwards to /login/mfa); routes 401
  B->>W: POST /api/auth/mfa (code)
  W->>S: verify(X, code)
  alt the code is accepted
    S->>DB: X passed MFA; mfa.challenge_passed; COMMIT
    W-->>B: 303 /
  else a wrong code, attempts left
    S->>DB: X: mfaFailedAttempts + 1
    W-->>B: 303 /login/mfa (That code is not valid. Attempts left: N)
  else the fifth wrong code
    S->>DB: delete X; mfa.challenge_locked; COMMIT
    W-->>B: 303 /login, cookie cleared
  end
```

### Verification

Measured on `e31d456` (local PostgreSQL 16, configured like CI); the commit
after it changes this record only.

| Check | Result |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | clean |
| `pnpm test` | **5231 / 5231**, 178 files |
| `pnpm test:db` | **1350 / 1350**, 48 files (no database code changed) |
| `pnpm build` | succeeded; `/login/mfa` and `/security` are dynamic pages |
| `prisma migrate diff` (migrations → schema) | no difference |
| `prisma migrate status` | 26 migrations, up to date |

New tests: the sign-in step over the in-memory repositories (4); the routes,
with the session gate, `lib/mfa.ts` and the domain running for real (11); the
three pages (5); the security panel (8); and the boundary checks in the shape
test (4, replacing MFA-1's 2 dormancy checks).

### Mutation ledger

**33 run, 33 killed, 0 survivors, 0 broken**, in one pass on the code of
`e31d456`. Each mutant weakens one guarantee at an anchor that occurs exactly
once, and runs the MFA domain tests, the web app's component and page tests and
the MFA route tests (209 tests in 13 files). Every mutated file was restored and
re-hashed, and all 816 files were byte-identical afterwards.

| Mutant | Area | What it breaks | File | Tests failing |
| --- | --- | --- | --- | --- |
| G01 | gate | a sign-in that passed MFA is asked again | `sign-in.ts` | 7 of 209 |
| G02 | gate | a user with MFA on needs no code | `sign-in.ts` | 10 of 209 |
| G03 | gate | the passed check is inverted | `sign-in.ts` | 13 of 209 |
| A01 | gate | getCurrentUser returns a sign-in that owes a code | `auth.ts` | 5 of 209 |
| A02 | gate | the step is never computed | `auth.ts` | 7 of 209 |
| L01 | sign-in | a user with MFA on goes home after the password | `auth/login/route.ts` | 1 of 209 |
| R01 | code step | a signed-in sign-in is asked for a code | `auth/mfa/route.ts` | 1 of 209 |
| R02 | code step | no sign-in is sent home | `auth/mfa/route.ts` | 2 of 209 |
| R03 | code step | an ended sign-in keeps its cookie | `auth/mfa/route.ts` | 1 of 209 |
| R04 | code step | a lockout stays on the code page | `auth/mfa/route.ts` | 1 of 209 |
| R05 | code step | the attempts left are not shown | `auth/mfa/route.ts` | 2 of 209 |
| R06 | code step | a wrong code goes home | `auth/mfa/route.ts` | 2 of 209 |
| F01 | key | no fail-closed check for a missing key | `mfa.ts` | 3 of 209 |
| F02 | routes | an anonymous request reaches the handler | `mfa.ts` | 2 of 209 |
| F03 | routes | no Cache-Control: no-store | `mfa.ts` | 4 of 209 |
| F04 | routes | an error response may be cached | `mfa.ts` | 2 of 209 |
| F05 | routes | the MFA routes accept a sign-in that owes a code | `mfa.ts` | 1 of 209 |
| F06 | routes | the code is read from another field | `mfa.ts` | 8 of 209 |
| Q01 | qr | the QR code holds the bare secret | `mfa/setup/route.ts` | 1 of 209 |
| Q02 | routes | the otpauth URI is sent as well | `mfa/setup/route.ts` | 1 of 209 |
| D01 | routes | turning off answers 200 with a body | `mfa/disable/route.ts` | 1 of 209 |
| P01 | pages | the sign-in page does not forward a sign-in owing a code | `app/login/page.tsx` | 2 of 209 |
| P02 | pages | the code page shows to a signed-in user | `login/mfa/page.tsx` | 1 of 209 |
| P03 | pages | the code page shows without a sign-in | `login/mfa/page.tsx` | 1 of 209 |
| P04 | pages | the security page shows without a signed-in user | `app/security/page.tsx` | 1 of 209 |
| P05 | pages | a missing key breaks the security page | `app/security/page.tsx` | 1 of 209 |
| U01 | panel | turning off is offered to someone who must use MFA | `mfa-panel.tsx` | 2 of 209 |
| U02 | panel | an ended sign-in is not sent to sign in | `mfa-panel.tsx` | 1 of 209 |
| U03 | panel | the recovery codes are not shown after set-up | `mfa-panel.tsx` | 1 of 209 |
| U04 | panel | the code is sent untrimmed | `mfa-panel.tsx` | 1 of 209 |
| U05 | panel | the attempts left are not shown | `mfa-panel.tsx` | 1 of 209 |
| U06 | panel | the set-up stays open behind the recovery codes | `mfa-panel.tsx` | 1 of 209 |
| S01 | boundary | another page reads a sign-in owing a code | `src/app/page.tsx` | 1 of 209 |


### Required documentation

| Item | Where |
| --- | --- |
| Architecture diagram | `docs/architecture.md` status table: an MFA-2 row; the MFA-1 row no longer says dormant |
| Entity-relationship diagram | Not applicable: MFA-2 changes no table or column |
| Critical sequence diagram | this section, *Signing in with MFA on* |
| OpenAPI / API change summary | `docs/api-changes-mfa-2.md`. Internal API: `mfaSignInStep` and `MfaSignInStep` in `@app/domain`; `getSignIn()` in `apps/web/src/lib/auth.ts` |
| Change log / release notes | the commit list above and the pull request description |
| Database migration notes | `docs/migration-notes.md`, *MFA-2*: no migration, and where `MFA_SECRET_KEY` must be set |
| Completion report | this file |

Also updated: ADR-0065 (Decisions 12 to 14; Decision 10 superseded),
`docs/Roadmap.md`, `docs/decisions/TODO.md`, `.env.example`,
`docs/local-setup.md` and the comment on `MFA_SECRET_KEY` in the environment
schema.

### Activation status

Nothing paid or scheduled is activated. MFA-2 adds pages and routes to the web
app and one dependency, `qrcode` 1.5.4, which draws the set-up QR code on the
server. It adds no worker, scheduler or credential. Paid Provider Activation,
production credentials, the production scheduler and live Stripe charges remain
BLOCKED.

### Known limitations

- MFA is optional for everyone until MFA-3 makes it mandatory for `OWNER`,
  `ADMIN` and holders of `permission.manage` or `billing.manage`.
- The five-wrong-codes guard is per sign-in, so until rate limiting exists
  (ADR-0054 Decision 5) a person with the password can sign in again and try
  more codes. Rate limiting should ship before MFA is relied on in production.
- Turning MFA on asks the user's other sign-ins for a code. Moving it or
  turning it off leaves a sign-in that already passed it signed in.
- Turning MFA on asks for the signed-in session only, not the password again
  (ADR-0052 Decision 10 adds no step-up mechanism). Someone holding another
  person's session, on an account without MFA, could turn it on and lock them
  out until operator-assisted recovery exists.
- Without `MFA_SECRET_KEY`, someone with MFA on cannot finish signing in. The
  readiness probe does not report the missing key.
- Re-sealing under a new key and operator-assisted recovery are still not
  built.

### Remaining work

MFA-3 and MFA-4, each asking before merge.

## MFA-3 — mandatory MFA

Base: `d72e374` (PR #86 merge commit on `main`; post-merge CI run 557 green).

Commits, oldest first:

| Commit | What it carries |
| --- | --- |
| `7ca92a4` | the `SETUP_REQUIRED` step; `nextPageFor`; `mfaRoute`'s `duringSetup`; the set-up-first security page; the readiness `mfa` check; the tests; ADR-0065 Decisions 15 to 17, the API change summary and the documentation updates |
| *(this commit)* | this record, with the verification and the mutation ledger |

The exact head SHA is reported with the pull request.

### What MFA-3 does

- **Set-up first.** `mfaSignInStep` gains `SETUP_REQUIRED`: the user must use
  MFA (`isMfaRequired`: `OWNER`, `ADMIN`, or `permission.manage` or
  `billing.manage` from any source) and has not set it up. Such a sign-in is
  signed in nowhere, as one that owes a code is not.
  - Every route answers `401`. Every page sends it to `/login`, which forwards
    it to `/security`.
  - Signing in with the password sends it straight to `/security`.
  - `nextPageFor(step)` names the page for each step, and the login route, the
    two sign-in pages and the code route all use it.
- **What it can reach**: the security page in a set-up-first form (the reason,
  set-up and sign-out, no link back), `POST /api/mfa/setup` and
  `/setup/confirm`, and sign-out. Once set-up is confirmed it is signed in, and
  the page goes on to `/` when the recovery codes are saved.
- **Read on every request**, from current memberships. A grant applies from the
  next request, existing sessions included, and there is no grace period.
- **The readiness probe** reports whether `MFA_SECRET_KEY` is set, and is
  `degraded` without it, since without the key no `OWNER` can sign in.

Behaviour anyone can notice: at their next request, every `OWNER`, `ADMIN`,
`BILLING` and other holder of `permission.manage` or `billing.manage` without
MFA is asked to set it up before anything else. Creating an organization leads
straight to set-up, because its creator is its `OWNER`. Everyone else is
unaffected.

### Signing in when MFA is required and not set up

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant W as Web app
  participant S as MfaService
  participant DB as PostgreSQL

  B->>W: POST /api/auth/login (email, password)
  W->>DB: create session X (mfaVerifiedAt null)
  W->>DB: find the user's factor: none
  W->>DB: memberships, grants and groups: MFA required
  W-->>B: 303 /security, cookie X
  B->>W: any other page or route
  W->>W: getCurrentUser(): X must set MFA up, so no user
  W-->>B: pages 303 /login (forwards to /security); routes 401
  B->>W: POST /api/mfa/setup (duringSetup)
  W->>S: beginSetup(X)
  W-->>B: 200 secret and QR code
  B->>W: POST /api/mfa/setup/confirm (code, duringSetup)
  W->>S: confirmSetup(X, code)
  S->>DB: factor, recovery codes, X passed MFA; mfa.enabled; COMMIT
  W-->>B: 200 recovery codes
  B->>W: GET / (after "I have saved them")
  W->>W: getCurrentUser(): X signed in
```

### Verification

Measured on `7ca92a4` (local PostgreSQL 16, configured like CI); the commit
after it adds this record only.

| Check | Result |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | clean |
| `pnpm test` | **5245 / 5245**, 178 files |
| `pnpm test:db` | **1350 / 1350**, 48 files (no database code changed); see below |
| `pnpm build` | succeeded |
| `prisma migrate diff` (migrations → schema) | no difference |
| `prisma migrate status` | 26 migrations, up to date |

The first database run on `7ca92a4` failed one test, *gives two PROCESSING
runners one history and at most one transfer*, with
`OUTPUT_VERIFICATION_REPLAYED`. That is the known race recorded in `TODO.md`
(found in Phase 6F), in code MFA-3 does not touch. The next run passed in full.
A run during development, before the commit, also failed one test that was not
captured; the two runs after it passed.

New tests: the sign-in step (2); the routes, with the session gate,
`lib/mfa.ts` and the domain running for real (4); the pages (4, one rewritten);
the security panel (1); the readiness probe (1); and the boundary checks in the
shape test (2).

### Mutation ledger

**36 run, 36 killed, 0 survivors, 0 broken**, in one pass on the code of
`7ca92a4`. Each mutant weakens one guarantee at an anchor that occurs exactly
once, and runs the MFA domain tests, the web app's component, page and library
tests and the MFA route tests (287 tests in 22 files). Every mutated file was
restored and re-hashed, and all 817 files were byte-identical afterwards.

| Mutant | Area | What it breaks | File | Tests failing |
| --- | --- | --- | --- | --- |
| N01 | gate | no sign-in is ever asked to set MFA up | `sign-in.ts` | 10 of 287 |
| N02 | gate | the requirement is inverted | `sign-in.ts` | 17 of 287 |
| N03 | gate | a sign-in that passed MFA once counts without a factor | `sign-in.ts` | 1 of 287 |
| N04 | gate | a user with MFA on is asked to set it up instead of for a code | `sign-in.ts` | 12 of 287 |
| N05 | gate | a sign-in that passed MFA is asked again | `sign-in.ts` | 9 of 287 |
| A01 | gate | getCurrentUser returns a sign-in that must set MFA up | `auth.ts` | 5 of 287 |
| X01 | next page | set-up required goes home | `auth.ts` | 5 of 287 |
| X02 | next page | a code owed goes to set-up | `auth.ts` | 4 of 287 |
| X03 | next page | signed in goes back to sign in | `auth.ts` | 3 of 287 |
| F01 | routes | set-up is closed to a sign-in that must set MFA up | `mfa.ts` | 5 of 287 |
| F02 | routes | set-up is open to a sign-in that owes a code | `mfa.ts` | 1 of 287 |
| F03 | routes | every MFA route is open during set-up | `mfa.ts` | 1 of 287 |
| F04 | routes | the step is not checked at all | `mfa.ts` | 2 of 287 |
| F05 | routes | no Cache-Control: no-store | `mfa.ts` | 6 of 287 |
| S01 | routes | set-up does not pass duringSetup | `mfa/setup/route.ts` | 6 of 287 |
| S02 | routes | confirming does not pass duringSetup | `setup/confirm/route.ts` | 3 of 287 |
| S03 | routes | new recovery codes are open during set-up | `mfa/recovery-codes/route.ts` | 2 of 287 |
| S04 | routes | turning off is open during set-up | `mfa/disable/route.ts` | 2 of 287 |
| L01 | sign-in | set-up required goes home after the password (the MFA-2 rule) | `auth/login/route.ts` | 2 of 287 |
| R01 | code step | a sign-in that must set MFA up is asked for a code | `auth/mfa/route.ts` | 1 of 287 |
| R02 | code step | a sign-in that owes no code goes home whatever its step | `auth/mfa/route.ts` | 1 of 287 |
| P01 | pages | the sign-in page forwards only a sign-in that owes a code | `app/login/page.tsx` | 1 of 287 |
| P02 | pages | the code page sends set-up required home | `login/mfa/page.tsx` | 1 of 287 |
| P03 | pages | the security page shows to a sign-in that owes a code | `app/security/page.tsx` | 1 of 287 |
| P04 | pages | the security page never shows its set-up-first form | `app/security/page.tsx` | 2 of 287 |
| P05 | pages | the panel is not told to go on in after set-up | `app/security/page.tsx` | 1 of 287 |
| P06 | pages | no sign-out on the set-up-first form | `app/security/page.tsx` | 1 of 287 |
| P07 | pages | the set-up-first form links back to the dashboard | `app/security/page.tsx` | 1 of 287 |
| P08 | pages | the security page shows without a sign-in | `app/security/page.tsx` | 1 of 287 |
| U01 | panel | set-up required stays on the security page after saving the codes | `mfa-panel.tsx` | 2 of 287 |
| U02 | panel | every set-up goes home after saving the codes | `mfa-panel.tsx` | 1 of 287 |
| H01 | readiness | the MFA check always passes | `health.ts` | 1 of 287 |
| H02 | readiness | no MFA check | `health.ts` | 1 of 287 |
| H03 | readiness | the probe shows the key | `health.ts` | 2 of 287 |
| H04 | readiness | the key's presence is misread | `health.ts` | 2 of 287 |
| B01 | boundary | another page reads a sign-in that has not passed MFA | `src/app/page.tsx` | 1 of 287 |

### Required documentation

| Item | Where |
| --- | --- |
| Architecture diagram | `docs/architecture.md` status table: an MFA-3 row |
| Entity-relationship diagram | Not applicable: MFA-3 changes no table or column |
| Critical sequence diagram | this section, *Signing in when MFA is required and not set up* |
| OpenAPI / API change summary | `docs/api-changes-mfa-3.md`. Internal API: `SETUP_REQUIRED` in `MfaSignInStep` (`@app/domain`); `nextPageFor` in `apps/web/src/lib/auth.ts`; the `duringSetup` option of `mfaRoute` in `apps/web/src/lib/mfa.ts` |
| Change log / release notes | the commit list above and the pull request description |
| Database migration notes | `docs/migration-notes.md`, *MFA-3*: no migration, what changes at deploy, and that `MFA_SECRET_KEY` must be set first |
| Completion report | this file |

Also updated: ADR-0065 (Decisions 15 to 17), `docs/Roadmap.md`,
`docs/decisions/TODO.md`, `.env.example` and `docs/local-setup.md`.

### Activation status

Nothing paid or scheduled is activated. MFA-3 changes who counts as signed in
and adds one readiness check. It adds no route, dependency, worker, scheduler or
credential. Paid Provider Activation, production credentials, the production
scheduler and live Stripe charges remain BLOCKED.

### Known limitations

- **`MFA_SECRET_KEY` must be set before deploying MFA-3.** Without it no one
  who must use MFA can sign in, every `OWNER` included. The readiness probe
  now reports it, but the web app still starts without it.
- **No way back for a lost device and lost recovery codes.** Operator-assisted
  recovery is not built, and since MFA-3 this can lock any `OWNER` out of their
  organization.
- The five-wrong-codes guard is per sign-in, so until rate limiting exists
  (ADR-0054 Decision 5) a person with the password can sign in again and try
  more codes. Rate limiting should ship before MFA is relied on in production.
- A grant applies from the next request. A page already open keeps working
  until it next asks the server; JSON actions on it then get `401`.
- Turning MFA on asks for the signed-in session only, not the password again
  (ADR-0052 Decision 10 adds no step-up mechanism).
- An organization's requirement for all members is MFA-4.

### Remaining work

MFA-4, asking before merge.

## MFA-4 — an organization's requirement for all members

Base: `7cf7ca5` (PR #87 merge commit on `main`; post-merge CI run 560 green).

Commits, oldest first:

| Commit | What it carries |
| --- | --- |
| `5b8165d` | migration 26; the requirement in `isMfaRequired`; `setMfaRequirement` and its repository write; the route and the dashboard control; the wording; the tests; ADR-0065 Decisions 18 and 19, the API change summary and the documentation updates |
| *(this commit)* | this record, with the verification and the mutation ledger |

The exact head SHA is reported with the pull request.

### What MFA-4 does

- **The setting.** `organizations.mfaRequired` (migration 26), `false` for
  every existing and new organization.
- **Who must use MFA** (`isMfaRequired`) now also includes every member of an
  organization that requires it. It applies as in MFA-3, from each member's next
  request: a member without MFA reaches only set-up and sign-out, and cannot
  turn MFA off while it holds. Turning it off removes only that reason.
- **Who may change it**: an `OWNER` or `ADMIN`, by role. A `MANAGER` granted
  `organization.manage` may not. A non-member is refused as on every
  organization route; any other member is refused and the refusal audited.
- **How it is written**: one transaction with its audit entry, a
  compare-and-set on the value read, under a `FOR SHARE` lock on the actor's
  membership. If the value or the actor's role moved meanwhile, even between
  `OWNER` and `ADMIN`, nothing is written and the actor is asked to reload. A
  request that changes nothing writes nothing.
- **Where**: `POST /api/organizations/{organizationId}/mfa-requirement`, and
  the dashboard, which tells every member whether it is on and gives an `OWNER`
  or `ADMIN` the button.

Behaviour anyone can notice: the dashboard says under each organization whether
every member must use MFA, and an `OWNER` or `ADMIN` can switch it. Nothing else
changes until one does.

### Requiring MFA of every member

```mermaid
sequenceDiagram
  autonumber
  participant A as Admin's browser
  participant M as Member's browser
  participant W as Web app
  participant DB as PostgreSQL

  A->>W: POST /api/organizations/{id}/mfa-requirement (required=true)
  W->>DB: membership of the actor: ADMIN
  W->>DB: organization: mfaRequired false
  W->>DB: BEGIN; actor's membership FOR SHARE: still ADMIN
  W->>DB: UPDATE organizations SET mfaRequired = true WHERE mfaRequired = false
  W->>DB: audit organization.mfa_requirement_changed; COMMIT
  W-->>A: 303 /
  M->>W: any page or route (member without MFA)
  W->>DB: memberships: an organization requires MFA; no factor
  W->>W: SETUP_REQUIRED, so no user
  W-->>M: pages 303 /login (forwards to /security); routes 401
```

### Verification

Measured on `5b8165d` (local PostgreSQL 16, configured like CI); the commit
after it adds this record only.

| Check | Result |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | clean |
| `pnpm test` | **5282 / 5282**, 181 files |
| `pnpm test:db` | **1364 / 1364**, 49 files |
| `pnpm build` | succeeded; the new route is listed |
| `prisma migrate diff` (migrations → schema) | no difference |
| `prisma migrate status` | 27 migrations, up to date |

Both full database runs during MFA-4 passed; the known race in
`provider-output-orchestration.db.test.ts` (recorded in `TODO.md` since Phase
6F) did not recur.

New tests:
- the service (15): who may change it and who is refused, the audits, a change
  that changes nothing, a value or role that moved meanwhile, two changes at
  once, and its effect on every member;
- who must use MFA (2), the sign-in step (1) and turning MFA off (1);
- the route (12), with the session gate and the domain running for real;
- the dashboard (4);
- the database (14): the column and its default, the change and its audit
  written together or not at all, every `STALE` case, two changes at once, and
  a demotion in flight that the change waits for and then sees;
- the shape test (2): migration 26's SQL, and that only the route calls
  `setMfaRequirement` and only the service calls the repository write.

### Mutation ledger

**32 run, 32 killed, 0 survivors, 0 broken**, in one pass on the code of
`5b8165d`. Each mutant weakens one guarantee at an anchor that occurs exactly
once. Mutants in the domain, route, dashboard and migration run the identity
and MFA domain tests, the web app's page and component tests and the MFA route
tests (565 tests); mutants in the database repository run the MFA and
organization-requirement database tests (36 tests). Every mutated file was
restored and re-hashed, and all 823 files were byte-identical afterwards.

| Mutant | Area | What it breaks | File | Tests failing |
| --- | --- | --- | --- | --- |
| Q01 | who must | an organization's requirement is ignored | `requirement.ts` | 5 of 565 (web) |
| Q02 | who must | an organization's requirement is inverted | `requirement.ts` | 10 of 565 (web) |
| G01 | who may | a MANAGER may change it | `requirement.ts` | 4 of 565 (web) |
| G02 | who may | an ADMIN may not change it | `requirement.ts` | 8 of 565 (web) |
| V01 | service | the role check is skipped | `organization-service.ts` | 6 of 565 (web) |
| V02 | service | a refusal is audited but not refused | `organization-service.ts` | 6 of 565 (web) |
| V03 | service | a refusal is audited as a change | `organization-service.ts` | 5 of 565 (web) |
| V04 | service | a change that changes nothing is written and audited | `organization-service.ts` | 1 of 565 (web) |
| V05 | service | a STALE write is reported as applied | `organization-service.ts` | 3 of 565 (web) |
| V06 | service | the change's audit loses the actor's role | `organization-service.ts` | 2 of 565 (web) |
| V07 | service | the returned organization keeps the old value | `organization-service.ts` | 2 of 565 (web) |
| V08 | service | a non-member is treated as a VIEWER, not refused access | `organization-service.ts` | 3 of 565 (web) |
| A01 | audit | the change is audited under another action | `audit.ts` | 5 of 565 (web) |
| T01 | wording | turning off is refused with the MFA-3 wording | `mfa-service.ts` | 1 of 565 (web) |
| D01 | database | the actor's membership is not locked | `repositories.ts` | 1 of 36 (db) |
| D02 | database | the actor's role is not checked | `repositories.ts` | 6 of 36 (db) |
| D03 | database | an ADMIN's change is STALE | `repositories.ts` | 1 of 36 (db) |
| D04 | database | no compare-and-set on the value | `repositories.ts` | 2 of 36 (db) |
| D05 | database | a write that matched nothing is APPLIED | `repositories.ts` | 2 of 36 (db) |
| D06 | database | the change is not audited | `repositories.ts` | 4 of 36 (db) |
| D07 | database | the value is not read back | `repositories.ts` | 1 of 36 (db) |
| M01 | migration | the column defaults to true | migration 26 | 1 of 565 (web) |
| W01 | route | no sign-in check | `mfa-requirement/route.ts` | 1 of 565 (web) |
| W02 | route | any non-empty value is accepted, as false | `mfa-requirement/route.ts` | 2 of 565 (web) |
| W03 | route | the value is inverted | `mfa-requirement/route.ts` | 4 of 565 (web) |
| W04 | route | an unexpected error's message is shown | `mfa-requirement/route.ts` | 1 of 565 (web) |
| W05 | route | success goes elsewhere | `mfa-requirement/route.ts` | 2 of 565 (web) |
| U01 | dashboard | every member gets the control | `src/app/page.tsx` | 2 of 565 (web) |
| U02 | dashboard | the control posts the current value | `src/app/page.tsx` | 2 of 565 (web) |
| U03 | dashboard | the status line is inverted | `src/app/page.tsx` | 4 of 565 (web) |
| U04 | dashboard | the control posts to another route | `src/app/page.tsx` | 2 of 565 (web) |
| U05 | dashboard | the button says the opposite | `src/app/page.tsx` | 2 of 565 (web) |


### Required documentation

| Item | Where |
| --- | --- |
| Architecture diagram | `docs/architecture.md` status table: an MFA-4 row |
| Entity-relationship diagram | `docs/er-diagram.md`: `organizations.mfaRequired` and an MFA-4 section |
| Critical sequence diagram | this section, *Requiring MFA of every member* |
| OpenAPI / API change summary | `docs/api-changes-mfa-4.md`. Internal API: `Organization.mfaRequired`, `OrganizationRepository.setMfaRequired`, `OrganizationService.setMfaRequirement` and `mayChangeMfaRequirement` (`@app/domain`) |
| Change log / release notes | the commit list above and the pull request description |
| Database migration notes | `docs/migration-notes.md`, *MFA-4*: migration 26, additive, nothing changes at deploy |
| Completion report | this file |

Also updated: ADR-0065 (Decisions 18 and 19), `docs/Roadmap.md` and
`docs/decisions/TODO.md`.

### Activation status

Nothing paid or scheduled is activated. MFA-4 adds one column, one route and a
dashboard control, and no dependency, worker, scheduler, credential or
environment variable. Paid Provider Activation, production credentials, the
production scheduler and live Stripe charges remain BLOCKED.

### Known limitations

- **No way back for a lost device and lost recovery codes.** Operator-assisted
  recovery is not built. Since MFA-4 this can also lock out a member of an
  organization that requires MFA, whatever their role.
- The five-wrong-codes guard is per sign-in. Until rate limiting exists
  (ADR-0054 Decision 5), someone with the password can sign in again and try
  more codes. Rate limiting should ship before MFA is relied on in production.
- Members learn of the requirement only at their next request; nothing tells
  them sooner, since there is no email-sending service.
- The web app still starts without `MFA_SECRET_KEY`; only the readiness probe
  reports it.
- The control is a single button on the dashboard. There is no organization
  settings page yet.

### Remaining work

With this pull request all four MFA pull requests are built; it waits for the
product owner's yes before merge. The choices and open questions in
`TODO.md` (ADR-0065 Decision 11 and *Not decided here*) stay for the product
owner. Next: Unit purchase.
