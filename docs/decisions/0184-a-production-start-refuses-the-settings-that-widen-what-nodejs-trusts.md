# ADR-0184 — A production start refuses the settings that widen what Node.js trusts

Status: Accepted (PT-7a4, 2026-11-26). A milestone of production
readiness, part 2, approved by the product owner on 2026-11-26 at
04:38Z (`docs/production-readiness-part2-gap-analysis.md`). It changes
no customer surface, charge or business rule: only which settings a
production start refuses, an engineering and security call recorded
here.

Builds on: ADR-0159 Decision 5 (`NODE_DEBUG` refused by the schema),
ADR-0167 Decision 2 (`NODE_TLS_REJECT_UNAUTHORIZED` refused the same
way), ADR-0175 Decision 5 (the web image sets `SSL_CERT_FILE` and
`SSL_CERT_DIR`), ADR-0178 Decision 5 (CI's `production-mode` job trusts
its own authority through `NODE_EXTRA_CA_CERTS`), ADR-0151 Decision 4
(the worker has no production runtime yet).

## Context

`TODO.md` asks which of the settings that widen what Node.js trusts a
production start refuses or reports, "with the deployment's layout".
The RD-10a amendment requires `SSL_CERT_*` and `NODE_EXTRA_CA_CERTS` to
stay possible; the RD-11b one records that `production-mode` relies on
`NODE_EXTRA_CA_CERTS`.

Node 22's `cli.md` (the `v22.x` branch, read from
`raw.githubusercontent.com` on 2026-11-26) says:

| Setting | What it does |
| --- | --- |
| `NODE_OPTIONS` | Takes the allowed flags, among them `--use-openssl-ca`, `--use-system-ca`, `--openssl-config`, `--tls-min-v1.0`, `--tls-keylog`, `--insecure-http-parser`, `--require`, `--import` and `--inspect` |
| `NODE_USE_SYSTEM_CA=1` | Added in v22.19.0: trusts the system store as well as the bundled authorities |
| `OPENSSL_CONF` | Loads an OpenSSL configuration file at start |
| `SSL_CERT_FILE`, `SSL_CERT_DIR` | Read only "if `--use-openssl-ca` is enabled, or if `--use-system-ca` is enabled" on Linux |
| `NODE_EXTRA_CA_CERTS` | Adds the authorities in one file; read once, at launch |
| `NODE_USE_ENV_PROXY=1` | Added in v22.21.0: tunnels requests through `HTTPS_PROXY` |

Measured with the local Node.js, v22.23.4, in an empty environment,
counting `tls.getCACertificates("default")`: 116 by default; 606 with
`NODE_USE_SYSTEM_CA=1` or `NODE_OPTIONS=--use-system-ca`; 116 with
`NODE_USE_SYSTEM_CA` at `0` or empty, and with `SSL_CERT_FILE` or
`SSL_CERT_DIR` alone.
With `NODE_OPTIONS=--use-openssl-ca` the call lists 0, since OpenSSL's
own store is not listed by it (*inference*). `OPENSSL_CONF=/x`, a
missing file, does not stop a start, and neither do all three
together.

Docker is not available where this was written, so none of this was
measured against the image's Node.js (`node:22-trixie-slim`, pinned by
digest), whose exact version was not read. That the image behaves the
same is *inference*. CI's new web-image step runs the image itself.

## Decision 1 — Three names refused, any non-empty value

The schema (`packages/shared/src/env.ts`) reads `NODE_OPTIONS`,
`NODE_USE_SYSTEM_CA` and `OPENSSL_CONF` only to refuse them. Where the
configured `NODE_ENV` is production, a non-empty value of each gives
one issue, naming the setting and never its value:

```text
NODE_OPTIONS: NODE_OPTIONS must not be set in production: Node.js would take command-line options from it, some of which widen what it trusts
NODE_USE_SYSTEM_CA: NODE_USE_SYSTEM_CA must not be set in production: Node.js would trust the system's certificate store as well as its own
OPENSSL_CONF: OPENSSL_CONF must not be set in production: Node.js would load an OpenSSL configuration file at start
```

An empty value names nothing and is accepted, as for `NODE_DEBUG`.
Development and tests keep all three. Node.js reads each as the process
starts, so nothing can undo it later; the start is refused instead.
The refusal comes after Node.js has applied them: code that
`NODE_OPTIONS` loads, such as a `--require` preload, or an `--inspect`
listener, runs before the start check. It stops a misconfigured start,
and is no defence against someone who controls the environment.

## Decision 2 — `NODE_OPTIONS` is refused whole

Its flags are not parsed. Which flags widen trust, turn a check off or
load code is Node.js's to change, and a parser would have to follow
every release. A deployment that later needs a flag, such as a heap
size, amends this by a new ADR with an allowlist. Node.js 22 sizes its
heap from the container's memory limit (*inference*: `cli.md` does not
say so), so none is needed now.

## Decision 3 — Three names stay open

`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and `SSL_CERT_DIR` are not
refused: the web image sets the `SSL_CERT_*` pair, and CI's
`production-mode` job trusts its authority through
`NODE_EXTRA_CA_CERTS` (`env.test.ts` holds all three as accepted).
With `NODE_OPTIONS` and `NODE_USE_SYSTEM_CA` refused, and while the
image's entrypoint (`node apps/web/server.js`, no flags) is used,
`SSL_CERT_*` no longer reach Node.js's own TLS (*inference* from
`cli.md`; measured above for each alone: 116). A deployment that
overrides the command or its arguments can still pass `--use-openssl-ca`
or `--use-system-ca`, which the schema cannot see. The image sets the
pair so that Prisma's engine does not set it from a thread of its own
(ADR-0175 Decision 5, ADR-0155); that is unchanged.

## Decision 4 — `NODE_USE_ENV_PROXY` is not refused

A proxy does not widen which certificates are trusted: the tunnel still
checks the server's (*inference*: `cli.md` says nothing of it). Both
image jobs already refuse an image whose environment names a proxy.

## Decision 5 — Reporting `NODE_EXTRA_CA_CERTS` stays open

Whether a production start should report that it is set, and where, is
not decided. The start check (`startup.ts`) reports only why a start
is refused (ADR-0151), and reads no setting's value but `NODE_ENV`'s,
asking the others only whether they are set (ADR-0159 Decision 5). A
report that does not refuse has no place there yet, and this milestone
leaves `startup.ts` unchanged.
`TODO.md` records it, and `OPENSSL_MODULES` and `OPENSSL_ENGINES`,
which load OpenSSL code and are not considered here.

## Decision 6 — Decided before the deployment's layout

The `TODO.md` item deferred this to the deployment's layout. It is
decided before it, as a CTO call: nothing deployed sets these names.
G1, the first deploy, may amend it by a new ADR.

## Decision 7 — What holds it

- `env.test.ts`: each name in production with `"x"` or `" "` gives
  exactly one issue; `""` passes; development and test pass; no value
  is repeated.
- `startup.test.ts`: a production start with `NODE_OPTIONS` ends with
  exit code 1 and the line. `startup.ts` is not changed.
- `bootstrap.test.ts`: the worker's `loadServerEnv` refuses all three.
  This test alone holds the worker's refusal: its image's command
  exits 2 without starting Node.js (`apps/worker/Dockerfile`,
  ADR-0151 Decision 4), so there is no worker production start for CI
  to run. No worker-image step is added.
- CI's web-image job, "Refuse it with settings that widen what Node.js
  trusts", right after the `NEXT_PHASE` step: the image run with three
  random, masked stand-in secrets and all three names, which must exit 1 and
  print the three lines. The stand-ins are needed because the schema's
  cross-field rules run only once every required setting is there;
  exit code 1 alone would prove nothing, since a missing
  `SESSION_SECRET` also ends a start with it.
- `container-images.test.ts` pins that step word for word and bans
  `NODE_USE_SYSTEM_CA` from either image's environment.

## Consequences

- An environment that sets one of the three names no longer starts in
  production. None in the repository does: not `ci.yml`, the
  Dockerfiles, the Playwright configs, the Vitest configs or a
  `package.json` script. GitHub's runners set none by default
  (*inference*); the first CI run checks it.
- Next.js gives its build workers a `NODE_OPTIONS` of their own. The
  build is not affected. The web image's build stage sets no
  `SESSION_SECRET` and passes, so the build parses no environment
  (*inference*). CI's `verify` build does set the three secrets; Next.js
  15.5 derives its workers' `NODE_OPTIONS` from the ambient one
  (`dist/lib/worker.js`), which is empty there (*inference*, as above),
  and an empty value is accepted. A local `next build` with stand-in
  secrets and a non-empty `NODE_OPTIONS` also passed (measured in
  review).

## Known gaps

- Not measured against the image's Node.js by digest (Docker was not
  available); the CI step is the first measurement.
- `OPENSSL_MODULES`, `OPENSSL_ENGINES` and reporting
  `NODE_EXTRA_CA_CERTS` stay open (`TODO.md`).

## Considered and not done

- **Parsing `NODE_OPTIONS`.** See Decision 2.
- **A worker-image step.** See Decision 7.
- **Refusing `NODE_EXTRA_CA_CERTS` or `SSL_CERT_*`.** See Decision 3.
