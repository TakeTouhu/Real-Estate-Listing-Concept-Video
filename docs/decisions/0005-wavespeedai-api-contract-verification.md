# ADR-0005: WaveSpeedAI public API contract verification (2026-07)

- Status: Accepted (snapshot)
- Date: 2026-07-27
- Phase: 0

## Context

Phase 0 requires verifying the current WaveSpeedAI public API documentation and
updating `docs/WaveSpeedAIIntegration.md` only if the official specification has
changed, recording any differences here or in `docs/decisions/TODO.md`. No
integration code is written in Phase 0.

## Verification snapshot

Checked against the official WaveSpeedAI documentation (wavespeed.ai/docs) on
2026-07-27. Full page bodies were not machine-fetchable (the docs host returned
403 to automated fetches); the following was confirmed via the documentation
search index and public model/API pages.

| Aspect | Official docs (2026-07) | Matches `WaveSpeedAIIntegration.md`? |
| --- | --- | --- |
| Base URL | `https://api.wavespeed.ai/api/v3` | ✅ |
| Submit endpoint | `POST /api/v3/{model_id}` | ✅ (model-per-path) |
| Auth | `Authorization: Bearer <API_KEY>`, `Content-Type: application/json` | ✅ |
| Common inputs | `prompt`, `image`, `resolution`, `duration`, `seed` | ✅ |
| Result endpoint | `GET /api/v3/predictions/{id}/result` (from `urls.get`) | ✅ |
| Response envelope | `data.{ id, status, outputs[], urls.get, timings }` | ✅ |
| Status values | `created`, `processing`, `completed`, `failed` | ✅ (normalized in the interface's state set) |
| Delivery | synchronous result **or** webhook callback | ✅ |
| Polling guidance | ~2s images, ~5s video, back off for long tasks | ✅ (poll defaults compatible) |

## Decision

- `docs/WaveSpeedAIIntegration.md` is **unchanged**: the official specification
  matches what is already documented.
- No API differences requiring a spec edit were found.

## Notes carried to TODO (confirm before Phase 1 completion / production)

- Exact **webhook signature/verification** mechanism (docs page not fetchable
  here).
- Whether **cancellation** is supported and its endpoint.
- Real **pricing**, model capabilities/limits, and commercial-use terms.
- Consider defaulting video polling to ~5s (`WAVESPEED_POLL_INITIAL_MS`) per the
  docs' video guidance when the provider is implemented.
