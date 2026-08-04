# API Changes — Phase 3C-5

Three endpoints complete the storyboard HTTP surface: create a project, compose
its storyboard, read it back. All are session-authenticated (`rev_session`
cookie) with `organizationId` supplied by the caller and membership verified
server-side by `authorizeOrganization` (ADR-0010).

## Endpoints

### `POST /api/properties/{propertyId}/video-projects` — create (3C-5a)

```jsonc
{
  "organizationId": "org_…",
  "name": "Walkthrough",
  "durationSeconds": 30,
  "aspectRatio": "16:9",
  "resolution": "1080p",
  "prompt": "bright and airy",        // optional
  "negativePrompt": "no harsh shadows", // optional
  "cameraMotion": "SLOW_PAN"          // optional
}
```

Permission `property:write`. Returns `201` with the project DTO.

Lifecycle state is **not accepted**: `status`, `compositionFingerprint`, and
scenes cannot be supplied. Every project starts `DRAFT`, unfingerprinted, and
sceneless.

### `GET /api/properties/{propertyId}/video-projects` — list (3C-5b)

`?organizationId=org_…` → `200` with `{ projects: VideoProjectDto[] }`.

Discovery only, so the UI can reload a property and find its projects through
the API. Any organization member may read. Ordering is the repository's
(creation order). **No pagination, filtering, sorting, or "active project"
notion.**

### `POST /api/video-projects/{projectId}/storyboard` — compose (3C-5b)

```jsonc
{ "organizationId": "org_…", "minSceneSeconds": 2, "maxSceneSeconds": 10 }
```

Permission `property:write`. Returns `200` with the read shape below and
`fresh: true` — a storyboard just composed matches the inputs it was composed
from by definition.

The route validates only that both bounds are positive whole numbers. Which
photos are eligible, how scenes are ordered, whether the requested total fits,
and whether the prompt passes moderation are all decided by `StoryboardService`
and the Phase 3C primitives.

**The bounds are temporary orchestration inputs, not provider capabilities.**
Phase 4 must validate duration, aspect ratio, resolution, and provider
capability against the configured model before any provider call
(`docs/decisions/TODO.md`).

### `GET /api/video-projects/{projectId}/storyboard` — read (3C-5b)

`?organizationId=org_…` → `200`:

```jsonc
{
  "project": { "id": "vpr_…", "status": "STORYBOARD_READY", … },
  "scenes": [
    {
      "id": "scn_…",
      "assetId": "ast_…",
      "position": 1,
      "durationSeconds": 4,
      "roomType": "KITCHEN",
      "sourceAnalysisRevision": 1
    }
  ],
  "fresh": true
}
```

Any organization member may read. A project that has never been composed returns
`scenes: []` and `fresh: false` — existing semantics, with **no status invented**
for the case.

`fresh` is derived at read time by recomputing the canonical fingerprint of the
current approved inputs and comparing it with the stored one. It turns `false`
when an approval is added or removed or an analysis is re-run. The fingerprint
itself is never returned: a client cannot recompute it and has no use for it.

## What is never returned

`organizationId`, `compositionFingerprint`, `createdBy`, `compiledPrompt` (raw
or parsed), preservation constraints, system negative constraints, moderator
identity, provider names, and storage keys.

The compiled prompt is server-side generation data that Phase 4 consumes in
process (ADR-0014); the scene DTO carries only what the product UI needs.

## Status codes

| Code | When |
| --- | --- |
| `200` | Compose or read succeeded |
| `201` | Project created |
| `401` | No session |
| `403` | Not a member, or role lacks `property:write` (create and compose) |
| `404` | Unknown property or project, **or one in another organization** |
| `422` | Malformed body or query; fewer than three approved photos; a requested duration outside the achievable range (carrying `minimumAchievableDuration` and `maximumAchievableDuration`); a moderation rejection (carrying `{ field, code }` findings and no prompt text) |
| `500` | Unexpected internal error (envelope only) |

A foreign property or project returns `404`, never `403`: existence in another
tenant is never disclosed.

## Not included

- No `PATCH`, delete, recompose, freshness-only, or scene-editing endpoint —
  `POST …/storyboard` already serves recomposition, and `fresh` rides on the read.
- No provider settings, admin, or debug endpoints.
- No rate limiting — still the cross-cutting item in `docs/decisions/TODO.md`.
