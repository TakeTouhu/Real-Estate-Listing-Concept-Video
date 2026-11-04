# ADR-0117 — The delivered video on the project page

Status: Accepted (GS-12b-2, 2026-11-04). The third milestone of row GS-12 of
the generation-to-preview plan the product owner approved on 2026-10-26
(`/mnt/project-files/cto/generation-e2e-proposal.md`: "the finished video
plays in the private workspace. Preview needs `video.view`"). Builds on
ADR-0114 (the project page's "Video" panel), ADR-0115 (serving a stored
video) and ADR-0116 (a link to watch a delivered video).

## Context

The project page shows its newest video's progress in a "Video" panel, read
when the page loads (ADR-0114). `VideoPreviewService.link` gives a reader of
that progress a five-minute signed link to the delivered video, audited when
it is given, but nothing builds it (ADR-0116). The signed download route
serves the video a range at a time, as `video/mp4` (ADR-0115).

A player keeps asking the route for ranges while the video is watched and
sought, so a link given when the page loaded can run out while the video is
open. Checked in Chromium against a stand-in for the route that refuses an
expired token: a range refused with `401` fails the video with a network error
(`MEDIA_ERR_NETWORK`), the video reads as paused before the failure is
reported, and a new link set on the same video plays again from where it was
put back to.

## Decision 1 — The page asks for a link to a completed video

After it reads the progress, the project page asks the link service for a link
as the member, in the organization whose storyboard it shows, **only when the
progress shows the video completed** (`isCompletedVideo`). Anything else (no
video, one being made, one that ended without one, one the read would not
describe) asks for nothing, so nothing is signed or audited for it.

The link service reads the video again and may still answer none; then no
player is shown. Its failures are the page's, as a photo link's are. Each load
of the page with a completed video gives, and audits, one link.

## Decision 2 — The player is the browser's

The panel plays it right under its status line, with the browser's own
controls: `<video controls playsInline preload="metadata">`, labelled "The
delivered video".

- **Nothing plays until the member presses play**, and only the video's length
  and first frame are read before: no autoplay.
- **The browser's controls offer no download** (`controlsList="nodownload"`).
  Downloading is its own action, offered to members holding `video.download`,
  served as an attachment and audited (GS-12c). As ADR-0116 Decision 4 says,
  this hides an offer; it cannot stop a member from keeping what they watch.
- **No controls of the page's own**, and nothing shows the link as a link.

## Decision 3 — A link that runs out is renewed once

When the video fails and its link has run out, or will within 30 seconds (the
browser's clock and the server's need not agree), the player asks the page
for a new one once (`router.refresh()`), and the video goes back to where it
was, playing if the member last pressed play. Whether it was playing is taken
from the member's own play and pause, not from the video, which reads as
paused once it has failed.

- **Each link is renewed at most once.** A second failure of the same link,
  and any failure while the link is still good (a file that cannot be read or
  decoded), says "The video could not be played. Reload the page to try
  again." and stops.
- **A renewal reloads the page's data**, as a reload would: the progress is
  read again, a new link given and audited, and the photos' links signed
  again. A video no longer completed by then shows no player.
- **No link is renewed before it is needed.** A paused video keeps its link
  until it fails.

## Decision 4 — What stays out

- **The download** (GS-12c).
- **The disclosure mode, the version and its date beside the video, old
  versions during their 30 days, a poster frame and captions.** Mode A's
  disclosure is burned into the video itself (ADR-0071).
- **A live progress.** The panel is still read when the page loads
  (ADR-0114 Decision 5).
- **The browser test** (GS-13). Playwright's bundled Chromium has no H.264
  decoder (`canPlayType` answers nothing for `avc1`), so it cannot play the
  delivered video; that test must prove the player's link serves it, or run a
  browser that decodes it.
- **No migration**, no new route, permission or environment variable.

## Consequences

- A member who can read a project's progress plays its delivered video on the
  project page and can seek it, without a download offer.
- Every page load that shows a delivered video writes one
  `video.preview_link_issued` entry, and so does every renewal.
- In production nothing starts a video yet (ADR-0111), so no project has one
  to play.
