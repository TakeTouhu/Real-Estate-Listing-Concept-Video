# Gap analysis — authenticator-app MFA (after Phase 6I)

Base: `main @ 108ecc0` (PR #84, Phase 6I-2; post-merge CI run 547 green).
Contract: ADR-0052 Decision 18, `docs/SecurityCompliance.md` (identity and
access). Approved by the product owner on 2026-10-15 as four pull requests with
no grace period (`/mnt/project-files/cto/mfa-proposal.md`).

## What the contract requires

- Email and password sign-in with mandatory email verification, plus
  **authenticator-app (TOTP) MFA and recovery codes**.
- MFA is **mandatory** for `OWNER`, `ADMIN`, and any holder of
  `permission.manage` or `billing.manage`, however it was granted. `BILLING` is
  therefore mandatory. Other users may turn it on; an organization may require it
  for all members.
- MFA changes, recovery and security-sensitive identity events are audited.
- No step-up or re-authentication mechanism (ADR-0052 Decision 10).
- Rate limiting on login, password reset and MFA recovery (ADR-0054 Decision 5).
- The Roadmap and `TODO.md`: MFA before any member, permission, group or
  assignment screen.

## What is implemented on the base

| Piece | State on `108ecc0` | Where |
| --- | --- | --- |
| Email and password sign-in | built: scrypt password hash, `AuthService.login` | `auth-service.ts` |
| Sessions | built: random token, only its SHA-256 stored, 7-day lifetime, deleted on sign-out | `sessions` table, `AuthService.resolveSession` |
| The one place a request becomes a signed-in user | `getCurrentUser()` → `resolveSession()`, used by all 19 route and page files that need one | `apps/web/src/lib/auth.ts` |
| Effective permissions per membership (template, grants, groups) | built | `effectivePermissionsOf` |
| MFA, recovery codes | **not built**: no table, no service, no screen | — |
| Email verification, password reset | **not built** | — |
| Rate limiting | **not built** anywhere | open `TODO.md` item |

## The gap and how it is split

| PR | What it does | Visible? |
| --- | --- | --- |
| **MFA-1** (this) | migration 25; TOTP, sealed secrets and recovery codes; `MfaService` (set up, confirm, verify, new codes, turn off) with audit; who must use MFA; `MFA_SECRET_KEY` | no: no route calls it |
| MFA-2 | the screens; two-step sign-in for anyone with MFA on; the security page; `qrcode` | only for people who turn it on |
| MFA-3 | mandatory MFA: a session that must pass MFA and has not reaches only the MFA screens and sign-out | every `OWNER` sets up MFA at next sign-in |
| MFA-4 | an organization's "require MFA for all members", changed by an `OWNER` or `ADMIN` | only when turned on |

## MFA-1 plan

1. **Migration 25**: `user_mfa_factors` (one per user while MFA is on),
   `user_mfa_recovery_codes` (hashes only, removed with the factor), and three
   `sessions` columns (`mfaVerifiedAt`, `mfaFailedAttempts`, `mfaPendingSecret`).
2. **`@app/shared`**: HOTP (RFC 4226), base32 (RFC 4648), AES-256-GCM sealing,
   a key fingerprint, secure random bytes. Node `crypto` only.
3. **`@app/domain/mfa`**: TOTP matching with ±1 step and no reuse, recovery-code
   generation and normalization, `isMfaRequired`, the cipher adapter and
   `MfaService`; the `MfaRepository` port; the audit actions.
4. **`@app/database`**: `createPrismaMfaRepository`, each change one transaction
   with its audit row, session row locked before the factor row.
5. **In-memory double** with the same outcomes, for the unit suites.
6. **`MFA_SECRET_KEY`**: optional, 64 hex characters.

Size estimate in the proposal: about 350 production and 500 test lines.

## Found while reading the base

- **Moving to a new device.** The proposal let only an optional user turn MFA
  off. A person who must use MFA and changes phone would then have no way to
  move it. MFA-1 lets a session that passed MFA set it up again; the new
  authenticator replaces the old one (ADR-0065 Decision 6). Recorded in
  `TODO.md` as a choice.
- **The `OWNER`/`ADMIN` role clause is redundant today**: both templates hold
  `permission.manage`. It is kept so the rule names what ADR-0052 names; no test
  can tell it apart from the permission clause.

## Not in MFA-1

Every route and screen (MFA-2), enforcement (MFA-3), the organization setting
(MFA-4), email verification and password reset, rate limiting, operator-assisted
recovery, key rotation.

## Verification plan

The same checks as Phase 6I: lint, typecheck, unit, database, build, migration
drift and status, and a mutation pass in which each mutant weakens one MFA
guarantee (the drift window, single use, the wrong-code limit, sealing, the
hash-only storage, who may set up, regenerate or turn off, what is audited).
New PostgreSQL tests prove each write commits with its audit row or not at all,
and that concurrent codes are accepted, or counted, exactly once.
