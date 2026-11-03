# ADR-0114 — A project's video on its project page

Status: Accepted (GS-11b, 2026-11-04). The second and last milestone of row
GS-11 of the generation-to-preview plan the product owner approved on
2026-10-26 (`/mnt/project-files/cto/generation-e2e-proposal.md`: "the project
page shows progress in plain states: waiting, generating scenes, composing,
checking, done or failed. It never names a provider or model"). Builds on
ADR-0113 (the read) and ADR-0110 (one video of a project at a time).

## Context

ADR-0113 reads a project's newest video for any member who can read its
storyboard: its phase in UXFlow's words, what became of its Units, how many
scenes are made and its id as the support reference. Nothing shows it.

UXFlow ("Error recovery") asks every failure screen for a reason the customer
understands, whether the Unit was consumed or released, whether the video can
be started again and a support reference id, with no control that retries the
failed video. ADR-0052 (Decisions 5 and 19) fixes its message for every
failure that delivers no video, whatever its class:
「動画を正常に生成できませんでした。今回の生成ではUnitは消費されていません。」
The site's copy is English.

## Decision 1 — The project page shows its video

The project page reads its project's newest video (ADR-0113) as the signed-in
member, in the organization whose storyboard it shows, right after the
storyboard. A project with no video shows nothing new. The panel sits after
the start's notice and before the project's settings.

**It is shown wherever the page is, not only where the start is built**
(ADR-0111, ADR-0112). It only reads, and where nothing can start a video no
project has one, so in production it shows nothing until a video exists. A
video that exists is never hidden from the members who may read it.

## Decision 2 — What it says

| Phase | Shown |
| --- | --- |
| Queued, generating scenes, composing, validating | the phase; how many scenes are made, of how many; the Units "reserved for it, used only if it is delivered"; that the page shows the progress when it was loaded |
| Completed | the phase; the Units it used |
| Failed, cancelled | the phase; ADR-0052's message; what became of the Units; whether the project can be started again |

Every panel also shows the video's quality (Normal or HQ) and length, and its
support reference. Nothing on it is a control: nothing retries the video.

- **ADR-0052's message is shown as written**, in Japanese and marked so
  (`lang="ja"`), for every video that ended without one, failed or cancelled
  alike. It is not translated: a translation would be another message.
- **The Units say only what is true of them** and never contradict the
  message: back ("came back; none was used"), still held ("still held, and
  come back once settled; none was used"), never reserved, or used for a
  delivered video. The count is the video's, in its own quality.
- **Started again** follows ADR-0110: once a video ended without one and its
  Units came back, or it reserved none, "This project can be started again";
  while its Units are still held, "once its Units have come back". The start
  itself stays where it is (ADR-0112).
- **The scene count is shown only while the video is being made**; a delivered
  video's is not progress (ADR-0113 Decision 5).

## Decision 3 — A video the read will not describe

When the read refuses to describe a video because its Units contradict
ADR-0052 (ADR-0113 Decision 4), the panel says only "This video's progress
could not be read." with its support reference, taken from the refusal's
details. It says nothing about the video's Units. Every other failure of the
read is the page's, as its other reads' are.

## Decision 4 — What stays out

- **No refresh.** The page shows the progress when it was loaded and says so;
  nothing pushes a change, and email notification comes later (the plan's
  default 4).
- **No time estimate** until provider times are measured (the plan's default
  3).
- **Preview and download** of a delivered video (GS-12).
- **What the page says while a new version of a delivered video is made** is
  decided with regeneration (`docs/decisions/TODO.md`, *Open in GS-11a*).
- **No migration**, no route, no environment variable and no new permission.

## Consequences

- A customer who starts a video in development sees where it is on the project
  page, and a video that ended without one is described as UXFlow's error
  recovery asks, with ADR-0052's message.
- The failure's class stays internal, as no reader of the progress can tell
  one from another (ADR-0113).
