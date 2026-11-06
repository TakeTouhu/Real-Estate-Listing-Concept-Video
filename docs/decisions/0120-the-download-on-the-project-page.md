# ADR-0120 — The download on the project page

Status: Accepted (GS-12c-3, 2026-11-06). The last milestone of GS-12c, and so of
row GS-12 of the generation-to-preview plan the product owner approved on
2026-10-26 (`/mnt/project-files/cto/generation-e2e-proposal.md`: "Download
needs `video.download`, is audited, and uses a short-lived signed link").
Builds on ADR-0117 (the delivered video on the project page), ADR-0118 (a
download link that names the file it saves) and ADR-0119 (a link to download a
delivered video).

## Context

`VideoDownloadService.link` gives a member holding `video.download`, with the
Property in reach, a 300-second link that saves the project's delivered video
under the project's name, and audits each link it gives (ADR-0119); nothing
outside tests builds it. The signed download route serves such a link as an
attachment. Chromium saves that answer and stays on the page, whether it
follows a link to it or a `303` answer to a form's post (ADR-0118 Decision 2).

The project page plays a delivered video in its "Video" panel, asking for a
link to watch it each time the page is built (ADR-0117). The page is read only
by a member holding `video.view` (the storyboard read asks for it). Every role
holds `video.view` and `video.download` together or neither (ADR-0052
Decision 10).

## Decision 1 — A button under the player

The panel shows a **"Download video"** button right under the player, for a
video its progress shows delivered (`isCompletedVideo`, as the player) and a
member whose role and grants carry `video.download`, in the organization whose
storyboard the page shows (`downloadOnProjectPage`).

- **Showing the button asks for nothing.** No link is signed or audited when
  the page is built; one is asked for only when the button is pressed. A page
  load audits its link to watch the video, as before (ADR-0117), and nothing
  else.
- **It is a form that posts**, never a link to follow: each recorded download
  is one the member asked for, not a page or a browser prefetching it. Its
  fields are the organization's id and the Property's id, as the page was read
  for; the organization's id is the member's own, as the start page's form
  carries it (ADR-0111).
- **Whether the button is shown is not what lets the member download.** The
  download service decides again when it is pressed.

## Decision 2 — The route: `POST /api/video-projects/{projectId}/download`

1. **A post from another origin, or one naming none, is refused** (`403`)
   before anything is read (`isSameOriginPost`, ADR-0068 Decision 4).
2. **A signed-out visitor is sent to sign in** (`303 /login`), as every form
   route does; a session waiting on its second step is not signed in.
3. **A body that is not a form, or ids that cannot be the app's**
   (organization, Property, project), is refused (`422 VALIDATION_FAILED`).
   The Property and the project say where to send the member back to, so
   neither can be just any text.
4. **The download service is asked as the member** (`requestDownload`), and
   its answer sends the member:
   - **to the link**, with `303` and `Cache-Control: private, no-store`. The
     browser saves the file under the project's name and the page stays
     where it was;
   - **back to the project page** with `303` and `?download=` naming one of
     three notices: `none` for no delivered video (the video changed since the
     page was read), `forbidden` for a member who may not download it or a
     project out of reach, answered alike as the service answers them (ADR-0119
     Decision 2), and `failed` for any other refusal, to try again.
   - Anything that is not an application error is the route's to fail with, as
     every route's is.

The route is built wherever the page is, as the player is (ADR-0117): where
nothing can start a video (ADR-0111), no project has one to download, and the
service answers none.

## Decision 3 — The notices are the page's own

The project page reads `?download=` and shows the notice that code names, as a
status above the "Video" panel, whether or not the project still has a video:

- `none`: "There is no delivered video to download. Reload the page to see
  where the video is."
- `forbidden`: "You may not download this video."
- `failed`: "The video could not be downloaded. Try again; if it keeps
  failing, quote the support reference below."

Any other value shows nothing (`downloadNotice`): the page never shows text the
URL carries. The notices say nothing of why a member may not download, and
name no permission, role, provider or model.

## Decision 4 — What stays out

- **A member granted `video.download` without `video.view`** has no button:
  the page itself is read with `video.view`. No role is like that; only an
  individual or group grant can make one.
- **A notice stays until the page is loaded again.** A download that worked
  after one that did not leaves the page, and its notice, where they were.
- **A delivered video whose file cannot be read** sends the browser to the
  signed route's own answer (`404`) in place of the page. A video is delivered
  only once its file is stored, so only a store that lost it does that.
- **A limit on how often a member downloads**, beyond the same-origin check:
  each press is audited.
- **Old versions during their 30 days** (ADR-0052 Decision 17) and **share
  links** (ADR-0052 Decision 12).
- **The browser test** (GS-13), run under a UTF-8 locale (ADR-0118
  Decision 2).
- **No migration**, no new table, column, permission or environment variable.

## Consequences

- A member holding `video.download` downloads a project's delivered video from
  its project page with one press; the browser saves it as the project's name
  with `.mp4`, and each press that gives a link is in the audit log as
  `video.download_link_issued` (ADR-0119).
- A member without `video.download` sees no button, and one who lost it or the
  project since the page was read is told they may not download it.
- In production nothing starts a video yet (ADR-0111), so no project has one
  to download, and the page shows no button.
