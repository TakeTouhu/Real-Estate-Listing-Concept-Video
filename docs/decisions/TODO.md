# Open decisions and unresolved items

Per `CLAUDE.md`: do not invent missing business rules — record them here.

## Must resolve before Phase 4 / production (WaveSpeedAI)

- [ ] Verify the **current** WaveSpeedAI API contract: submit endpoint path,
      request body fields, response envelope, and status vocabulary. The Phase 0
      mapping in `packages/video-providers/src/wavespeed/mapping.ts` is a
      best-effort candidate.
- [ ] Verify the webhook authentication/signature mechanism WaveSpeedAI
      currently supports (for `POST /internal/webhooks/wavespeed`).
- [ ] Confirm whether WaveSpeedAI supports cancellation, and the endpoint.
- [ ] Obtain real model capabilities, supported durations/resolutions/aspect
      ratios, concurrency limits, and **pricing** (placeholder pricing is used
      in `factory.ts`).
- [ ] Review WaveSpeedAI commercial-use terms, data handling, retention, and
      model policy before production launch.

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
