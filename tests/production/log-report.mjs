/**
 * The production-mode job's report of the web server's log (RD-11b, ADR-0178
 * Decision 10): `node log-report.mjs <web.log> [values...]`. It counts the
 * JSON lines by seven fields and prints no other field; a raw line must be one
 * of Next.js's start lines, and a JSON line must have one of the logger's four
 * severities (PT-7a, ADR-0181) and a component. It fails on any other line,
 * on any `ERROR` line but the one the database outage step causes (exactly
 * one) and the two of the error no catch takes, which the uncaught-error step
 * causes: Next.js's print through the console bridge and `onRequestError`'s
 * line (PT-7b3, ADR-0187; exactly one each), and on any `WARNING` but a
 * refusal by the client address's limit or readiness's database probe
 * answering `P1001` or `P1017` during the outage (CI's first run read both:
 * a stopped server closes the open connection, then refuses new ones). It
 * requires exactly one `csp-report` line per report mechanism, each `INFO`,
 * naming one violation, the sign-in page's with an inline script refused, as
 * the report step posts them (PT-7c3, ADR-0189), and fails on any other
 * `csp-report` line: one for the report from another origin's page among them.
 * A listed value in the log (one per line of each `values` file) fails it with
 * exit 2 and prints nothing more. Node.js built-ins only.
 */
import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";

const FIELDS = ["severity", "component", "code", "route", "errorName", "causeName", "dimension"];
const START_LINES = [/^▲ Next\.js 15\.\d+\.\d+$/, /^- Local: +http:\/\/localhost:3000$/];
START_LINES.push(/^- Network: +http:\/\/0\.0\.0\.0:3000$/, /^✓ Starting\.\.\.$/, /^✓ Ready in \d+(?:\.\d+)?m?s$/);
const OUTAGE = { component: "request", route: "POST /api/auth/login", errorName: "RateLimiterUnavailable" };
/** A multipart sign-in with no boundary: `request.formData()` throws outside the route's `try` (ADR-0187). */
const UNCAUGHT = [
  ["console", { component: "console", method: "error", errorName: "TypeError" }],
  ["request", { component: "request", route: "POST /api/auth/login", errorName: "TypeError" }],
];
const matches = (entry, wanted) => Object.entries(wanted).every(([name, value]) => entry[name] === value);
const WARNINGS = [
  { component: "rate-limit", code: "RATE_LIMITED", dimension: "client" },
  { component: "readiness", probe: "database", code: "P1001" },
  { component: "readiness", probe: "database", code: "P1017" },
];
const SEVERITIES = ["DEBUG", "INFO", "WARNING", "ERROR"];
/** The report step's two accepted reports, one per mechanism (PT-7c3). */
const REPORTS = ["report-uri", "report-to"];
/** Whether a `csp-report` line is one the report step causes: one violation, the sign-in page's, inline refused. */
const expectedReport = (entry) => {
  const [only, ...more] = Array.isArray(entry.violations) ? entry.violations : [];
  const named = entry.severity === "INFO" && entry.dropped === 0 && more.length === 0;
  return named && only?.page === "/login" && only.blocked === "inline" ? REPORTS.indexOf(only.mechanism) : -1;
};
/** A field's value as printed: a plain word or route, else hidden. */
const shown = (value) => (typeof value === "string" && /^[\w ./:[\]-]{1,80}$/.test(value) ? value : "(other)");

const [logFile, ...valuesFiles] = process.argv.slice(2);
const log = readFileSync(logFile, "utf8");
const values = valuesFiles.flatMap((file) => readFileSync(file, "utf8").split("\n")).filter((value) => value !== "");
if (values.some((value) => log.includes(value))) {
  process.stderr.write("A value of this run reached the log\n");
  process.exit(2);
}

const counts = new Map();
const problems = [];
let outages = 0;
const uncaught = UNCAUGHT.map(() => 0);
const reports = REPORTS.map(() => 0);
for (const line of log.split("\n").map((each) => each.trim()).filter((each) => each !== "")) {
  let entry;
  try {
    entry = line.startsWith("{") ? JSON.parse(line) : undefined;
  } catch {
    entry = undefined;
  }
  if (entry === undefined || entry === null || typeof entry !== "object") {
    if (!START_LINES.some((start) => start.test(line))) problems.push("a raw line that is not a start line");
    continue;
  }
  const row = FIELDS.map((name) => (entry[name] === undefined ? "" : shown(entry[name]))).join(" | ");
  counts.set(row, (counts.get(row) ?? 0) + 1);
  if (!SEVERITIES.includes(entry.severity) || typeof entry.component !== "string") problems.push(`a JSON line: ${row}`);
  const which = UNCAUGHT.findIndex(([, wanted]) => matches(entry, wanted));
  if (entry.severity === "ERROR" && matches(entry, OUTAGE)) outages += 1;
  else if (entry.severity === "ERROR" && which !== -1) uncaught[which] += 1;
  else if (entry.severity === "ERROR") problems.push(`an error line: ${row}`);
  if (entry.component === "csp-report") {
    const mechanism = expectedReport(entry);
    if (mechanism === -1) problems.push(`a page policy report line: ${row}`);
    else reports[mechanism] += 1;
  }
  if (entry.severity === "WARNING" && !WARNINGS.some((wanted) => matches(entry, wanted))) {
    problems.push(`a warning: ${row}`);
  }
}
if (outages !== 1) problems.push(`${outages} lines for the sign-in during the database outage, 1 expected`);
UNCAUGHT.forEach(([component], i) => {
  if (uncaught[i] !== 1) problems.push(`${uncaught[i]} ${component} lines for the error no catch took, 1 expected`);
});
REPORTS.forEach((mechanism, i) => {
  if (reports[i] !== 1) problems.push(`${reports[i]} ${mechanism} lines for the sign-in page's report, 1 expected`);
});

const table = [`| ${FIELDS.join(" | ")} | lines |`, `|${" --- |".repeat(FIELDS.length + 1)}`];
for (const [row, count] of [...counts].sort()) table.push(`| ${row} | ${count} |`);
const report = `${table.join("\n")}\n\n${problems.length === 0 ? "No finding." : problems.join("\n")}\n`;
process.stdout.write(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## The web log\n\n${report}`);
process.exit(problems.length === 0 ? 0 : 1);
