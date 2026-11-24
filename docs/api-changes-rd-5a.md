# API Changes — RD-5a

The ClamAV scanner (ADR-0163). **No migration, no route, no page and no
new setting.** Nothing builds the scanner yet; RD-5b gives it to the web
app.

## HTTP

No change in any response. Completing an upload whose scanner throws, or
answers a verdict that is neither `CLEAN`, `INFECTED` nor `SCAN_FAILED`,
now ends the photo `FAILED` with "Malware scan could not be completed",
as `SCAN_FAILED` already did. Before, a throw left it `SCANNING` and an
unknown verdict let it go on. The test scanner the web app uses answers
neither, so no route behaves differently today.

## Environment

None for the application. The `test:clamav` suite reads
`CLAMAV_TEST_PORT`, the port of a ClamAV daemon on this machine.

## Internal API

### New

| Export | What it is |
| --- | --- |
| `createClamAvScanner({ host, port?, idleLimitMs? })` from `@app/storage` | a `MalwareScanner` that asks a ClamAV daemon over TCP by `zINSTREAM`, one connection per scan; refuses, as it is built, a host `isClamAvHost` refuses, a port outside 1 to 65535 or an idle limit that is not a whole number of milliseconds above zero, as `CONFIGURATION_ERROR` |
| `CLAMAV_IDLE_LIMIT_MS` from `@app/storage` | 60,000: how long a connection may be quiet either way |
| `CLAMAV_CHUNK_BYTES` from `@app/storage` | 65,536: the photo's bytes in each chunk |
| `ClamAvScannerOptions`, `ClamAvFailureCode` from `@app/storage` | its options, and the codes its `SCAN_FAILED` carries in `detail` |
| `isClamAvHost(value)` from `@app/shared` | whether text is a DNS name, an IPv4 address or an unbracketed IPv6 address, with nothing else |
| `CLAMAV_DEFAULT_PORT` from `@app/shared` | 3310 |

What `scan` answers:

| Verdict | `detail` |
| --- | --- |
| `CLEAN` | none |
| `INFECTED` | none: no signature's name |
| `SCAN_FAILED` | `CLAMAV_LIMITS_EXCEEDED`, `CLAMAV_SIZE_LIMIT`, `CLAMAV_ERROR`, `CLAMAV_EARLY_ANSWER`, `CLAMAV_CLOSED`, `CLAMAV_UNEXPECTED_ANSWER`, `CLAMAV_IDLE`, or the transport's code such as `ECONNREFUSED` |

It never throws.

### Changed

| Export | Change |
| --- | --- |
| `AssetService.completeUpload` (`@app/domain`) | goes on to image processing only on `CLEAN`; a throw or any verdict but `INFECTED` fails the photo |

### Unchanged

The `MalwareScanner` port, `PassthroughMalwareScanner`, the web app's
adapters and its production start check.

## Scripts and CI

`pnpm test:clamav` runs `tests/scanner/*.clamav.test.ts`, which
`pnpm test` excludes. CI's `storage` job runs it against a
`clamav/clamav:1.5.5` service container pinned by its digest.
