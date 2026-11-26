# ADR-0182 — A log message is a constant

Status: Accepted (PT-7a2, 2026-11-26). A milestone of production
readiness, part 2, approved by the product owner on 2026-11-26 at
04:38Z (`docs/production-readiness-part2-gap-analysis.md`). It changes
no customer surface, charge or business rule: only what a log line may
carry, an engineering and security call recorded here.

Builds on: ADR-0181 (a log line's `severity`, its reserved keys and its
order), ADR-0177 (the request failure line and its fields).

## Context

After PT-7a (ADR-0181), two parts of the `TODO.md` item "The logger's
message, reserved keys and other URLs bypass `redact`" were still open:

- `createLogger` (`packages/observability/src/logger.ts`) wrote the
  message as given. Every field went through `redact`; the message did
  not. A message built from a value, such as a template naming a URL,
  would be written whole.
- `redactUrl` (`packages/observability/src/redact.ts`) stripped a URL's
  query and fragment, keeping its origin and path, but returned a URL
  with neither unchanged. `https://user:pw@h.test/a` was written with
  its user name and password.

Three ways to close the first were weighed:

- **A.** Pass the message through `redact` alone. `redact` rewrites a
  string only when it starts with `http(s)://` and parses as a URL, so
  a URL further inside a sentence still passes.
- **B.** Teach `redact` value patterns: `Bearer ...`, `key=value`, a
  URL anywhere in a string. That is a new redaction policy.
- **C.** Make every message a constant, held by a test, and keep
  `redact` on the message as a backstop.

Every logger call in `apps/*/src` and `packages/*/src` already passes a
string literal. The guard below counts them with the TypeScript parser
each time it runs; no count is fixed here, because one would go stale
with the next log line.

## Decision 1 — A log message is a constant; `redact` is the backstop

Option C. A message names what happened; the values go into fields,
where `redact` and the reserved-key filter (ADR-0181 Decision 2) apply.
The logger also writes `message: redact(message)`, so a message that
starts with `http(s)://` and parses as a URL is scrubbed like a field.
`severity`, `time` and `message` keep their place at the start of the
line, and the reserved keys are still dropped first.

No value pattern is added to `redact`: not `Bearer`, not `key=value`,
not a URL inside a longer string. Each would be a new rule about what
counts as a secret in free text, which nothing decides; it is left open
in `TODO.md`.

## Decision 2 — The guard is broad, not keyed to a type

`tests/observability/constant-log-messages.test.ts` parses every
non-test `.ts` and `.tsx` file under `apps/*/src` and `packages/*/src`
with the `typescript` package, as
`tests/api/failure-log-coverage.test.ts` does, so a comment or a string
never counts. A file named `*.test.ts` or `*.test.tsx`, or under
`__tests__`, is not read.

Every call whose callee is a property access named `debug`, `info`,
`warn` or `error`, and whose receiver is not the identifier `console`,
must take a string literal or a template with no substitution as its
first argument. Parentheses, `as` and `satisfies` around the callee or
the message are read through, and `x.error.call(t, msg)` and
`x.error.apply(t, [msg])` are read as `x.error(msg)`. Otherwise it must
be listed, exactly, by its file and its own call text, in `NOT_A_LOG`,
the shape of the coverage guard's `UNLOGGED`. A listed entry that no
call matches fails, so the list cannot go stale.

The guard does not ask whether the receiver is a `Logger`. It needs no
type checker, and a new logger, a wrapper or a `Pick<Logger, "warn">`
is held the day it is written. The price is that a call on something
else, such as a stream's `controller.error(...)`, must be listed. The
list starts with the three in `packages/storage/src`: two in
`shared-folder-storage.ts` and one in
`google-cloud-storage/google-cloud-storage.ts`.

The guard's own test runs it on in-memory sources and shows that it
refuses a template with a substitution, a variable, a call, a
concatenation, a tagged template and a call with no argument, also
through a parenthesized callee, `.call` and `.apply`, accepts a
literal, a plain template, a literal in parentheses or `as const`, and
`console`, ignores a comment and a string, and takes a
listed call only in its own file.

## Decision 3 — A URL's user name and password are always dropped

`redactUrl` drops the user name and password of a URL with no query or
fragment: `https://user:pw@h.test/a` becomes `https://h.test/a`. A user
name alone or a password alone goes the same way. A URL with neither
is returned exactly as given. A URL that loses its user name and
password is written as `new URL` normalizes it (its `href`): scheme and
host lowercased, a default port dropped, dot segments resolved, an
unsafe character percent-encoded. The query and fragment case is unchanged,
`origin + path + "?[REDACTED]"`, which never carried the user name or
password. A value `new URL` cannot parse is returned unchanged, as
before.

`redactUrl`'s only caller is `redact`, and `redact`'s only caller is
the logger. A logged field or message that is such a URL now loses its
user name and password; nothing else changes. No caller is known to
log one (*inference*: the guard shows every message is a literal, and
no field in `apps/*/src` or `packages/*/src` was found to carry a URL
with credentials).

## Known gaps

- **A method not called by its name.** `const f = log.error` then
  `f(url)`, `const { error } = log` then `error(url)`,
  `log["error"](url)`, `log.error.bind(log)(url)` and
  `xs.forEach(log.info)` are not a property-access call named `error`
  or `info`, so the guard does not see them. None is in the tree today.
- **A URL inside a longer string.** `redact` anchors at the start of a
  string, so `"Fetched https://h.test/a?sig=1"`, as a field or a
  message, passes unchanged. A string that starts with a URL and goes
  on is rewritten whole: the rest is dropped with the query, or
  percent-encoded into the path. Constant messages close this for the
  message; a field stays open (`TODO.md`).
- **A URL with credentials that does not parse.** A string `new URL`
  refuses, such as `https://user:pw@[bad/a` or `https://user:pw@`, and
  one the `^https?://` anchor misses, such as a leading space, is
  written with its user name and password, as before (`TODO.md`).
- **Dynamic `console.*` lines outside the logger.** The worker's start
  failure in `apps/worker/src/main.ts`, the command-line tools under
  `apps/ops/src/bin` and `apps/worker/src/development-pipeline`, the web
  app's start report in `apps/web/src/lib/startup.ts` and
  `packages/storage/src/bin/render-disclosure-layers.ts` write through
  `console`, which the guard leaves alone. Only the worker's start
  failure had a `TODO.md` item; a new item records the others. This ADR
  decides nothing for them.

## Consequences

- A new log call that builds its message from a value fails the guard;
  the value goes into a field instead.
- A new non-logger `.debug`, `.info`, `.warn` or `.error` call whose
  first argument is not a constant costs one `NOT_A_LOG` line.
- A logged URL with a user name or password shows neither.
- No route, answer, stored value, setting or migration changes. Every
  message written today is a literal, so no line written today changes.

## Considered and not done

- **Option A alone.** It leaves a URL inside a message, and anything
  else a message is built from, as it was.
- **Option B, value patterns.** A new redaction policy that nothing
  decides; see Decision 1.
- **A type-level constant, `string extends M ? never : M`.** It makes
  the logger's methods generic, which changes every
  `Pick<Logger, "warn">` user and every test stub, and an `as` cast or
  a widened `const` defeats it. The parser guard needs neither.
- **A guard keyed to the `Logger` type.** It needs the type checker
  over the whole tree and misses a call through a value typed some
  other way.
