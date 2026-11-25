# API Changes — RD-6a

The SMTP email sender (ADR-0166). **No migration, no route, no page and
no new setting.** Nothing builds the sender yet; RD-6c gives it to the web
app.

## HTTP

No change.

## Dependencies

`nodemailer` `10.5.0`, an exact version, in `@app/storage`, loaded only
through the subpath `@app/storage/smtp`.

## Internal API

### New

| Export | What it is |
| --- | --- |
| `createSmtpEmailSender(options)` from `@app/storage/smtp` | an `EmailSender` that hands each email to an SMTP server over one connection, TLS from the first byte or STARTTLS required, the certificate always checked; refuses, as it is built, settings it cannot use, as `CONFIGURATION_ERROR` |
| `SmtpEmailSenderOptions`, `SmtpTls` from `@app/storage/smtp` | `host`, `port`, `tls` (`implicit` or `starttls`), `servername?`, `user`, `password`, `from`, `ehloName`, and for tests `ca?` and `limitsMs?` |
| `SMTP_LIMITS_MS` from `@app/storage/smtp` | the library's own limits: connection 10,000, greeting 10,000, DNS 10,000, idle 30,000 |
| `smtpFailureCode(error)` from `@app/storage/smtp` | the library's code when it is one of eleven words, `UNKNOWN` otherwise |
| `isNetworkHost(value)` from `@app/shared` | whether text is a DNS name, an IPv4 address or an unbracketed IPv6 address, with nothing else |

A send that fails rejects with `PROVIDER_ERROR`, "The email was not
accepted for delivery (CODE)", `CODE` from `smtpFailureCode`, and no
cause. An email that fails `outgoingEmail` is refused with its
`VALIDATION_FAILED` before anything is sent.

### Changed

| Export | Change |
| --- | --- |
| `isClamAvHost(value)` from `@app/shared` | returns `isNetworkHost(value)`; it accepts and refuses the same text as before |
