# ADR-0168 — SMTP in the web app

Status: Accepted (RD-6d, 2026-11-25). The fourth and last part of the
sixth milestone of production readiness, part 1, which the product owner
approved on 2026-11-16
(`/mnt/project-files/cto/production-readiness-proposal.md`). With
`SMTP_HOST` set, the web app hands every email to the SMTP server, and a
production start allows it. RD-6 is complete.

Builds on: ADR-0166 (the SMTP email sender), ADR-0167 (its settings),
ADR-0164 (ClamAV in the web app, the pattern followed here), ADR-0150
(the web app's adapters in one place), ADR-0151 (the production start
check), ADR-0126 and ADR-0129 (the outbox, and no email without one).

## Context

The sender of ADR-0166 was built by nothing, and the settings of
ADR-0167 were checked and used by nothing. The web app sent each email
to the development outbox or not at all, and a production start was
refused for email, so no production environment could pass the start
check. The design is `/mnt/project-files/cto/rd-6/rd-6c-design.md`,
checked by `rd-6c-critic.md`, split in two (`decision.md` there).

## Decision 1 — Chosen by `SMTP_HOST`, in every environment

The web app's choice of email adapter is `smtp` when `SMTP_HOST` is set,
else `outbox` when `EMAIL_OUTBOX_DIR` is set, else `none`
(`adapter-choice.ts`). It is a production adapter, so it is chosen
wherever a server is named, as ClamAV is (ADR-0164 Decision 2); the
schema refuses it beside the outbox (ADR-0167). The sender is built for
each email from the seven settings, opened only to send it, the port
read as a number. No certificate name, authority or limit is given: the
host is its own certificate name, Node.js's own authorities are
trusted, and the library's limits are ADR-0166's. An environment the
schema did not parse that lacks a setting is refused with
`CONFIGURATION_ERROR`, never filled in.

## Decision 2 — What a production start allows

`PRODUCTION_ADAPTERS.email` is `["smtp"]`. A production environment with
Google's Cloud Storage, a ClamAV daemon, the seven SMTP settings and the
three production settings is the first that passes the start check, and
readiness's `start` check passes with it.

A passing start, and a `start` check that passes, do not mean an email
can be delivered: no setting is tried until the first send, and no
probe asks the server (ADR-0166). A wrong password, a closed port, a
certificate Node.js does not trust or a mode that does not match the
port shows first as Decision 3's line and the caller's
`PROVIDER_ERROR`. Part 1 deploys nothing; that no deployment sets
`SMTP_HOST` before the reset and invitation limits of RD-7 and RD-8 are
in place is recorded in `TODO.md`, and nothing in code enforces it.

## Decision 3 — A failed send logged by its code

The SMTP sender's rejection carries its code as data,
`details.smtpCode`, beside the message that already named it. The web
app wraps the sender: a send that rejects writes one `warn` line,
component `email`, message `An email was not accepted for delivery`,
with `code` the sender's code when it is one plain word of capitals,
digits and underscores, and `UNEXPECTED` otherwise, so no server reply,
address or message is logged. The flow gets the same rejection, whether
or not the line could be written. A send that is accepted logs nothing.
A server's refusal therefore writes two lines: this one, with the SMTP
word, and the caller's, which logs `PROVIDER_ERROR`. The outbox is not
wrapped.

## Decision 4 — The reset answer's timing, recorded

A password reset for an address with an account now waits for a whole
SMTP session before it answers, where any other address waits for one
lookup: a difference of up to seconds, which one request can show and a
rate limit does not remove. ADR-0131 accepted a smaller difference of the
same kind; what the reset answers while its email is sent is the product
owner's, open in `TODO.md`; meanwhile Decision 2's note holds, that no
deployment sets `SMTP_HOST` before RD-7 and RD-8.

## Considered and not done

- **Loading the mail library on the first send.** Measured: `next build`
  bundles nodemailer into one server chunk, which every route that loads
  the adapters loads too; importing it runs nothing. Not worth an
  asynchronous builder. ADR-0166's "a subpath of its own" now keeps it
  out of the worker, not out of the web app's routes.
- **A readiness probe of the server.** It would need a deadline; decided
  with the deployment in part 2, as for ClamAV.
- **A whole-send deadline.** Put to the product owner on 2026-11-25, who
  chose to decide it in part 2; until then there is none in our code, and
  the library's limits are all there is.
- **A container case through the web app's settings.** The settings
  carry no certificate authority and Mailpit's certificate is its own,
  so the web app cannot be pointed at Mailpit as production would be;
  the sender's own suite proves it there (RD-6b).
- **Logging the outbox's failures.** The log exists for the SMTP word the
  callers cannot see; an outbox failure is local.

## What was measured

`apps/web/src/lib/adapters-email.test.ts`, with the builder mocked and
the real one run beside it: the choice; a sender built for each email
from exactly the seven settings, the port a number; every schema-valid
environment built; built in production; a missing setting refused with
nothing built; a rejected send logged by its code alone, the same error
rethrown, with no marker, address, password or reply in the log; an
accepted send logged by nothing; a log that throws leaving the send's
own error; and which codes are plain. `startup.test.ts` passes a
production start with the default list, and refuses one that names a
server without the rest, or turns off the certificate check, by the
schema's lines. The sender's suite checks `details` and that the web
app's adapters, never the worker, build it. `pnpm run build` passed
with no warning.

## Consequences

- `apps/web/src/lib/adapters.ts` exports `emailFailureCode` and
  `loggingEmailFailures`; `WebAdapterChoice.email` gains `smtp`.
- `createSmtpEmailSender`'s rejection gains `details.smtpCode`.
- No migration, route, page, setting or dependency.
