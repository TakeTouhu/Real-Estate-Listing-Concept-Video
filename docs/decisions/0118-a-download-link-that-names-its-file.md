# ADR-0118 — A download link that names the file it saves

Status: Accepted (GS-12c-1, 2026-11-05). The first milestone of GS-12c, the
last row of GS-12 in the generation-to-preview plan the product owner approved
on 2026-10-26 (`/mnt/project-files/cto/generation-e2e-proposal.md`: "Download
needs `video.download`, is audited, and uses a short-lived signed link").
Builds on ADR-0115 (serving a stored video) and ADR-0116 (a link to watch a
delivered video).

## Context

A project's delivered video plays on the project page (ADR-0117) from a
300-second signed link given to a reader of its progress (ADR-0116). ADR-0052
makes downloading it its own permission ("Only users with `video.download` may
download", Decision 10), and ADR-0116 Decision 4 records that what
`video.download` governs is the download itself: the action offered to members
holding it, served as an attachment, and audited as a download.

Two things stop the signed download route from serving a download today:

- **Everything it serves is to be shown.** It sends no
  `Content-Disposition`, so a browser that follows a link to a video plays it
  in a tab rather than saving it.
- **A delivered video's key names no file.** It is
  `org/{organizationId}/deliverables/{versionId}/output`, so a browser that did
  save it would call it `output`, with no extension.

A page could ask the browser to save a link (`<a download>`), but the name and
the attachment would then be the page's to choose, not the link's, and a link
followed any other way would still be shown.

GS-12c is split into three milestones, each its own pull request:

- **GS-12c-1** (this ADR, no migration): a signed link that names the file it
  saves, and the route serving such a link as an attachment under that name.
  Nothing signs one yet.
- **GS-12c-2** (its own ADR): the service that gives a member holding
  `video.download` such a link to the project's delivered video, audited.
- **GS-12c-3** (its own ADR): the download on the project page.

## Decision 1 — A download link may name the file it saves

A signed token may carry a fourth field, the name the object is saved under,
for a download only. It is signed with the key, purpose and expiry, so no one
without the secret can add a name to a link or change one. A token without a
name is served as before; no link given so far changes.

- **The signer refuses a name on an upload**, and a name that is not safe to
  send (`isAttachmentFilename`): an empty one, one longer than 240 UTF-8
  bytes, one that starts or ends with a dot or white space (a hidden file, or
  a name a file system trims), or one holding a control character, an
  invisible format character (such as a zero-width space, a direction
  override or a soft hyphen), a line or paragraph separator, half of a
  surrogate pair, or one of `\ / : * ? " < > |`. The zero-width joiner and
  non-joiner are allowed: emoji sequences and several scripts are written with
  them, and neither reorders text as a direction control does. Every name is
  made by the application, so a refusal is `INTERNAL_ERROR`, whose message
  repeats no name.
- **The verifier ignores such a token however it was made**: a name on an
  upload, a name that is not a string or not safe to send, or a fifth field.
  The route answers it as a forged token.
- **The port takes it as an option**:
  `createSignedDownloadUrl(key, ttlSeconds, { attachmentFilename })`. Both
  stores pass it to the one helper that signs every URL, so there is still one
  signer, one verifier and one signed-URL implementation (the DS-4 shape test).

240 bytes leaves room within the 255 most file systems allow a file's name.
The characters refused are those that could end a header or its value early,
name another folder, or make a name read other than it is; anything else a
customer may write is carried as it is.

**The name is readable in the link.** A token is signed, not encrypted: its
payload is base64url JSON, as its key and expiry already are, so whoever holds
the link can read the name. A link is given only to the member who asked for
it, and a signed URL is never logged (CLAUDE.md, *Security*).

## Decision 2 — The route serves a named link as an attachment

For a verified token that names a file, every answer that serves bytes (`200`,
`206`, and `HEAD`'s) carries

```text
Content-Disposition: attachment; filename="<plain>"; filename*=UTF-8''<encoded>
```

(RFC 6266, RFC 8187). `filename*` carries the name whole, as percent-encoded
UTF-8, which every current browser reads. The plain form, for a client that
reads only it, is the same name with each character outside printable ASCII,
and each `%`, as `_`. A name that passed Decision 1 holds no quote, backslash,
control or line break that could end the header or its value early.

The plain form replaces a quote and a backslash too, so it stays one quoted
value whatever it is given; a name that passed Decision 1 holds neither.

An answer that serves nothing (`401`, `404`, `416`) names no file. Everything
else is as ADR-0115 left it: private and never stored by a shared cache,
`nosniff`, a sandboxing content policy, one byte range at a time, and a
customer's video as `video/mp4`. A range asked for with the link is answered
with the same name. The route still checks the token alone (ADR-0116
Decision 4).

**Checked in a browser.** Chromium 141 (Playwright's) saves such an answer,
sandboxing policy and all, under the name `filename*` carries
(`渋谷 Harbour View (1).mp4`), whether it follows a link to it or a `303`
answer to a form's post, and the page stays where it was. In a process whose
locale is not UTF-8, as in a bare Linux container, Chromium cannot write a
name outside ASCII and saves it as `download`, ignoring the plain form; a
browser test (GS-13) runs under a UTF-8 locale. Firefox was not checked.

## Decision 3 — What stays out

- **Signing such a link for a video** (GS-12c-2): who may be given one, the
  name it carries, how long it lives and its audit entry. Nothing signs a
  named link yet, so no answer changes.
- **The download on the project page** (GS-12c-3).
- **No migration**, no new table, column, route, permission or environment
  variable.

## Consequences

- A signed link can name the file its object is saved under, and the route
  serves it as an attachment under that name; every other link is served as
  before.
- A name that could break the header, or one on an upload, is never signed and
  never honoured.
