# API Changes — PT-7a2

A log message is a constant, and a logged URL loses its user name and
password (ADR-0182). Production readiness, part 2, approved by the
product owner on 2026-11-26. **No route, answer, stored value, setting
or migration changes**; only what `redact` does to a logged URL, and a
new guard test.

## A URL with a user name or password, before and after

A field holding a URL with credentials and no query, as written before:

```json
{"severity":"INFO","time":"2026-11-26T01:34:18.803Z","message":"m","link":"https://user:pw@h.test/a"}
```

And now:

```json
{"severity":"INFO","time":"2026-11-26T01:34:18.803Z","message":"m","link":"https://h.test/a"}
```

- A user name alone, or a password alone, is dropped the same way.
- A URL with a query or fragment still becomes origin, path and
  `?[REDACTED]`; that form never carried the user name or password.
- A URL with no user name or password is written exactly as given.
  One that loses them is written as `new URL` normalizes it: scheme
  and host lowercased, a default port and dot segments gone.
- A value `new URL` cannot parse is written as given, as before.

## The message, before and after

A message that is itself a signed URL, as written before:

```json
{"severity":"INFO","time":"2026-11-26T01:34:18.803Z","message":"https://storage.example.com/o/key?X-Goog-Signature=abc"}
```

And now:

```json
{"severity":"INFO","time":"2026-11-26T01:34:18.803Z","message":"https://storage.example.com/o/key?[REDACTED]"}
```

- Only a message that starts with `http(s)://` and parses as a URL is
  rewritten, and any text after the URL is then dropped or
  percent-encoded. A plain message, and a sentence with a URL further
  inside it, are written as given.
- No message written today is a URL. Every logger call in
  `apps/*/src` and `packages/*/src` passes a string literal, and the
  new guard keeps it that way, so no line written today changes.

## Who is affected

- `redactUrl`'s only caller is `redact`, and `redact`'s only caller is
  the logger (`packages/observability/src/logger.ts`). Both are
  exported from `@app/observability`, but nothing else imports them.
- A new `.debug`, `.info`, `.warn` or `.error` call whose first
  argument is not a constant, on anything but `console`, fails
  `tests/observability/constant-log-messages.test.ts` unless it is
  listed there by its file and its text. The list holds the three
  `controller.error(...)` calls in `packages/storage/src`.

## Tests

- `packages/observability/src/redact.test.ts`: user name and password,
  user name alone and password alone with no query, a port kept, the
  query and fragment cases with credentials, the normalized form, a
  value that does not parse (credentials kept, a known gap), a record
  field, and a string that starts with a URL and goes on.
- `packages/observability/src/logger.test.ts`: a message that is a
  signed URL or a URL with credentials is scrubbed; a sentence holding
  a URL is written as given (the gap in `TODO.md`).
- `tests/observability/constant-log-messages.test.ts` (new): the guard
  over apps and packages, a stale-entry check, and a self-test on
  in-memory sources (a substitution, a variable, a call, a
  concatenation, a tag and no argument are refused, also through a
  parenthesized callee, `.call` and `.apply`).

## Phase documentation

- Change log and release notes: this document and the Roadmap's PT-7a2
  paragraph, as for PT-7a (`CHANGELOG.md` stops at Phase 5C).
- Architecture, sequence and entity-relationship diagrams: Not
  applicable; no component, flow or table changes.
- OpenAPI: Not applicable; no route or answer changes.
- Database migration: Not applicable; see `docs/migration-notes.md`.
