# API Changes — GS-4a

A storyboard is saved in one commit (ADR-0086). **No migration, no route and no
page.** The storyboard routes answer exactly as before.

## HTTP

No change. `POST /api/video-projects/{projectId}/storyboard` returns the same
project and scenes, now as the one commit left them.

## Internal API

### Changed: `@app/domain` storyboard ports

| Before | After |
| --- | --- |
| `StoryboardSceneRepository.replaceForProject(org, project, scenes): StoryboardScene[]`, replacing the scenes only; `compose` then called `projects.update` to mark the project | `StoryboardSceneRepository.saveComposition(org, project, { scenes, compositionFingerprint }): SavedComposition`, replacing the scenes and marking the project `STORYBOARD_READY` with the fingerprint in one commit; throws for another tenant's project, writing nothing |

Added types: `StoryboardComposition` (`scenes`, `compositionFingerprint`) and
`SavedComposition` (`project`, `scenes`). `ComposedStoryboard`, what
`StoryboardService.compose` returns, is now `SavedComposition`.

### Changed: `@app/database`

`createPrismaStoryboardRepositories(prisma).scenes.saveComposition` locks the
project row `FOR NO KEY UPDATE`, scoped to the organization, as its first
statement, then deletes and inserts the scenes and updates the project in the
same transaction.
