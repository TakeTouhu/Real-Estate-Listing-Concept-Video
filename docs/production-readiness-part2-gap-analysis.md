# Gap analysis — production readiness, part 2

Base: `main @ 460931a` (PR #219, RD-11c, the completion report of part 1).
Plan: `/mnt/project-files/cto/part2/proposal.md`, approved by the product
owner on 2026-11-26 at 04:38Z. Its milestones merge under the product
owner's standing approval of 2026-11-16 08:08Z: once CI is green on the
head, an independent review finds nothing blocking and no thread is open.
What the plan leaves BLOCKED stays BLOCKED until it is explicitly
authorized (ADR-0054 Decision 7): paid provider and moderation calls and
their keys, deploys, and the production scheduler.

The plan works toward Phase 7's scope (`docs/Roadmap.md`) but is not the
whole phase, so it receives no `phase-N-complete` tag.

## What the plan must reach

First, what production uploads need: an organization with no plan cannot
upload, and each organization has a storage cap with warnings at 80% and
90% and, at 100%, no new upload or video start (the product owner's
decision of 2026-11-26 at 00:15Z). Then the cloud setup as code, checked
offline, the operator tools production needs, and what part 1 left open.
Whether production opens for uploads before video generation exists is
the product owner's decision, not this plan's.

Second, the generation runtime behind the provider-neutral port, proven
against local stand-ins and not turned on: polling, bounds so a Unit is
never held forever, moderation refusal that consumes no Unit, the internal
recovery budget, defect records, operator recovery and cost inputs.

## What the base does

| Area | State on `460931a` | Where |
| --- | --- | --- |
| Upload with no plan | allowed | `packages/domain/src/property/asset-service.ts:82-139` |
| Storage quota | no catalog field, no usage figure, no declared size kept, the original's size lost | |
| Production video start | not built; the start route answers "not found" outside the fake kit | `apps/web/src/lib/generation-start.ts:19-25` |
| Infrastructure code, deploy | none; CI's image guard bans push and secrets | `tests/container-images.test.ts` |
| Migrations in production | no image or job | |
| Logs | `level`, not Cloud Logging's `severity` (*`severity` by LogSeverity's names, reserved keys dropped, since PT-7a, ADR-0181; now in `logger.ts` `emit()`*) (*message a constant and through `redact`, a URL's user name and password dropped, since PT-7a2, ADR-0182*) | `packages/observability/src/logger.ts:37-42` |
| CI | two runs per commit; `database` and `e2e` on a floating `postgres:16` (*one run per commit, one pinned PostgreSQL since PT-6a, ADR-0179*) | `.github/workflows/ci.yml` |
| Dependencies | no image scanner; `sharp`, `postcss` and `zod` advisories (*`sharp` and `postcss`'s `nanoid` and `source-map-js` fixed since PT-6c; each image scanned with pinned Syft and Grype, failing on a fixable critical finding, since PT-6b, ADR-0180; `zod` 4.6.7 since PT-6d*) | `TODO.md` |
| Worker runtime | exits 2 in production; development pipeline only | `apps/worker` |
| Bounds, moderation, recovery budget | none; a Unit can be held forever | |

## Order

Launch gates (PT-1 to PT-5) wait on the product owner's answers to the
seventeen questions sent on 2026-11-26. Meanwhile the platform milestones
that need no answer and no account go first, starting with PT-6a.
