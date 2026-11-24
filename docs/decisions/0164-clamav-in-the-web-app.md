# ADR-0164 — ClamAV in the web app

Status: Accepted (RD-5b, 2026-11-24). The second of two parts of the fifth
milestone of production readiness, part 1, which the product owner
approved on 2026-11-16
(`/mnt/project-files/cto/production-readiness-proposal.md`). It gives the
web app the ClamAV scanner of ADR-0163, chosen by two settings, and lets a
production start use it. RD-5 is complete with it.

Builds on: ADR-0163 (the scanner, how its answers are read, its idle
limit and what a deployment needs), ADR-0150 (the web app's adapters in
one place), ADR-0151 (what a production start allows), ADR-0154 (readiness
reads the start check), ADR-0121 (the browser test's environment).

## Context

RD-5a added `createClamAvScanner` to `@app/storage` and built it nowhere:
the web app still scanned with `PassthroughMalwareScanner`, which knows
only the EICAR test string and refuses production when built, and the
start check allowed no production scanner, so a production start was
refused for malware scanning whatever it was given. The decision
(`/mnt/project-files/cto/rd-5/decision.md`) leaves to this part the
settings, the choice, the production list, a log line for a scan that
could not be completed and the browser test's refusal.

## Decision 1 — Two settings

`CLAMAV_HOST` names the daemon: a DNS name or an IP address with no port,
by `isClamAvHost`, the rule the adapter applies when built. `CLAMAV_PORT`
is its TCP port, a whole number from 1 to 65535 written in plain digits
(`isClamAvPort`), 3310 unless set (`CLAMAV_DEFAULT_PORT`); a port without a
host is refused. The port stays text in the parsed settings and the
adapters turn it into a number, so a wrong port is reported beside every
other refusal of the same start rather than hiding them. Each refusal is
one fixed sentence, given once, that repeats nothing it was given, since
the start check prints the schema's messages (ADR-0151). Neither setting
is a secret: clamd asks no credential (ADR-0163 Decision 6).

## Decision 2 — The choice

`CLAMAV_HOST` set chooses `clamav`, in every environment; unset chooses
`passthrough`, the test scanner, as before. The daemon is a production
adapter, so nothing refuses it outside production: a developer may point
the web app at a local daemon, and the container suite builds it from the
settings. The test scanner still refuses production when built.

## Decision 3 — What a production start allows

`PRODUCTION_ADAPTERS.malwareScanner` is `["clamav"]`. A production start
without `CLAMAV_HOST` is refused, as before, with `malware scanning:
"passthrough" is not a production adapter`. A production start is still
refused for email until RD-6.

No readiness probe asks the daemon, as ADR-0163 Decision 3 records: once
clamd's queue was full, `PING` waited 3.7 to 7.5 seconds, so a probe that
decides readiness would take the web app out of service during an upload
burst. A daemon that does not answer fails each scan instead, by its code,
and the photo fails and may be completed again. Whether the scanner counts
toward readiness stays open for part 2, with the deployment's layout
(TODO, "Open in RD-5a").

## Decision 4 — A scan that could not be completed is logged by its code

The web app's scanner, whichever is built, writes one warning for each
scan that ends `SCAN_FAILED`: `A malware scan could not be completed`,
with `component: "malware-scan"` and `code`. The code is the scan's
`detail` when that is one plain word (`/^[A-Z0-9][A-Z0-9_]{0,39}$/`, as
readiness filters a probe's code), such as `CLAMAV_IDLE` or
`ECONNREFUSED`, and `UNEXPECTED` otherwise. No message, host, port or
signature's name is logged. Only `SCAN_FAILED` is logged, so an `INFECTED`
verdict, and any detail the test scanner gives with it, never is; its
audit is unchanged. The verdict and its `detail` reach the domain as the
scanner gave them. Before, the owner saw "Malware scan could not be
completed", the audit recorded that reason, and nothing said why.

A log that cannot be written leaves the verdict as it was.

## Decision 5 — The browser test refuses both settings

The browser test runs no daemon, and Playwright passes the shell's
environment to the web app it starts. A `CLAMAV_HOST` from the shell would
have the test's uploads scanned by a daemon it does not start, or fail
them, so its environment refuses either setting, as it refuses the Cloud
Storage settings (ADR-0159).

## Considered and not done

- **A readiness probe of the daemon, now.** Decision 3; open for part 2.
- **Refusing the daemon outside production.** It is the production
  adapter, and a local daemon is how a developer sees what production
  does; the test scanner remains the default.
- **A rule on which hosts may name the daemon**, such as loopback or a
  private address only. Where clamd runs is decided with the deployment in
  part 2 (ADR-0163 Decision 6), and a rule now would guess at that layout.
- **Logging the scan's `detail` as it is.** The ClamAV adapter's codes are
  safe, but another scanner's `detail` might be a message: only a plain
  word is logged.

## What was measured

- The schema's suite takes a host and a port in production and refuses an
  empty or carrying host, a port of `0`, `65536`, `999999`, `abc`,
  `03310`, ` 3310`, `0x0cee`, `1e3`, full-width digits and others, and a
  port without a host, each by its fixed message once; a wrong port is
  reported beside a missing host and beside another setting's refusal.
- The web app's suite builds the daemon in production, once, and a
  stand-in daemon has been given no connection until it scans; asks
  stand-in daemons at the port given (`OK` is `CLEAN`, `FOUND` is
  `INFECTED`); logs a refused connection as `ECONNREFUSED` alone, with no
  port; logs nothing for the daemon's detection or the test scanner's;
  logs another scanner's message detail as `UNEXPECTED`, passing the
  detail itself on to the domain; and keeps the verdict when the log
  throws. Mutations that log the raw detail, log `INFECTED`, loosen the
  code's pattern, connect when built, drop the log's `catch` or ignore the
  port each fail it.
- The start check's suite allows `clamav` alone for malware scanning, and
  ends a production start with a wrong host and port with the schema's two
  lines, which carry neither value.
- The container suite (7 tests) passed against `clamav/clamav:1.5.5` on
  this machine, its new case scanning a clean JPEG and a JPEG with a ZIP
  holding `eicar.com` through the web app's adapters built from the
  settings. It names the daemon's port, but CI's is the default, so the
  port is proven by the web app's suite.
- The guard of ADR-0163 now allows the web app's adapters, and only them,
  to build the scanner: the worker never does.

## What cannot be shown here

- A deployment's daemon, its network and its CPUs: part 2 (ADR-0163).
- Where an operator reads the warning: the log goes where the web app's
  output goes, which the deployment decides.

## Consequences

- With `CLAMAV_HOST` set, every upload is scanned by ClamAV, in any
  environment; unset, by the test scanner, as before.
- A production start may now pass malware scanning; it is still refused
  for email until RD-6.
- `adapters.ts` exports `scanFailureCode` and `loggingScanFailures`;
  `@app/shared` exports `isClamAvPort`.
- No migration, route or page. Two optional settings.
