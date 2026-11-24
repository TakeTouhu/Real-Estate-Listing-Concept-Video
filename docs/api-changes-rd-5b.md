# API Changes — RD-5b

ClamAV in the web app (ADR-0164). **No migration, no route and no page.**
Two optional settings.

## HTTP

No change in any response. With `CLAMAV_HOST` set, completing an upload
asks the ClamAV daemon: a clean photo goes on, a detection is
`QUARANTINED`, and a scan the daemon could not complete ends the photo
`FAILED` with "Malware scan could not be completed", as RD-5a set out.
Unset, the test scanner answers, as before.

Readiness asks no daemon. Its `start` check, which gives what the start
check refuses (ADR-0154), no longer names malware scanning for a
production environment with `CLAMAV_HOST` set.

## Environment

| Setting | What it is |
| --- | --- |
| `CLAMAV_HOST` | the ClamAV daemon's host: a DNS name or an IP address, with no port (`isClamAvHost`). Set, the web app scans with ClamAV in any environment; unset, with the test scanner |
| `CLAMAV_PORT` | its TCP port, a whole number from 1 to 65535 in plain digits; 3310 unless set; refused without `CLAMAV_HOST` |

Their refusals are fixed sentences that repeat no value. The browser
test refuses both.

## Internal API

### Changed

| Export | Change |
| --- | --- |
| `serverEnvSchema`, `ServerEnv` (`@app/shared`) | `CLAMAV_HOST?: string`, `CLAMAV_PORT?: string` (plain digits; the adapters turn it into a number) |
| `WebAdapterChoice.malwareScanner` (web app) | `"clamav" \| "passthrough"`, by `CLAMAV_HOST` |
| `createWebAdapters(env).malwareScanner()` (web app) | builds `createClamAvScanner({ host, port })` when `CLAMAV_HOST` is set, else the test scanner; either logs each `SCAN_FAILED` as `A malware scan could not be completed` with `component: "malware-scan"` and `code` |
| `PRODUCTION_ADAPTERS.malwareScanner` (web app) | `["clamav"]` |
| `e2eEnvironment` (browser test) | refuses `CLAMAV_HOST` and `CLAMAV_PORT` |

### New

| Export | What it is |
| --- | --- |
| `scanFailureCode(detail)` from `apps/web/src/lib/adapters.ts` | a scan's `detail` when it is one plain word, else `UNEXPECTED`: the code the warning carries |
| `loggingScanFailures(scanner)` from `apps/web/src/lib/adapters.ts` | the scanner, unchanged in what it answers, writing the warning for each `SCAN_FAILED` |
| `isClamAvPort(value)` from `@app/shared` | whether text is a port in plain digits, 1 to 65535 |

### Unchanged

`createClamAvScanner` and how it reads an answer, the `MalwareScanner`
port, `completeUpload`, the audit, the readiness probe's code and the
worker.

## Scripts and CI

None new. The ClamAV suite gains one case, the web app's scanner built
from the settings.
