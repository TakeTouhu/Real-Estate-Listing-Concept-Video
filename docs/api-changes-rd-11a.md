# API Changes — RD-11a

A CI job runs the web image as built for production against stand-ins
(ADR-0178). **No migration, dependency, route, setting or log change,
and nothing under `apps/*/src` or `packages/*/src`.**

## Tests and CI

New job `production-mode`: one authority and three leaves per run,
PostgreSQL, the emulator, ClamAV, Mailpit and a metadata stand-in on two
networks, the migrations from the runner, then the web image behind a
TLS front. Through the front with `curl --cacert` it requires liveness
`200`; readiness `401` without the token, `200` with it, five checks
`ok` and storage `adapter=gcs, answers`. It also requires the server
running 5 s later; inside the web container, Google's names on the
stand-ins, no route out and ClamAV's `PONG`; at least one token request
with `Metadata-Flavor: Google` and none with `Authorization`; a log
without this run's values or a request, origin, client-address or
readiness line. New: `tests/production/tls-front.mjs` and
`metadata-server.mjs`; the guard's `STAND_IN_JOBS`. A pull request shows
16 checks.
