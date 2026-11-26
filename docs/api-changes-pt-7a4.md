# API Changes — PT-7a4

A production start refuses the settings that widen what Node.js trusts
(ADR-0184). Production readiness, part 2, approved by the product
owner on 2026-11-26. **No route, answer, stored value or migration
changes.** Only which environments a production start accepts.

## The environment schema, before and after

Before, a production start accepted any value of `NODE_OPTIONS`,
`NODE_USE_SYSTEM_CA` and `OPENSSL_CONF`; the schema did not read them.

Now, where the configured `NODE_ENV` is production, a non-empty value
of each ends the start with one line per name, and no value:

```text
  - NODE_OPTIONS: NODE_OPTIONS must not be set in production: Node.js would take command-line options from it, some of which widen what it trusts
  - NODE_USE_SYSTEM_CA: NODE_USE_SYSTEM_CA must not be set in production: Node.js would trust the system's certificate store as well as its own
  - OPENSSL_CONF: OPENSSL_CONF must not be set in production: Node.js would load an OpenSSL configuration file at start
```

- The web app ends with exit code 1 after "The web app cannot start in
  production. Invalid server environment configuration:", as for
  `NODE_DEBUG` and `NODE_TLS_REJECT_UNAUTHORIZED`.
- The worker's `loadServerEnv` throws the same lines. Its image runs no
  Node.js yet, so no worker start changes in practice.
- An empty value is accepted. Development and tests accept any value.
- `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR` and
  `NODE_USE_ENV_PROXY` are still accepted.
- The lines show only after every required setting is set: a start
  that also lacks `SESSION_SECRET` lists only the missing settings.

## Who is affected

- An operator whose production environment sets one of the three
  names. None in the repository does: not `.github/workflows/ci.yml`,
  either Dockerfile, the Playwright or Vitest configs, or a
  `package.json` script.

## Tests

- `packages/shared/src/env.test.ts`: each name in production with
  `"x"` or `" "` gives exactly one issue; `""` passes; development and
  test pass; production accepts `NODE_EXTRA_CA_CERTS` and Debian's
  `SSL_CERT_FILE` and `SSL_CERT_DIR`; the no-echo test carries all
  three.
- `apps/web/src/lib/startup.test.ts`: a production start with
  `NODE_OPTIONS` exits 1 with its line, and no value.
- `apps/worker/src/bootstrap.test.ts`: the worker refuses all three.
- `tests/container-images.test.ts`: the new web-image step word for
  word, right after "Refuse it with NEXT_PHASE naming the build", and
  `NODE_USE_SYSTEM_CA` banned from either image's environment.
- `.github/workflows/ci.yml`, web-image job: "Refuse it with settings
  that widen what Node.js trusts" runs the image with three stand-in
  secrets and all three names, and greps the three lines. No
  worker-image step: that image exits 2 without starting Node.js.

## Phase documentation

- Change log and release notes: this document and the Roadmap's PT-7a4
  paragraph, as for PT-7a to PT-7a3 (`CHANGELOG.md` stops at Phase
  5C).
- Architecture: `docs/architecture.md` names the new refusals. Sequence
  and entity-relationship diagrams: Not applicable; no flow or table
  changes.
- OpenAPI: Not applicable; no route changes.
- Database migration: Not applicable; see `docs/migration-notes.md`.
