# Gap analysis — production readiness, part 1

Base: `main @ 148b6f6` (PR #173, AT-12; post-merge CI run 976 green).
Plan: `/mnt/project-files/cto/production-readiness-proposal.md`, approved by
the product owner on 2026-11-16 with its defaults. Each pull request still
needs the product owner's yes before merge.

The plan works toward Phase 7's scope (`docs/Roadmap.md`) but is not the
whole phase, so it receives no `phase-N-complete` tag.

## What the plan must reach

A production build, started against local stand-ins for Google Cloud (a
storage emulator, a mail catcher, ClamAV), lets a person sign up, verify
their address, upload photos that are scanned and stored, and invite a
colleague, with every development adapter refused and every sensitive
request rate-limited. Nothing is deployed, no email leaves a machine, and no
paid service, outside account or credential is used. Paid Provider
Activation, production Provider credentials, production paid AI calls,
production scheduler activation and live Stripe charges stay BLOCKED
(ADR-0054 Decision 7).

## What a production build does on the base

| Piece | State on `148b6f6` | Where |
| --- | --- | --- |
| Choosing the web app's adapters | each service picks its own, in four files (*one place since RD-1, ADR-0150*) | `apps/web/src/lib/property.ts`, `mailer.ts`, `storyboard.ts`, `analysis.ts` |
| Object storage | in-memory (ADR-0008) or the development shared folder (ADR-0085), both refused in production; no Google Cloud Storage adapter | `@app/storage` |
| Malware scanning | `PassthroughMalwareScanner`, which knows only the EICAR test file, refused in production (ADR-0054 Decision 5) | `@app/storage` `scanner.ts` |
| Email | the development outbox (ADR-0126), refused in production; with none, sign-up cannot send its verification link (ADR-0129) | `apps/web/src/lib/mailer.ts` |
| Rate limiting | none, beyond locking an MFA sign-in after five wrong codes | |
| Start-up checks | the environment schema refuses the development folders in production; an adapter refuses only when first built; `MFA_SECRET_KEY` is optional (*a production start is checked since RD-2a, ADR-0151*) | `@app/shared` `env.ts` |
| Readiness | a provider self-check and whether the MFA key is set; not the database or storage (*both are asked since RD-2b, ADR-0152*) | `apps/web/src/lib/health.ts` |
| Same-origin check | on 20 of the 45 route files with a mutating handler; sign-in, sign-up, password reset, email verification, MFA, organization creation, uploads, analysis review, storyboard and video projects rely on `SameSite=Lax` alone (the entry in `docs/decisions/TODO.md` still names two routes) | `apps/web/src/lib/same-origin.ts` |
| Security headers | none app-wide; the download route sets its own `Content-Security-Policy` and `nosniff` | `apps/web/src/app/api/storage/download/route.ts` |
| Container images | none; `infra/` holds a README only | |
| Image analysis, prompt moderation | the offline adapters (ADR-0009, ADR-0014); not refused in production, and not replaced by this plan | `@app/ai-providers`, `@app/domain` |
| Content moderation (ADR-0052 Decision 15) | **none**: no check for the prohibited-content categories, of prompts or photos | |

## The milestones

Eleven pull requests. Each is split further where it would exceed about 500
changed lines.

| PR | What | Migration |
| --- | --- | --- |
| RD-1 | The web app's adapters chosen in one place (ADR-0150) | none |
| RD-2 | Boot-time check of adapters and secrets (*RD-2a, ADR-0151*); readiness checks the database and storage (*RD-2b, ADR-0152*); how those checks are limited (*RD-2c*); a start RD-2a could not check (*RD-2d*) | none |
| RD-3 | Google Cloud Storage adapter for the web storage port, tested on an emulator | none |
| RD-4 | Google Cloud Storage for the worker's copy and deliverable writes | none |
| RD-5 | ClamAV scanner, with ClamAV in CI | none |
| RD-6 | SMTP email adapter, tested with a mail catcher | none |
| RD-7 | Rate limiter in PostgreSQL; sign-in, reset, verification resend, MFA | 1 |
| RD-8 | Rate limits on invitations, uploads, analysis, generation start, downloads, Unit purchase | none |
| RD-9 | Same-origin on every cookie-based change; security headers | none |
| RD-10 | Container images for the web app and the worker, built in CI | none |
| RD-11 | A production-mode test against the emulators; completion report | none |

The worker has no production runtime on the base: its start file runs a
provider self-check and exits, and every runner is assembled only in the
development pipeline, which refuses production (ADR-0106 to ADR-0108). Its
production assembly belongs to part 2, with that runtime. RD-4 makes its
storage seam work on Google Cloud Storage for part 2 to use.

## Defaults the product owner approved

1. Signed links stay the app's own; every byte passes through the app.
2. Rate limits start at documented, configurable values: sign-in 5 failures
   per 15 minutes per account and per IP, then a growing cooldown; reset and
   verification emails 3 per hour per address.
3. A production build refuses to start without `MFA_SECRET_KEY`.
4. ClamAV, self-hosted.
5. SMTP, so the email adapter is ready for whichever service is chosen.

## Decisions outside this plan

Listed in the proposal for the product owner, and not needed by any
milestone here: the email service and sending domain; the Google Cloud
project and region; a content-moderation vendor for ADR-0052 Decision 15;
the primary provider route. `docs/decisions/TODO.md` tracks each.
