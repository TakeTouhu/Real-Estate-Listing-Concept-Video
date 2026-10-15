# Completion — MFA (authenticator app and recovery codes)

Branch: `claude/project-thread-az06z2`
ADR: `docs/decisions/0065-authenticator-mfa.md`
Gap analysis: `docs/mfa-gap-analysis.md`

MFA is built in four pull requests, approved by the product owner on
2026-10-15 with no grace period: MFA-1 (the foundation, this section), MFA-2
(the screens and two-step sign-in), MFA-3 (mandatory MFA) and MFA-4 (an
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
| *(this commit)* | this record: the review, the verification and mutation ledger on the reviewed code |

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
