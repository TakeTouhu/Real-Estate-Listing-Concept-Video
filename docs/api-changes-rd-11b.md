# API Changes — RD-11b

Chromium drives the web image as built through the `production-mode`
job's TLS front (ADR-0178). **No migration, dependency, route, setting
or log change, and nothing under `apps/*/src` or `packages/*/src`.**

## Tests and CI

`tests/production/sign-up-to-storage.spec.ts`, run by
`pnpm test:production` (`playwright.production.config.ts`: no trace, a
screenshot on failure, one worker, no retry, `forbidOnly`, certificate
errors ignored there and on the invitee's page alone), under the
page-policy guard. A customer signs up
and verifies from Mailpit, where exactly one mail waits (the sign-up
proof RD-11a moved here, ADR-0178 Decision 9); sets up MFA; is given a
plan by the operator command; uploads two PNGs and a JPEG to `READY ·
640×480`, each signed `PUT` `200`, with a normalized and a thumbnail
object each in the emulator's bucket; and uploads a JPEG with the EICAR
file in a ZIP behind it, which ClamAV quarantines with no derivative.
One photo is read whole (`200`, the stored bytes), as bytes 0 to 1023
(`206`), by `HEAD` and past its end (`416`). A Creator joins from the
one invitation mail in a browser context of their own; the owner signs
out to `/login` and in again with the next TOTP code. The sign-in page
sends the production page policy with its nonce on every script.

A mailed link is handed to the page by a script, and a signed link is
read by the page itself, so no step title names either (measured:
`page.request` titles a step with its address, `page.evaluate` does
not). A failure while a mailed link's page is open is rethrown as one
fixed message, which keeps the link out of the run's output; a failed
step's own error still reaches the HTML report (measured in the lab
with a failed `toHaveURL`), so what runs there asserts on what the page
shows, never on its address. The report does carry the values typed
into the page: Playwright titles a `fill` step with its value, so both
people's addresses and throwaway passwords and the code used to sign in
again are in it, and a failure on the MFA page can leave the key in its
page snapshot (`TODO.md`, RD-11b). It is kept 7 days, only when the
browser's own step failed.

`runner.env` gains the emulator's loopback origin
(`GOOGLE_CLOUD_STORAGE_TEST_ENDPOINT`) and Mailpit's API port
(`MAILPIT_TEST_API_PORT`), for the spec's own reads on the runner. The
web container's settings (`web.env`) are unchanged, and the guard still
refuses `GOOGLE_CLOUD_STORAGE_ENDPOINT` in the job. The settings step
also writes `all-values`: this run's seven secrets, the client address
`203.0.113.7`, `rd11-typed-1` to `7` and `198.51.100.1` to `6`. The
spec writes `browser-values` beside it, mode 0600: both people's
addresses and passwords, the MFA key, the session cookie, each mailed
token and each signed upload and download token.

The job installs Chromium before the image is built; after RD-11a's
checks it runs the spec, makes six sign-ins with
six typed addresses and spoofed `X-Forwarded-For` entries (five refused
for the password, the sixth by the limit, one `RATE_LIMITED` line with
`dimension:"client"`), stops the
database (readiness `503`, a sign-in `303 /login?error=Sign+in+failed`)
and starts it again (readiness `200` within 30 tries of at most 20 s
each, the web app left running), and reports the server's log with
`tests/production/log-report.mjs`: counts by seven fields, a failure on
a raw line other than Next.js's start lines, a JSON line without one of
the logger's levels or a component, an error other than the one outage
line, or a warning other than the client limit's refusal and readiness's
database probe answering `P1001` or `P1017` (CI's first run read
`P1017` and then `P1001`: the stopped server closes the open connection
first); and exit 2, with one fixed line on stderr and no table, on any
value of `all-values` or `browser-values`.
The last step prints the web log only when it holds none of those
values, checked there whichever step failed.
`tests/production/log-report.test.ts` runs the report on samples. The
guard adds `docker stop db` and `start db`, the artifact
step, the browser's rules and the report and print steps word for
word, and the CSP guard's test takes in `tests/production`. Also:
`plainPng` takes a colour; `signUpOwner` takes an opener that opens the
link and verifies (`pressVerify`) and returns the password and MFA key;
`provisionPremiumPlan` takes its environment.

## Departures from the plan, and ADR-0178

- **A 404 page is asked outside the browser.** Its policy is the
  production literal, but its prerendered scripts carry no nonce (0 of
  11 in the lab), so Chromium refuses them, as RD-9e measured, and the
  guard would fail; the spec checks the policy and records the count
  (`TODO.md`, RD-9).
- **RD-11a's log step stays as it was** and runs before the browser;
  the request and readiness lines it refuses are the outage step's, so
  the report after it reads them.
- **ADR-0178, read with this PR.**
  - Decision 2's list of what a stand-in job may use and run also takes
    in, for this job alone, `actions/upload-artifact@v4` on the
    browser's failure for `playwright-report/`, kept 7 days, and
    `docker stop db` and `docker start db` once each; the guard holds
    both word for word (critic C12, C13).
  - Decision 5's "in its configuration only" also takes in the
    invitee's page, which does not inherit the configuration's `use`
    (critic C5).
  - Decision 1's bounded waits are the job's. In the spec, the only
    waits are Playwright's own bounded `expect`, `expect.poll` and
    `waitForURL`, under the configuration's test, global, action and
    navigation timeouts.
