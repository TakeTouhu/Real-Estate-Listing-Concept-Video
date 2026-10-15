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
| *(this commit)* | ADR-0065, the gap analysis, this record and the documentation updates |

The exact head SHA is reported with the pull request rather than written into a
file that would have to contain its own hash.

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

Measured on the committed tree `e1bf125560c71dfefafc5f5d90203dd1e547a272` (commit `9c0858b29d7e0d085cab45f60332e3a4f17dd605`), against a local
PostgreSQL 16 configured like CI. The later commit changes documentation only.

| Check | Result |
| --- | --- |
| `pnpm lint` / `pnpm typecheck` | clean |
| `pnpm test` | **5195 / 5195, 174 files** (MFA: service 23, primitives 19, shape 5, in-memory double 5, `@app/shared` crypto 10, environment 6) |
| `pnpm test:db` | **1348 / 1348, 48 files** (the MFA suite: 20) |
| `pnpm build` | Next.js production build succeeded |
| `prisma migrate diff` (migrations → schema) | no difference |
| `prisma migrate status` | 26 migrations, schema up to date |

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
  secret in the audit log.
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
  one winning.

### Mutation ledger

Each mutant weakens one MFA guarantee at an anchor that must occur exactly
once, and runs against the suites listed for it. Every mutated file is restored
and re-hashed. A SHA-256 manifest of all 798 files in the working tree is
compared before and after the pass. A kill counts only when tests ran and
failed; a mutant that does not parse would count as broken.

**Authoritative: 43 run, 43 killed, 0 survivors, 0 broken, 0 anchor-missing**,
in one uninterrupted pass against the tree `e1bf125560c71dfefafc5f5d90203dd1e547a272` (commit
`9c0858b29d7e0d085cab45f60332e3a4f17dd605`). All 798 files were byte-identical after the pass.

A first pass on `369c654` killed 42 of the same 43. M01 survived: the service
drops steps already used before it reaches the repository, so no service test
reached the in-memory double's own single-use guard. `9c0858b` adds tests that
call the double directly, and they kill it.

| # | Area | Mutation | File | Killed by |
| --- | --- | --- | --- | --- |
| C01 | hotp | dynamic truncation always reads offset 0 | `mfa-crypto.ts` | unit: 2 failed of 388 |
| C02 | base32 | the last partial group is dropped | `mfa-crypto.ts` | unit: 1 failed of 388 |
| C03 | sealing | every secret is sealed with the same IV | `mfa-crypto.ts` | unit: 1 failed of 388 |
| A01 | sealing | a sealed secret is not bound to its user | `adapters.ts` | unit: 1 failed of 388 |
| A02 | sealing | the key id is not checked | `adapters.ts` | unit: 1 failed of 388 |
| T01 | totp | no drift: only the current step | `totp.ts` | unit: 4 failed of 388 |
| T02 | totp | two steps ahead accepted | `totp.ts` | unit: 2 failed of 388 |
| T03 | totp | the last step used is offered again | `totp.ts` | unit: 1 failed of 388 |
| T04 | totp | any six digits match | `totp.ts` | unit: 10 failed of 388 |
| R01 | recovery | O, I and L are not read back | `recovery-codes.ts` | unit: 1 failed of 388 |
| R02 | recovery | a code is stored as typed | `recovery-codes.ts` | unit: 1 failed of 388 |
| R03 | recovery | 8 codes in a set | `recovery-codes.ts` | unit: 5 failed of 388 |
| R04 | recovery | 40-bit codes | `recovery-codes.ts` | unit: 20 failed of 388 |
| Q01 | requirement | billing.manage does not make MFA mandatory | `requirement.ts` | unit: 1 failed of 388 |
| Q02 | requirement | only the first organization is read | `requirement.ts` | unit: 1 failed of 388 |
| Q03 | requirement | grants and groups are ignored | `requirement.ts` | unit: 2 failed of 388 |
| S01 | service | a session that has not passed MFA may replace it | `mfa-service.ts` | unit: 1 failed of 388 |
| S02 | service | an ended session passes silently | `mfa-service.ts` | unit: 1 failed of 388 |
| S03 | service | wrong codes never end the sign-in | `mfa-service.ts` | unit: 2 failed of 388 |
| S04 | service | six wrong codes allowed | `mfa-service.ts` | unit: 1 failed of 388 |
| S05 | service | new recovery codes without having passed MFA | `mfa-service.ts` | unit: 1 failed of 388 |
| S06 | service | turning off without having passed MFA | `mfa-service.ts` | unit: 1 failed of 388 |
| S07 | service | someone who must use MFA turns it off | `mfa-service.ts` | unit: 1 failed of 388 |
| S08 | audit | the recovery code used is audited | `mfa-service.ts` | unit: 2 failed of 388 |
| S09 | audit | the new recovery codes are audited | `mfa-service.ts` | unit: 2 failed of 388 |
| S10 | audit | moving to a new device is audited as turning on | `mfa-service.ts` | unit: 1 failed of 388 |
| S11 | service | the otpauth URI names no issuer | `mfa-service.ts` | unit: 1 failed of 388 |
| P01 | repository | an authenticator code is accepted again | `mfa-repository.ts` | db: 1 failed of 20 |
| P02 | repository | using a recovery code does not lock the factor | `mfa-repository.ts` | db: 1 failed of 20 |
| P03 | repository | the limit counts one more wrong code | `mfa-repository.ts` | db: 3 failed of 20 |
| P04 | repository | a lock-out keeps the session | `mfa-repository.ts` | db: 2 failed of 20 |
| P05 | repository | an unpassed session's set-up replaces the factor | `mfa-repository.ts` | db: 1 failed of 20 |
| P06 | repository | set-up enables a secret the session does not hold | `mfa-repository.ts` | db: 1 failed of 20 |
| P07 | repository | turning off accepts a used step | `mfa-repository.ts` | db: 1 failed of 20 |
| P08 | repository | a code accepted does not reset the count | `mfa-repository.ts` | db: 1 failed of 20 |
| P09 | repository | set-up does not pass the session | `mfa-repository.ts` | db: 1 failed of 20 |
| P10 | atomicity | accepting a code survives a failed audit write | `mfa-repository.ts` | db: 1 failed of 20 |
| P11 | atomicity | set-up survives a failed audit write | `mfa-repository.ts` | db: 1 failed of 20 |
| M01 | double | the in-memory double accepts a code again | `in-memory-mfa.ts` | unit: 1 failed of 388 |
| X01 | migration | recovery codes may be stored as typed | `migration.sql` | unit: 1 failed of 388 |
| X02 | migration | recovery codes outlive the factor | `migration.sql` | unit: 1 failed of 388 |
| E01 | environment | a 16-byte key is accepted | `env.ts` | unit: 1 failed of 388 |
| D01 | dormancy | a web module reaches the MFA service | `auth.ts` | unit: 1 failed of 388 |

"unit" is `packages/shared/src/`, `packages/domain/src/mfa/`,
`packages/domain/src/identity/` and `in-memory-mfa.test.ts` (388 tests).
"db" is `tests/integration/mfa.db.test.ts` (20 tests). X01, X02 and D01 are
killed by the shape test, which reads the migration and the application sources
as text. P02 is killed by a concurrent test (five recovery codes used at once
must report 5 to 9 left); it killed P02 in both passes, but a race can in
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
