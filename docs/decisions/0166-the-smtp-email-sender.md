# ADR-0166 — The SMTP email sender

Status: Accepted (RD-6a, 2026-11-25). The first part of the sixth
milestone of production readiness, part 1, which the product owner
approved on 2026-11-16
(`/mnt/project-files/cto/production-readiness-proposal.md`). It adds an
email sender that hands each email to an SMTP server. Nothing builds it
yet: RD-6c gives it to the web app, and RD-6b proves it in CI against a
mail catcher.

Builds on: ADR-0126 (the `EmailSender` port and the outbox),
ADR-0150 (the web app's adapters in one place), ADR-0153 Decision 1 and
the product owner's answer of 2026-11-16 (a time limit that ends one
connection is outside the rule on timers), ADR-0156 (a package's age
weighed against using it; Decision 7, an adapter behind a subpath of
`@app/storage`).

## Context

The port has one adapter, the development outbox, which writes each email
to a folder and is refused in production, so a production start is
refused for email and no one could verify an address there. The approved
proposal chose SMTP, so the adapter is ready for whichever service the
product owner chooses.

Four investigations, recorded in `/mnt/project-files/cto/rd-6/`
(`code.md`, `smtp.md`, `ci-and-records.md`, `critic.md`), read the four
flows that send, ran Mailpit on this machine, sent through nodemailer to
it and to stand-in servers, and checked each other. `decision.md` there
records the choices. What they measured and this decision rests on:

- nodemailer delivered a Japanese subject and body, with an emoji, a line
  that is a lone dot and a 1,100-character link, intact through Mailpit.
  It writes seven-bit text: the subject as encoded words, the body as
  quoted-printable, or base64 when most of its characters are not Latin
  letters, lines of at most 76 characters, dots stuffed.
- Without `requireTLS`, a server that does not offer STARTTLS was sent
  the login in clear. With it, the send stopped first.
- With `NODE_TLS_REJECT_UNAUTHORIZED=0` in the process's environment and
  no explicit `rejectUnauthorized`, the login and the whole email went to
  a server whose certificate nobody had checked.
- The library's errors carry the server's reply verbatim; a server that
  quoted the login line put the encoded password into the message. They
  can also carry the peer's certificate and the recipient's address. The
  library itself never put the password in an error.
- The library's defaults allow 120 s to connect, 30 s for the greeting
  and 10 minutes of quiet. After the greeting, and the STARTTLS
  handshake, which shares the greeting's limit, only the quiet limit
  applies, and a server that sends a byte a second was still connected
  after 45 s.
- The library sends the email unnamed, without logging in, to a server
  that does not offer a login, unless told to log in anyway.

## Decision 1 — nodemailer, pinned

`nodemailer` `10.5.0`, an exact version, in `@app/storage` (lockfile
integrity `sha512-L/w/HH5…5Qu0kA==`). It has no dependencies and no
install script, its licence is MIT-0 and it carries its own types.
10.5.0 was published 2026-11-10, past two weeks old; the newest, 10.6.1,
was five days old. A client of our own, as ADR-0163 wrote
for ClamAV, would be about 400 lines plus its tests, for STARTTLS, login
and the encoding of Japanese text, with no flaw in the library to justify
them.

The adapter lives behind its own subpath, `@app/storage/smtp`, since the
library loads its other transports when imported: nothing that loads
`@app/storage`, the worker included, loads it.

## Decision 2 — Encrypted, checked, or nothing sent

`createSmtpEmailSender` takes `tls`: `implicit` (TLS from the first byte,
usually port 465) or `starttls` (usually port 587), and nothing else; there
is no plain mode, and development keeps the outbox. For `starttls` it
requires the upgrade after its first `EHLO` and before logging in or
naming anyone, so the login and the email never go in clear. The server's
certificate is always checked, set in the adapter so the process's
environment cannot turn the check off, with TLS 1.2 at least. The name
the certificate must carry is the host, or `servername`, which must be
given when the host is an IP address.

## Decision 3 — One email, one connection, as given

Each send checks the email again (`outgoingEmail`), opens one connection,
logs in, even when the server does not offer it, hands over the email and
closes. The envelope is the configured
sender and the one recipient. The adapter writes no header of its own: the
library's `From`, `To`, `Subject`, `Date`, `Message-ID` and MIME headers
only. No send is pooled or retried, so a send that failed after the
server took the email cannot be sent twice by the adapter; `ETIMEDOUT`
or `ECONNECTION` after the email was handed over may mean it was
delivered, which the port already says a flow must tolerate. The
library's logger and debug output are off, and it may read no file or
address for content.

## Decision 4 — A failure names one code, nothing else

A failed send rejects with `PROVIDER_ERROR` and the fixed message "The
email was not accepted for delivery (CODE)", with no cause. `CODE` is the
library's own code when it is one of eleven words (`ECONNECTION`,
`ETIMEDOUT`, `ESOCKET`, `EDNS`, `ETLS`, `EPROTOCOL`, `EENVELOPE`,
`EMESSAGE`, `EAUTH`, `ENOAUTH`, `ECONFIG`), and `UNKNOWN` otherwise
(`smtpFailureCode`). The server's reply, a certificate and the recipient
never leave the adapter.

## Decision 5 — The library's own limits

10 s to connect, 10 s for the greeting, 10 s for a DNS answer, and 30 s of
quiet while waiting for any later reply: the library's options, each
ending the one connection of one send. Their values are provisional; a
real service's numbers are part 2's. Nothing in the repository's code
keeps a deadline. A server that answers each step just inside 30 s can
hold a send, and with it a sign-up, a reset or an invitation, for minutes,
and one that trickles bytes without bound. A deadline for the whole send
is the product owner's to decide, recorded in TODO. A limit above
2,147,483,647 ms is refused: Node would arm it for 1 ms.

A send also makes a password reset's answer wait for a round trip to the
mail server, so its delay can tell an address that has an account; what
a reset answers meanwhile is the product owner's too, in TODO.

## Decision 6 — Refused as it is built

A host `isNetworkHost` refuses (a DNS name or an IP address, nothing
more), a port outside 1 to 65535, an encryption other than the two, a
missing certificate name for an IP host, an empty user or password, a
sender that is not one plain address in lower case, an EHLO name that is
not a DNS name, and a limit that is not a whole number of milliseconds
are each refused as `CONFIGURATION_ERROR`, with a fixed message that
repeats nothing given. The EHLO name is configured so no container's own
name or address is sent.

## Considered and not done

- **Our own client.** Decision 1.
- **A plain mode for a local catcher.** The library resolves a host name
  through DNS before `/etc/hosts`, so "plain only to a loopback name" does
  not hold; the outbox serves development, and CI proves TLS.
- **A readiness probe of the server.** It would need a deadline; as for
  ClamAV (ADR-0164), decided with the deployment in part 2.
- **A header naming the email's kind**, or a display name. No header text
  comes from settings.
- **Moving the address rule to `@app/shared`.** The adapter checks the
  sender with `isDeliverableEmailAddress` from `@app/domain`; the rule
  moves with the settings that need it, in RD-6c.

## What was measured

The adapter's suite has 16 tests, 12 of them against stand-in servers on
127.0.0.1, with a certificate authority and a server certificate made by
`openssl` for each run, so no key is kept in the repository:

- STARTTLS delivers one email to the one recipient, logging in only once
  encrypted, seven-bit, dots stuffed, with no `Cc`, `Bcc` or `X-Mailer`;
  implicit TLS delivers too.
- No STARTTLS offered: `ETLS`, no login and no `MAIL`. No login
  offered: it logs in anyway before `MAIL`.
- An unknown authority with `NODE_TLS_REJECT_UNAUTHORIZED=0` set, and a
  certificate for another name: `ESOCKET`, nothing after `STARTTLS`.
- `implicit` against a plain server fails, `starttls` against a TLS port
  times out waiting for the greeting; neither says `EHLO`, logs in or
  sends an email.
- A forged subject carrying `Bcc:` is refused before connecting.
- A 535 quoting the login: the error, as text, JSON, inspected and its
  stack, holds neither the reply, the password, the encoded login nor the
  recipient, and has no property but its own six. A refused recipient,
  quoted in the reply: `EENVELOPE`, no address.
- A connection dropped after the final dot: one rejection, one `MAIL`.
- A server silent after `MAIL`: `ETIMEDOUT` by the idle limit.

Mutations that set `requireTLS` false, drop `rejectUnauthorized`, accept
any certificate name, set `secure` false, skip the email's check, add a
`Cc`, put the library's error in the message or as the cause, pass any
code through, turn the pool on, drop `forceAuth`, the idle limit or the
limits' ceiling, or take a sender in upper case each fail it. The pool,
the envelope and `minVersion` are caught by the source test alone; TLS
1.2 is Node 22's own minimum, so dropping `minVersion` changes nothing
today. Dropping the connection or DNS limit is not caught.

## Consequences

- `@app/storage/smtp` exports `createSmtpEmailSender`, `smtpFailureCode`
  and `SMTP_LIMITS_MS`; `@app/shared` exports `isNetworkHost`, which
  `isClamAvHost` now returns.
- A new dependency, `nodemailer` `10.5.0`, in `@app/storage` alone.
- No migration, route, page or setting. A production start is still
  refused for email until RD-6c.
