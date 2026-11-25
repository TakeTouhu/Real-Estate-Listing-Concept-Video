# ADR-0167 — The SMTP settings

Status: Accepted (RD-6c, 2026-11-25). The third part of the sixth
milestone of production readiness, part 1, which the product owner
approved on 2026-11-16
(`/mnt/project-files/cto/production-readiness-proposal.md`). It adds the
seven settings that name an SMTP server and what the web app gives it,
checked when the environment is read. Nothing uses them yet: RD-6d
gives the web app the SMTP sender, chosen by them.

Builds on: ADR-0166 (the SMTP email sender and its refusals),
ADR-0164 Decision 1 (ClamAV's settings, the pattern followed here),
ADR-0151 (the production start check, which prints the schema's
messages), ADR-0159 (`NODE_DEBUG` refused in production), ADR-0126 (the
outbox and the address rule).

## Context

The sender of ADR-0166 takes a host, a port, an encryption mode, a login,
a sender address and an EHLO name, and refuses each it cannot use as it
is built. The web app reads its settings from one schema, whose messages
a production start prints, so no message may repeat a value. The design
for wiring the sender in (`/mnt/project-files/cto/rd-6/rd-6c-design.md`,
checked by `rd-6c-critic.md`) came to about 900 changed lines, so it is
split: the settings first, the choice of sender second.

## Decision 1 — Seven settings, all or none

`SMTP_HOST`, `SMTP_PORT`, `SMTP_TLS`, `SMTP_USER`, `SMTP_PASSWORD`,
`SMTP_EHLO_NAME` and `EMAIL_FROM`, in that order, are exported as
`SMTP_SETTINGS`. With `SMTP_HOST`, each of the other six is required;
without it, none may be set. Each refusal names the setting and says what
is wrong, and repeats no value:

| Setting | Taken |
| --- | --- |
| `SMTP_HOST` | a DNS name, with no port and not an IP address |
| `SMTP_PORT` | plain digits, 1 to 65535, kept as text |
| `SMTP_TLS` | `implicit` or `starttls`, as written |
| `SMTP_USER`, `SMTP_PASSWORD` | any text but empty |
| `SMTP_EHLO_NAME` | a DNS name, not an IP address |
| `EMAIL_FROM` | one plain address in lower case, with no name |

- **No defaults.** Which port goes with which mode is the mail service's
  to say, and a missing setting is refused rather than guessed.
- **Text with a check, never a list of choices**, so a wrong mode is
  refused beside every other refusal rather than in their place.
- **A DNS host.** The sender checks the server's certificate for the
  host's name, and no setting names another, so an IP address is refused
  here rather than when the first email is sent. A DNS name's last label
  is never a number, in digits or as `0x` and hex, as no top-level domain
  is, so a name a URL parser or resolver reads as an IPv4 address, such
  as `127.1` or `0x7f000001`, is refused as a host and as an EHLO name.
- **A login everywhere.** The sender never hands an email over unnamed
  (ADR-0166 Decision 3), so the login is required in every environment,
  not only in production.
- **The sender as given.** `EMAIL_FROM` must already be in the form the
  product stores an address in, so nothing about it is changed silently.

`SMTP_HOST` and `EMAIL_OUTBOX_DIR` are refused together: the web app is
to send each email one way.

## Decision 2 — `NODE_TLS_REJECT_UNAUTHORIZED` refused in production

Any non-empty value is refused in production by the schema, as
`NODE_DEBUG` is (ADR-0159): set to `0`, Node.js stops checking the
certificate of every connection that does not ask for the check itself.
The SMTP sender asks (measured, ADR-0166), but the Cloud Storage client
and any later one might not. Development and tests keep it.

## Decision 3 — One address rule

The rule for an address (`isDeliverableEmailAddress`, its two length
limits) moves from `@app/domain` to `@app/shared`, with the product's
normalization (`normalizeEmailAddress`) and a new
`isPlainEmailAddress`: deliverable and already normalized. The domain
re-exports the rule unchanged and its `normalizeEmail` returns the shared
normalization. The schema judges `EMAIL_FROM` and the sender judges its
sender by `isPlainEmailAddress`; the sender's certificate name and EHLO
name by the new `isDnsName`. A sender built from settings the schema took
is not refused for its address or names.

## Decision 4 — The browser test refuses all seven

It reads its mail from the outbox, so `e2eEnvironment` refuses each SMTP
setting by name, as it refuses the Cloud Storage and ClamAV ones. It
refuses the names in `SMTP_SETTINGS`, so a setting added to the schema
is refused there too. Playwright resolves `@app/shared` through the root
`tsconfig.json`'s paths, as the other browser-test helpers do.

## Considered and not done

- **Choosing the sender here.** RD-6d, so this milestone stays
  reviewable; until then the schema checks the settings and nothing uses
  them, and a production start is still refused for email.
- **A certificate-name setting, and IP hosts.** One more setting to get
  wrong, for a case no mail service needs.
- **A plain mode.** ADR-0166 Decision 2.
- **Refusing `NODE_EXTRA_CA_CERTS`, `NODE_OPTIONS`, `SSL_CERT_FILE` and
  the like.** They widen what is trusted rather than turning the check
  off, and a deployment may need one; recorded in `TODO.md`.

## What was measured

`packages/shared/src/env.test.ts` takes all seven together in every
environment, both modes; refuses each setting's wrong values one at a
time, beside the other six valid, by its one line; refuses each of the
six without the host and the host without each, in order; refuses the
host beside the outbox, and a wrong mode beside other refusals without
hiding them; refuses `NODE_TLS_REJECT_UNAUTHORIZED` in production; and
checks that the schema's SMTP keys are `SMTP_SETTINGS`. Its marker test
gains the seven and the switch, and no message repeats a value. The
domain's test checks its rule is the shared one, and the browser test's
environment test refuses each of the seven. The sender's own suite passes,
with `127.1` added to the certificate and EHLO names it refuses.

## Consequences

- `@app/shared` exports `SMTP_SETTINGS`, `isNetworkPort` (which
  `isClamAvPort` now returns), `isDnsName`, `isSmtpTlsMode`,
  `isDeliverableEmailAddress`, `isPlainEmailAddress`,
  `normalizeEmailAddress`, `EMAIL_ADDRESS_MAX_LENGTH` and
  `EMAIL_LOCAL_PART_MAX_LENGTH`.
- Eight optional settings; no migration, route, page or dependency. A
  production that sets `NODE_TLS_REJECT_UNAUTHORIZED` no longer starts.
