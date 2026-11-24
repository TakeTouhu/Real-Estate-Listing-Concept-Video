# ADR-0163 — The ClamAV scanner

Status: Accepted (RD-5a, 2026-11-24). The first of two parts of the fifth
milestone of production readiness, part 1, which the product owner
approved on 2026-11-16
(`/mnt/project-files/cto/production-readiness-proposal.md`). It adds a
scanner that asks a ClamAV daemon, proves it in CI against a real one,
and makes the upload go on only on a clean verdict. Nothing builds the
scanner yet: RD-5b (ADR-0164) gives it to the web app.

Builds on: ADR-0008 Decision 5 (the scanner port and quarantine),
ADR-0054 Decision 5 (production scanning is mandatory; the test scanner
is not allowed there), ADR-0150 (the web app's adapters in one place),
ADR-0153 Decisions 1 and 3 and the product owner's answer of 2026-11-16
(a time limit that ends one connection is outside the rule on timers),
ADR-0156 Decision 8 (a service container in CI's `storage` job).

## Context

The `MalwareScanner` port has one adapter, `PassthroughMalwareScanner`,
which knows only the EICAR test string within a file's first 1,024 bytes
and is refused in production. ADR-0054 Decision 5 names ClamAV or an approved
vendor; the production readiness proposal chose ClamAV, self-hosted.

Four investigations, recorded in `/mnt/project-files/cto/rd-5/`
(`code.md`, `clamd.md`, `ci-and-records.md`, `critic.md`), read the
upload path, ran `clamav/clamav:1.5.5` on this machine, tried two
prototype clients against it and against stand-in daemons, and checked
each other. `decision.md` there records the choices. What they measured
and this decision rests on:

- clamd's `zINSTREAM` takes a photo as chunks, each after its four-byte
  big-endian length, ended by a length of zero. It answers one line ended
  by a NUL, `stream: OK` or `stream: <name> FOUND` or `... ERROR`, then
  closes its side.
- The repository's own test payload, a JPEG header followed by the EICAR
  string, is `stream: OK` to ClamAV. A real JPEG with a stored ZIP holding
  `eicar.com` appended, which the type check takes for a JPEG, is found.
- clamd reads a whole photo, then sends nothing until its scan ends, and
  a photo in its queue waits through that silence. On 4 CPUs the longest
  silence before an answer grew about 0.6 s per large photo in flight:
  37.8 s for 60, 69.8 s for 110. With a 30-second idle limit, 20 and 26
  of 60 healthy scans were given up, with the two prototypes; with 60
  seconds, none.
- Past clamd's `StreamMaxLength`, which answers with a size-limit refusal
  and closes, a client may see its write fail (`EPIPE`) before it reads
  that answer. With the limit lowered to 1 MiB and 24 MB photos, it did in
  14 and 16 of 20 runs. At the 100 MiB default this adapter read the
  answer in 20 of 20 runs of 100 MiB and one byte. Every run ended
  without a verdict of clean.
- clamd's `stream: OK` does not prove that it read everything: an
  appended archive nesting a member that expands past `MaxFileSize`, with
  EICAR after it, came back `OK`, with `AlertExceedsMax` off and on.
- The domain went on with any verdict but `INFECTED` and `SCAN_FAILED`,
  and a scanner that threw left the photo `SCANNING` for good, holding one
  of the Property's 20 places.

## Decision 1 — Our own client on `node:net`

`createClamAvScanner({ host, port?, idleLimitMs? })` in `@app/storage`
opens one TCP connection per scan, sends `zINSTREAM` and the photo in
64 KiB chunks, waiting whenever the connection asks it to, then a length
of zero. Nothing is written to disk. No library both ends a stalled scan
and reads one answer as strictly as Decision 2 asks. The host is a DNS
name or an IP address with no port, by `isClamAvHost` in `@app/shared`,
the rule RD-5b's settings will share; the port is 3310 unless given
(`CLAMAV_DEFAULT_PORT`). A host, port or idle limit it cannot use is
refused as it is built, as a `CONFIGURATION_ERROR` that repeats none of
them. Building it connects to nothing.

## Decision 2 — How an answer is read

The answer is read when the daemon closes its side.

| What the daemon sent before closing | Verdict | `detail` |
| --- | --- | --- |
| exactly `stream: OK` and its NUL, after the whole photo was sent | `CLEAN` | none |
| `stream: <name> FOUND`, the name one printable word | `INFECTED` | none |
| `stream: Heuristics.Limits.Exceeded.<...> FOUND` | `SCAN_FAILED` | `CLAMAV_LIMITS_EXCEEDED` |
| `INSTREAM size limit exceeded. ERROR` | `SCAN_FAILED` | `CLAMAV_SIZE_LIMIT` |
| any other answer ending ` ERROR` | `SCAN_FAILED` | `CLAMAV_ERROR` |
| a verdict before the whole photo was sent | `SCAN_FAILED` | `CLAMAV_EARLY_ANSWER` |
| nothing | `SCAN_FAILED` | `CLAMAV_CLOSED` |
| anything else: no NUL, two answers, more than 1,024 bytes | `SCAN_FAILED` | `CLAMAV_UNEXPECTED_ANSWER` |

"Sent" means the zero-length chunk's write has completed. A connection
that is refused, reset or broken is `SCAN_FAILED` with the transport's
own code (for example `ECONNREFUSED`), or `CLAMAV_UNREACHABLE` for an
error that carries none, unless the daemon's refusal had
already arrived, which is kept; a verdict cut off by a reset is never
read. A connection quiet for the idle limit is `CLAMAV_IDLE`. A scan
never throws, so a photo is never left being scanned by the adapter.

`Heuristics.Limits.Exceeded` means the daemon did not read the photo in
full: a scan that failed (ADR-0008's `SCAN_FAILED`, `FAILED` and
retryable), not a detection. The photo fails and may be scanned again, where `INFECTED` would quarantine a
clean photo for good. `detail` carries only these codes. No signature's
name leaves the adapter, so nothing can log it, and the audit is
unchanged.

## Decision 3 — The idle limit, and no deadline of our own

A connection quiet for 60 seconds either way is given up
(`CLAMAV_IDLE_LIMIT_MS`). It is `net.createConnection`'s own `timeout`
option, which ends that one connection: by the product owner's answer of
2026-11-16 it is set without asking. Our code keeps no timer. Sixty
seconds held for 60 large photos at once where 30 failed healthy scans;
at 110, past clamd's own queue of 100, 24 waited longer than 60 seconds
and would have failed. The cost is that a frozen daemon makes an upload wait about a minute
before it fails.

No deadline bounds a whole scan. Only a peer that never finishes but
sends or reads a byte more often than the idle limit escapes it; real clamd never did, and a deadline in
our code would have to be put to the product owner first. The risk is
recorded in TODO. Nor is there a `PING` or a readiness check: once
clamd's queue was full, `PING` waited 3.7 to 7.5 seconds, so a check
that decides readiness would take the web app out of service during an
upload burst. It is decided with the deployment's layout in part 2.

## Decision 4 — The upload goes on only on `CLEAN`

`completeUpload` quarantines on `INFECTED` and goes on to image
processing only on `CLEAN`. Any other verdict, and a scanner that throws,
fail the photo with "Malware scan could not be completed", as
`SCAN_FAILED` already did. This holds for every scanner, not only
ClamAV's. A failed photo may be completed again, which scans its stored
bytes again.

## Decision 5 — ClamAV in CI

CI's `storage` job runs a second service container,
`clamav/clamav:1.5.5` pinned by its digest, with the signature updater
and the mail filter off (`CLAMAV_NO_FRESHCLAMD`, `CLAMAV_NO_MILTERD`), so
it sends no request. The job waits for the image's own `PING` check, run
every 2 seconds; it loaded in about 14 seconds here, with no network.
`pnpm test:clamav` (`vitest.clamav.config.ts`) runs
`tests/scanner/*.clamav.test.ts` against it on `127.0.0.1` at
`CLAMAV_TEST_PORT`, and fails without that variable. The suite passes a
clean JPEG and PNG, finds EICAR, a ZIP holding it behind a real JPEG,
and that ZIP at the end of a photo as large as an upload may be. It
fails a photo past the daemon's limit, checking the verdict only (the
code can race, as measured with a lower limit), and a scan of a port no daemon listens on. An
upload through `completeUpload` ends `READY`, `QUARANTINED` and `FAILED`
there. The `1.5.5` tag moves with each image build, so a pulled digest
may lose its tag; should it stop being served, the job fails loudly and
`clamav/clamav:1.5.4@sha256:7054e3f34308c384ea43cd786ea17abf899bd44af40af9f1b099853d7a5c214e`
is the recorded fallback.

## Decision 6 — What a deployment needs

Recorded now, decided with the deployment in part 2, and kept in TODO:
clamd on a private network or as a sidecar on loopback, its port
reachable from the web app alone, since it speaks plain text, asks no
credential and answers `SHUTDOWN`; its scan limits never below the 1.5.5
defaults (`StreamMaxLength` and `MaxFileSize` 100 MiB, four times the
upload limit; `MaxScanSize` 400 MiB), since a file past `MaxFileSize` is
answered `OK` unscanned; `AlertBrokenMedia` off, since
sharp already fails a broken image. `AlertExceedsMax`,
`ScanImageFuzzyHash` and freshclam's updates are part 2's.

What keeps a hidden payload from a provider is not ClamAV alone: a
provider is only ever given the JPEG that sharp re-encodes from the
scanned bytes, never the upload, and that re-encode held neither an
appended ZIP nor EICAR (measured with the repository's sharp 0.33.5).

## Considered and not done

- **A ClamAV library.** None both ends a stalled scan by itself and reads
  one answer strictly.
- **A 30-second idle limit.** It failed healthy scans under a burst
  (Context).
- **`INFECTED` for `Heuristics.Limits.Exceeded`.** It would quarantine a
  clean photo that only met a limit (Decision 2).
- **The signature's name in `detail`.** No reader needs it, and a name in
  `detail` could reach a log.
- **A readiness check now.** Decision 3.
- **A sweep of photos left `SCANNING` by a restart mid-scan.** It needs a
  rule on when a scan is abandoned and a loop, both the product owner's;
  recorded in TODO.

## What was measured

- The adapter's unit suite (25 tests) runs on stand-in daemons on this
  machine: the framing of a 150,000-byte photo (two full chunks, 18,928
  bytes, then zero), an empty photo, each answer of Decision 2, an `OK`
  left open, a daemon that never answers or stops reading, an `OK` sent
  before a 16 MiB photo was, a refusal kept when the daemon closes and
  through a reset, an `OK` cut
  off by one, a refused connection, three scans at once, each refusal
  when it is built, and a guard that nothing in `apps/` or `packages/`
  builds the adapter yet.
- The container suite (6 tests) passed against `clamav/clamav:1.5.5` on
  this machine, the 25 MiB photo in about 1.4 seconds. Twenty scans of
  100 MiB and one byte there all ended `SCAN_FAILED` with
  `CLAMAV_SIZE_LIMIT`.
- The domain's two new tests fail on the code before Decision 4: a
  throwing scanner made `completeUpload` throw, and an unknown verdict
  ended the photo `READY`.

## What cannot be shown here

- How long clamd takes on the deployment's CPUs, and so whether 60
  seconds holds there: re-measure in part 2.
- A GitHub runner's start time for the service, and a cold pull.
- What a provider would do with the uploaded bytes: it is never given
  them.
- That the adapter waits whenever the connection asks it to, and counts
  the photo sent only once the zero-length chunk's write has completed:
  both are in the code, but no test fails when either is taken out.

## Consequences

- `@app/storage` exports `createClamAvScanner`, `CLAMAV_IDLE_LIMIT_MS`,
  `CLAMAV_CHUNK_BYTES` and their types; `@app/shared` exports
  `isClamAvHost` and `CLAMAV_DEFAULT_PORT`. Nothing builds the scanner,
  so the web app still scans with the test scanner, and a production
  start is still refused.
- An upload with a scanner that throws or answers an unknown verdict now
  ends `FAILED` instead of stuck `SCANNING` or processed.
- CI's `storage` job pulls ClamAV's image, about 160 MB, and needs about
  1 GiB for it.
- No migration, route, page or setting.
