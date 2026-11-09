# ADR-0126 — The product sends email through a port

Status: Accepted (AT-1, 2026-11-09). First milestone of the accounts-and-team
plan the product owner approved on 2026-11-09
(`/mnt/project-files/cto/accounts-team-proposal.md`, Design 1).
Builds on: ADR-0008 (ports, and development adapters refused in production),
ADR-0052 Decision 18 (mandatory email verification; password reset), ADR-0085
(a development folder named by an absolute path, refused in production).

## Context

The product sends no email. ADR-0052 Decision 18 requires that a new account
verify its email and that a person can reset a password, and both need a link
sent to the address. The plan's invitations need one too.

No email service is chosen. Choosing one is a decision before launch, and so
is giving production its credential. Until then, development and the browser
tests still need to send a link and read it back.

## Decision 1 — One port, one checked message

Domain code sends through `EmailSender` (`packages/domain/src/email`), whose
one method `send` takes an `OutgoingEmail`. A delivery service's client is
never called from domain or UI code, as for the video providers.

`outgoingEmail` is the one place a message is made, and its result is branded.
A message is:

- **one of three kinds**: `EMAIL_VERIFICATION`, `PASSWORD_RESET`,
  `INVITATION`, so a reader can tell them apart without reading the text;
- **to one plain ASCII address**: RFC 5322's dot-atom local part of at most 64
  characters, a domain of two or more DNS labels, at most 254 characters, after
  the product's normalization (trimmed, lower case). No display name, no quoted
  local part, no list. An internationalized domain is written in punycode;
- **a one-line subject** of 1 to 200 characters, with no control character and
  no line or paragraph separator;
- **a plain-text body** of 1 to 10,000 characters that breaks lines with `\n`
  and holds no other control character, a carriage return included.

No HTML, header or attachment can be expressed, so no caller can inject a
header or a second recipient. A refusal is `VALIDATION_FAILED` and names
neither the address nor the text, so it is safe to log.
`isDeliverableEmailAddress` exposes the address rule on its own, for a later
milestone that refuses at sign-up an address no email can reach.

`send` resolves once the message is accepted, and rejects when it was not. A
real service may have sent a message whose call failed, so every flow that
sends must tolerate the same email arriving twice; asking for a link again
already does.

## Decision 2 — The development outbox

`createDevelopmentEmailOutbox({ folder })` (`@app/storage`) is the only
`EmailSender`. It writes each message as one JSON file in an absolute folder:

- the file is named by the millisecond it was sent and a random id, so the
  folder lists oldest first; two sent in one millisecond list in either order;
- it is written under a hidden temporary name and renamed into place, so a
  reader never sees half a message;
- a message holds one-time links, so a folder it makes is private to its user,
  and each file is readable by its user alone;
- it checks the message again before writing, since a cast can forge the brand;
- an error names a code, never the folder or the message.

It is refused under `NODE_ENV=production`, given or ambient, as the shared
folder is. `readDevelopmentEmailOutbox(folder)` gives back every message,
oldest first, for tests and developers; a folder not made yet holds none, a
file named as a message but not in the outbox's format fails the read, and a
folder or file it cannot read fails with a code, never the path.

The folder is `EMAIL_OUTBOX_DIR`, optional, absolute, and refused when
`NODE_ENV=production`. It is its own folder, not inside `SHARED_STORAGE_DIR`,
whose every file is an object at a canonical key.

## Decision 3 — Nothing sends yet

Neither application constructs the outbox, reads `EMAIL_OUTBOX_DIR` or makes a
message; a test pins that. AT-3 is the first caller, with email verification.

Production has no sender. Until a service is chosen, a production build will
not be able to send the verification link, so no account can be verified
there. Production is not running, and the choice is recorded on the
pre-launch list in `docs/decisions/TODO.md`.

## Consequences

- AT-3 and AT-4 send their links, and AT-6 its invitations, through one checked
  shape; a production service later implements one method.
- The browser tests will read their links from the outbox folder.
- **Not here:** sign-up, verification, reset and invitation themselves; the
  setting in `.env.example` and `docs/local-setup.md`, which arrive with their
  first reader; a page that lists the outbox.
- **No migration**, no route, permission or page, and no production code path
  changed.
