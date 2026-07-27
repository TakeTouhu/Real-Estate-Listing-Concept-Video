# Open decisions and unresolved items

Per `CLAUDE.md`: do not invent missing business rules — record them here.

## WaveSpeedAI

- [x] Verify the current WaveSpeedAI public API contract (submit path, result
      path, response envelope, status vocabulary, polling guidance). Done
      2026-07-27 — matches `docs/WaveSpeedAIIntegration.md`; see ADR-0005.
      `docs/WaveSpeedAIIntegration.md` left unchanged.
- [ ] Confirm the webhook authentication/signature mechanism WaveSpeedAI
      currently supports (for `POST /internal/webhooks/wavespeed`). The docs
      page was not machine-fetchable during Phase 0 verification.
- [ ] Confirm whether WaveSpeedAI supports cancellation, and the endpoint.
- [ ] Obtain real model capabilities, supported durations/resolutions/aspect
      ratios, concurrency limits, and **pricing** (placeholder pricing to be
      wired when `WaveSpeedVideoProvider` is implemented in Phase 1).
- [ ] Review WaveSpeedAI commercial-use terms, data handling, retention, and
      model policy before production launch.
- [ ] Implement `WaveSpeedVideoProvider` (submission, status normalization,
      webhook verification, bounded polling, managed-storage copy) in **Phase 1**
      — deferred out of Phase 0 per project instruction and ADR-0003.

## Business rules to confirm (later phases)

- [ ] Credit pricing model and platform margin (Phase 6).
- [ ] Plan definitions: users, storage, monthly credits, concurrency,
      retention, branding, support tiers (Phase 6 / SaaSOperations).
- [ ] Asset/output retention windows and deletion recovery period (Phase 2/5).
- [ ] Exact AI-generated disclosure text and placement rules beyond the default
      `AI生成イメージ` (Phase 5).
- [ ] Supported authentication providers (email vs Entra ID / Google) for
      Phase 1.

## Phase 0 interim choices to revisit

- [ ] Replace the interim operator-token auth (ADR-0004) with real identity,
      RBAC, and organization scoping (Phase 1).
- [ ] Introduce OpenTelemetry exporters; the Phase 0 logger is a local
      structured logger with redaction only.
