# ADR-0150 — The web app's adapters in one place

Status: Accepted (RD-1, 2026-11-16). The first milestone of production
readiness, part 1, which the product owner approved on 2026-11-16
(`/mnt/project-files/cto/production-readiness-proposal.md`; gap analysis
`docs/production-readiness-gap-analysis.md`).

Builds on: ADR-0008 (storage and scanner ports, the production guard),
ADR-0009 (offline analysis), ADR-0014 (offline prompt moderation), ADR-0085
(the shared folder), ADR-0126 (the email port and outbox), ADR-0129 (the
mailer).

## Context

The web app serves five ports through adapters: object storage, malware
scanning, email, image analysis and prompt moderation. Each service picked
its own, in four files:

| Port | Chosen in | Adapters on the base |
| --- | --- | --- |
| Object storage | `apps/web/src/lib/property.ts` | the shared folder when `SHARED_STORAGE_DIR` is set, otherwise memory |
| Malware scanning | `apps/web/src/lib/property.ts` | `PassthroughMalwareScanner` |
| Email | `apps/web/src/lib/mailer.ts` | the outbox when `EMAIL_OUTBOX_DIR` is set, otherwise none |
| Image analysis | `apps/web/src/lib/analysis.ts` | deterministic (`ANALYSIS_PROVIDER`) |
| Prompt moderation | `apps/web/src/lib/storyboard.ts` | offline |

The plan adds a production adapter to three of them (Google Cloud Storage,
ClamAV, SMTP) and, in RD-2, checks the whole set when the app starts. Both
need one place that knows every choice.

## Decision 1 — One module chooses and builds every adapter

`apps/web/src/lib/adapters.ts`:

- **`chooseWebAdapters(env)`** names the adapter of each port from the
  environment alone and builds nothing. The choices are the ones on the
  base, unchanged.
- **`createWebAdapters(env)`** returns the choice and one function per port.
  Each function builds its adapter when first called and keeps it, so a
  request that needs no storage builds none, as before. The email function
  opens the outbox for each message, as the mailer did (ADR-0129).
- **`getWebAdapters()`** is the web app's one set, from its configured
  environment.

The property, analysis and storyboard services take their adapters from
`getWebAdapters()`. The mailer takes its email adapter from
`createWebAdapters` on each use, as it read the environment on each use.

A production adapter is then one more choice in this module, with no change
to the services, routes or pages that use the port.

## Decision 2 — The production guard reads both values

Every development adapter refuses `NODE_ENV=production` when it is built
(ADR-0008). The module gives each the configured value, or `production`
when the ambient value says so: neither can vouch for the other, as the
shared folder and the outbox already hold (ADR-0085, ADR-0126). Before, the
in-memory storage and the test scanner read only the ambient value.

## Decision 3 — What this does not change

- No adapter is added, and no choice changes: the same environment builds
  the same adapters.
- The video provider is not one of these ports. The generation start is
  built only for the test provider, outside production (ADR-0111), and
  readiness builds the configured provider for its self-check; both stay as
  they are until paid activation is authorized (ADR-0054 Decision 7).
- The offline analysis and prompt moderation stay allowed in production, as
  on the base: no decision keeps them out. Replacing them is tracked in
  `docs/decisions/TODO.md` (Phase 3C-3, and "Open in RD-1" for ADR-0052
  Decision 15).
- The worker has no production runtime yet; its adapters are assembled with
  it, in part 2 of the plan.

## Consequences

- No route, page, migration, permission or audit action changes.
- `apps/web/src/lib/property.test.ts` becomes `adapters.test.ts`, which also
  covers the choice of every port, building each adapter once, the email
  adapter, and the production guard by either value.
