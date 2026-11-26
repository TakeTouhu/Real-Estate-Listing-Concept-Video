# ADR-0178 — The production-mode test against stand-ins

Status: Accepted (RD-11a, 2026-11-26). The eleventh milestone of
production readiness, part 1, approved by the product owner on
2026-11-16. Four reports and a decision in `/mnt/project-files/cto/rd-11/`
shape it; `decision.md` adopts `critic.md` §1 to §4 as written. RD-11a
builds Decisions 1 to 4, 6, 7, 10 (its grep) and 11, and its halves of 5
and 8; RD-11b builds 9, 13 and the rest of 5, 8 and 10; 12 records limits.
**Amends ADR-0175 Decision 1.** ADR-0174 stays as written.

Builds on: ADR-0158 (the metadata server's fixed name), ADR-0159
Decision 7 (Google's names redirected, by hand), ADR-0167
(`NODE_EXTRA_CA_CERTS` not refused), ADR-0170, ADR-0175 to ADR-0177.

## Decision 1 — One CI job, no script

`production-mode` runs on every push and pull request
(`ubuntu-24.04`, 60 minutes, `contents: read`), so a pull request shows
16 checks. It builds the web image with the guarded command and runs it
against stand-ins. Its steps are the procedure; no script repeats them.
Waits are bounded loops in steps that each have a time limit.

## Decision 2 — A stand-in job (amends ADR-0175 Decision 1)

Beside ADR-0175's image jobs, a "stand-in job" may build an image, use
`pnpm/action-setup` and `actions/setup-node`, and run `docker network
create`, `connect` and `rm`; so the web image is built by two jobs, each
with the guarded command. The guard lists it in `STAND_IN_JOBS`: no
step `env:` or `services:`; every container the image built here or a
pinned job variable, read as the first word after known options, and
each container and network held word for word; no `docker exec` option;
no `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_OPTIONS`, `SSL_CERT_`, storage
endpoint, `-k` (alone or among other flags), `--insecure`,
`--no-check-certificate`, `--entrypoint`, `--privileged` or Docker
socket.

## Decision 3 — The image as built

The web container keeps its entrypoint, start check and the `web-image`
job's flags; it gets the sixteen settings and this run's authority.

## Decision 4 — Two networks, Google's names as aliases, no way out

`rd11-int` is `--internal`; the web app, ClamAV and the metadata
stand-in sit on it alone. PostgreSQL, the emulator, Mailpit and the
front start on `rd11-edge`, published on loopback only, and join
`rd11-int` by fixed address and name. There `storage.googleapis.com` is
the emulator (https on 443) and `metadata.google.internal` the
stand-in. A step requires both names to resolve to them in the web
container and `192.0.2.1` to be unreachable. The runner never resolves
or connects to a Google host; it names Google's store only as a leaf's
name, the alias and the lookup inside the web container.

## Decision 5 — One authority per run

`openssl` makes an EC authority valid one day and three leaves, then
deletes its key. The web container trusts it by `-e
NODE_EXTRA_CA_CERTS` and a read-only mount alone; the image's two
certificate names stay Debian's. `curl --cacert`, never `-k`, proves
the front's leaf. RD-11b's browser bypasses with `ignoreHTTPSErrors`,
in its configuration only.

## Decision 6 — The front, `APP_BASE_URL` and the client address

A Node.js front serves `https://app.rd11.test:8443`, the
`APP_BASE_URL`, and streams to the web's http, keeping `Host`,
appending one `X-Forwarded-For` entry; `FORWARDED_FOR_TRUSTED_ENTRIES`
is `1`, and `/etc/hosts` names the app on the runner. ADR-0174
Decision 10 counted on "RD-11's `http://localhost` run", which cannot
exist: production requires an `https` `APP_BASE_URL`, and each
cookie-based change an `Origin` equal to it. The page policy stays as
ADR-0174 set it; whether it gains `upgrade-insecure-requests` is not
decided here (`TODO.md`, RD-11a).

## Decisions 7 to 13

7. Five images, each by tag and index digest. PostgreSQL's is new
   (below), read from Docker Hub's tag listing on 2026-11-25 as an OCI
   index digest. On 2026-11-26 the registry's manifest for the tag,
   asked anonymously, answered with the same digest. A person bumps a
   digest by pull request.
8. Migrations run from the runner before the web starts; the bucket is
   made through the emulator's http port on loopback. RD-11b gives the
   plan the same way.
9. RD-11b counts the sign-up's mail and reads its link through
   Mailpit's API, printing neither (moved by the size rule).
10. RD-11a's log check: no secret, database password, metadata token
    or client-sent address; no `"component":"request"`,
    `CLIENT_ADDRESS_UNAVAILABLE`, `ORIGIN_REFUSED` or readiness line.
    The job's last step prints the web log unless this check found a
    value in it. RD-11b reports every line.
11. The worker image is not run: its default exits 2 (ADR-0176).
12. Not proved: Google's permissions, quotas and metadata server, real
    mail, the video path, the worker, a load balancer, database TLS.
13. RD-11b's browser runs on the emulator here; the development
    browser test keeps its folder (`TODO.md`, RD-4c).

PostgreSQL's pin (Decision 7):

```text
postgres:16.16-trixie@sha256:07abc3f43c9395b0bdbbab36bc25ddb0e8d83cd4fcafb5fb7d6abe14ff156dd8
```

## What was measured

Here, with no Docker daemon: the front, by `curl --cacert` (headers, a
streamed body, 64 MiB and chunked uploads, a chunked `DELETE`, headers
named in `Connection` dropped, `Range`, `HEAD`, 502); the metadata
stand-in, whose token the repository's client took and which survives
`GET //`; 93 mutations, each refused by the guard. Before the review
fixes (the front's chunked re-framing and `Connection` headers, the
stand-in's path parsing, the steps' markers and `umask`, each measured
on its own afterwards, not in the lab again), a production build, with
the image's environment and the job's settings, behind the front in a
private network namespace, against PostgreSQL 16 and fake-gcs 1.56.1
as `storage.googleapis.com`, passed these of the job's checks: liveness,
readiness `401` and `ready` with five checks and storage `adapter=gcs,
answers`, the server running 5 s later, one token request,
`ENETUNREACH` and a clean log. **Not measured**: ClamAV's `PONG`, the
names' addresses `.10` and `.11` (the lab named them in a hosts file),
and all that Docker does. CI runs them first.

## Consequences

16 checks, one more Docker Hub image, more minutes per event.
