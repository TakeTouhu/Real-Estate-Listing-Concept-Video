# API Changes — GS-11b

A project's video on its project page (ADR-0114). **No migration, no route
and no environment variable.**

## HTTP

No API route is added or changed.

## Pages

### Changed: `GET /properties/{propertyId}/video-projects/{projectId}`

A "Video" panel after the start's notice and before the project's settings,
for a project that has a video (ADR-0113's read, as the signed-in member, in
the organization whose storyboard the page shows). It is shown wherever the
page is; a project with no video shows nothing new.

| The video | The panel shows |
| --- | --- |
| queued, generating scenes, composing or validating | the phase, quality and length, how many scenes are made, its Units "reserved for it, used only if it is delivered" (or that they came back, or that it reserved none), that the page shows the progress when it was loaded, and its support reference |
| completed | the phase, quality and length, the Units it used, and its support reference |
| failed or cancelled | the phase, quality and length, ADR-0052's message in Japanese (`lang="ja"`), what became of its Units, whether the project can be started again (ADR-0110), and its support reference |
| one the read will not describe (ADR-0113 Decision 4) | "This video's progress could not be read." and its support reference |

The panel has no control: nothing on it retries the video.

## Internal API

### Added: `apps/web`, `getVideoProgressService()` and `readVideoProgress(service, actor, organization, project)`

In `apps/web/src/lib/video-progress.ts`: the read wired to PostgreSQL, and the
page's read of it. A project with no video is `{ kind: "NONE" }`; a video the
read refuses to describe is `{ kind: "UNREADABLE", supportReference }`, from
the refusal's details; every other failure is thrown to the page.

### Added: `apps/web`, `videoProgressPanel(read)`, `unitsOf(count, quality)`, `PHASE_NAMES`, `NOT_DELIVERED_MESSAGE`

In `apps/web/src/lib/video-progress-view.ts`: the panel's words for what was
read, or `null` for a project with no video.

### Added: `apps/web`, `VideoProgressPanel`

In `apps/web/src/app/properties/[propertyId]/video-projects/[projectId]/video-progress-panel.tsx`:
the panel's markup.

### Changed: `apps/web`, `StoryboardView`

A new property, `progress`: the panel, or `null` when the project has no
video.
