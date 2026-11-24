# ADR-0165 — The upload panel's Retry

Status: Accepted (RD-5c, 2026-11-24). A small fix that RD-5's decision
(`/mnt/project-files/cto/rd-5/decision.md`) puts before production, within
production readiness part 1, which the product owner approved on
2026-11-16 (`/mnt/project-files/cto/production-readiness-proposal.md`).

Builds on: ADR-0008 (the upload's states, `retryUpload` re-issuing a link
for the same photo, and a limit on a Property's photos, 20 by
`DEFAULT_UPLOAD_LIMITS.maxAssetsPerProperty`), ADR-0163 Decision 4 (a photo
whose scan fails ends `FAILED` and may be completed again), ADR-0164 (the
web app scans with ClamAV).

## Context

The Property page's upload panel offered "Retry upload" on any photo that
did not end `READY`. It called `/retry`, which puts the photo back to
`PENDING_UPLOAD` and gives a new upload link, but the panel never used the
link: it asked the owner to choose the file again, and choosing it asked
for a new photo. The reset photo stayed `PENDING_UPLOAD`, holding one of the
Property's places, and no route frees one. It also offered Retry on a
`QUARANTINED` or `REJECTED` photo, which the server refuses.

With ClamAV, a scan that could not be completed is an ordinary failure: a
daemon that is restarting fails every upload at once. Each retry then cost
a place for good, so twenty retries during an outage filled a Property.

A `FAILED` photo holds no place, and only a request for an upload link
checked the limit. So completing a `FAILED` photo again, which the new
Retry does, could have taken the Property past its limit: the review found
21 photos `READY` after 20 uploads, one failed, a 21st and a retry.

## Decision 1 — Retry tries the same photo

- A photo the server ended `FAILED` after storing its bytes is completed
  again: `completeUpload` takes a `FAILED` photo and checks its stored
  bytes again, scan included. Nothing is sent.
- A photo whose bytes never arrived (its upload failed, or completing it
  did not answer with a status) is given a new link for the same photo by
  `/retry`, and the panel sends it the file it kept from the owner's
  choice, then completes it.
- `QUARANTINED` and `REJECTED` are final: the panel offers no Retry.
- A photo whose upload link was refused does not exist; the panel offers
  no Retry, and the owner chooses the file again, as before.

## Decision 2 — A failed photo tried again takes a place only if one is left

`completeUpload` of a `FAILED` photo, and `retryUpload` of one, refuse with
`This property already has the maximum of 20 photos`, as a request for an
upload link does, when the Property's photos that hold a place already
fill its limit. The photo stays `FAILED` and nothing is scanned. A photo
still `PENDING_UPLOAD` already holds its place and is never refused for
the limit.

The limit is checked by counting the Property's photos before the change,
as for a request for an upload link, so two requests at the same moment
can still pass it together: the count and the change are not one step.
Making the limit hold under concurrent requests, for all three, is
recorded in TODO.

## Considered and not done

- **A route that frees a place held by a `PENDING_UPLOAD` photo.** A
  retry no longer leaves one behind, but an upload the owner abandons
  after a failed send still does, and so does one left by the old Retry.
  How long an unfinished upload may hold a place is a rule this change
  does not need; a photo left `SCANNING` by a restart is the same question,
  recorded in TODO.
- **Reading the photo's status before choosing a route.** When completing
  a photo is answered with no status, the panel cannot tell whether the
  server finished it; a later `/retry` of a photo that ended `READY` is
  refused, and the page shows the photo once it is read again.
- **Retrying automatically.** The owner presses Retry; nothing repeats.
- **Telling a refusal for the limit apart in the panel.** A `FAILED`
  photo refused for the limit loses its status in the panel like any
  refused completion, so a later Retry, once a place is free, sends the
  whole file again to a new link although the stored bytes were intact.
  That costs one upload and no place.

## What was measured

The panel's new suite (7 tests, jsdom, stand-in routes and uploads):

- a `FAILED` photo is completed again, with one upload in all;
- a failed upload is sent again, the very file chosen, to the same photo's
  new link, with no second upload link;
- a stored object that is gone is sent again, also when found on a retry;
- no Retry for `QUARANTINED` or `REJECTED`;
- Retry is offered again after a retry fails.

Mutations that offer Retry on a final state, send the file again for a
`FAILED` photo, keep `FAILED` after a check that found nothing stored, or
send another file each fail it.

The domain suite: two `FAILED` photos and 19 more; the first is completed
`READY`, the twentieth place; the second is then refused by completing and
by `retryUpload`, unscanned, and stays `FAILED`. At 20 photos waiting for
their bytes, one is still completed and one still given a new link.
Removing either check fails it, as does checking every photo.

## Consequences

- A retry no longer costs a new place, and a failed photo tried again is
  refused when the Property is full, by the same count as a request for
  an upload link (Decision 2).
- `/api/assets/{id}/complete` and `/api/assets/{id}/retry` answer `422`
  with the limit's message for a `FAILED` photo of a full Property, as
  `/api/properties/{id}/assets/upload-url` does.
- The panel keeps each chosen file in the page's memory until the page is
  left, so a retry needs no second choice.
- No migration or setting.
