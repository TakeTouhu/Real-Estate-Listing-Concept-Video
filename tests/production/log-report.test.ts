import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/** The production-mode job's report of the web server's log (RD-11b), run as the job runs it. */
const SCRIPT = join(__dirname, "log-report.mjs");
const folder = mkdtempSync(join(tmpdir(), "log-report-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const TIME = "2026-11-26T01:34:18.803Z";
const json = (fields: Record<string, string>): string => JSON.stringify({ time: TIME, ...fields });
const START = ["   ▲ Next.js 15.5.28", "   - Local:        http://localhost:3000", " ✓ Ready in 198ms"];
const LIMIT = json({ severity: "WARNING", component: "rate-limit", code: "RATE_LIMITED", dimension: "client" });
const PROBE = json({ severity: "WARNING", component: "readiness", probe: "database", code: "P1001" });
const OUTAGE = json({
  severity: "ERROR",
  component: "request",
  route: "POST /api/auth/login",
  errorName: "RateLimiterUnavailable",
  code: "P1017",
  causeName: "PrismaClientKnownRequestError",
});
/** The error no catch takes, as PT-7b3's step causes it: the console bridge's line, then `onRequestError`'s. */
const PRINTED = json({
  severity: "ERROR",
  component: "console",
  method: "error",
  errorName: "TypeError",
  code: "UNEXPECTED",
});
const ANSWERED = json({
  severity: "ERROR",
  component: "request",
  route: "POST /api/auth/login",
  errorName: "TypeError",
  code: "UNEXPECTED",
  routeType: "route",
});
const UNCAUGHT = [PRINTED, ANSWERED];
/** The same error as Next.js printed it to stderr before PT-7b2 (Node.js 22.23.4's undici). */
const RAW = [
  "TypeError: Failed to parse body as FormData.",
  "    at node:internal/deps/undici/undici:5896:27",
  "    at successSteps (node:internal/deps/undici/undici:5940:27)",
];
/** The report step's two accepted reports as the endpoint logs them (PT-7c3): one line per mechanism. */
const reported = (mechanism: string, fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ severity: "INFO", time: TIME, message: "Browsers reported page policy violations",
    component: "csp-report", dropped: 0, violations: [{ mechanism, page: "/login", directive: "script-src-elem",
      blocked: "inline", disposition: "enforce", source: "other", count: 1, total: 1, ...fields }] });
const REPORTED = [reported("report-uri"), reported("report-to")];
const CLEAN = [...START, LIMIT, PROBE, OUTAGE, ...UNCAUGHT, ...REPORTED];

function report(lines: string[], values?: string[]) {
  const log = join(folder, "web.log");
  const summary = join(folder, "summary.md");
  writeFileSync(log, `${lines.join("\n")}\n`);
  writeFileSync(summary, "");
  const args = [SCRIPT, log];
  if (values !== undefined) {
    writeFileSync(join(folder, "values"), `${values.join("\n")}\n`);
    args.push(join(folder, "values"));
  }
  const ran = spawnSync(process.execPath, args, { encoding: "utf8", env: { GITHUB_STEP_SUMMARY: summary } });
  return { status: ran.status, out: ran.stdout, summary: readFileSync(summary, "utf8") };
}

describe("the production-mode log report", () => {
  it("counts a clean log by its seven fields alone and finds nothing", () => {
    const { status, out, summary } = report(CLEAN, ["a-value-of-this-run"]);
    expect(status).toBe(0);
    const header = "| severity | component | code | route | errorName | causeName | dimension | lines |";
    expect(out.split("\n")[0]).toBe(header);
    expect(out).toContain("| WARNING | readiness | P1001 |  |  |  |  | 1 |");
    expect(out).not.toContain("2026-11-26");
    expect(out.trimEnd().endsWith("No finding.")).toBe(true);
    expect(summary).toContain("No finding.");
  });

  it("accepts readiness's probe answering P1017 too, as CI's first run read it before P1001", () => {
    const closed = PROBE.replace("P1001", "P1017");
    const { status, out } = report([...START, LIMIT, closed, OUTAGE, PROBE, ...UNCAUGHT, ...REPORTED]);
    expect(status).toBe(0);
    expect(out).toContain("| WARNING | readiness | P1017 |  |  |  |  | 1 |");
  });

  it("stops on a listed value with exit 2, printing no table and summing up nothing", () => {
    const leaked = json({ severity: "INFO", component: "x", code: "tok-1" });
    const { status, out, summary } = report([...CLEAN, leaked], ["tok-1"]);
    expect([status, out, summary]).toEqual([2, "", ""]);
  });

  it.each([
    ["an unlisted error", [...CLEAN, json({ severity: "ERROR", component: "request", errorName: "TypeError" })]],
    ["an unlisted warning", [...CLEAN, json({ severity: "WARNING", component: "request", code: "ORIGIN_REFUSED" })]],
    ["another readiness code", [...CLEAN, PROBE.replace("P1001", "UNEXPECTED")]],
    ["a raw line", [...CLEAN, "TypeError: fetch failed"]],
    ["no severity", [...CLEAN, json({ component: "request", message: "x" })]],
    ["an unknown severity", [...CLEAN, json({ severity: "fatal", component: "request" })]],
    ["a lower-case severity", [...CLEAN, json({ severity: "warning", component: "request" })]],
    ["the old level field alone", [...CLEAN, json({ level: "info", component: "request" })]],
    ["no component", [...CLEAN, json({ severity: "INFO", message: "x" })]],
    ["no outage line", [...START, LIMIT, PROBE, ...UNCAUGHT, ...REPORTED]],
    ["two outage lines", [...CLEAN, OUTAGE]],
    ["another error's print", [...CLEAN, PRINTED.replace("TypeError", "PrismaClientInitializationError")]],
    ["another route's uncaught error", [...CLEAN, ANSWERED.replace("/api/auth/login", "/api/auth/register")]],
  ])("fails on %s", (_, lines) => {
    expect(report(lines).status).toBe(1);
  });

  it("counts the error no catch takes by its two lines, once each", () => {
    const { status, out } = report(CLEAN);
    expect(status).toBe(0);
    expect(out).toContain("| ERROR | console | UNEXPECTED |  | TypeError |  |  | 1 |");
    expect(out).toContain("| ERROR | request | UNEXPECTED | POST /api/auth/login | TypeError |  |  | 1 |");
  });

  it.each([
    ["the pair twice", [...CLEAN, ...UNCAUGHT], ["2 console lines", "2 request lines"], []],
    ["the print twice", [...CLEAN, PRINTED], ["2 console lines"], ["request lines"]],
    ["the request line twice", [...CLEAN, ANSWERED], ["2 request lines"], ["console lines"]],
    ["the print alone", [...START, LIMIT, PROBE, OUTAGE, PRINTED, ...REPORTED], ["0 request lines"], ["console lines"]],
    [
      "the request line alone",
      [...START, LIMIT, PROBE, OUTAGE, ANSWERED, ...REPORTED],
      ["0 console lines"],
      ["request lines"],
    ],
    ["neither", [...START, LIMIT, PROBE, OUTAGE, ...REPORTED], ["0 console lines", "0 request lines"], []],
    [
      "the raw print before PT-7b2",
      [...START, LIMIT, PROBE, OUTAGE, ...RAW, ANSWERED, ...REPORTED],
      ["0 console lines", "raw"],
      ["request lines"],
    ],
    [
      "the raw print beside the pair",
      [...CLEAN, ...RAW],
      ["a raw line that is not a start line"],
      ["console lines", "request lines"],
    ],
  ])("fails on %s, and says so, naming no count that holds", (_, lines, named, unnamed) => {
    const { status, out } = report(lines);
    expect(status).toBe(1);
    for (const text of named) expect(out).toContain(text);
    for (const text of unnamed) expect(out).not.toContain(text);
  });

  it("requires one line per report mechanism from the report step, and prints it by its seven fields", () => {
    const { status, out } = report(CLEAN, ["rd11-report-0123"]);
    expect(status).toBe(0);
    expect(out).toContain("| INFO | csp-report |  |  |  |  |  | 2 |");
  });

  it.each([
    ["no report-uri line", [...START, LIMIT, PROBE, OUTAGE, ...UNCAUGHT, reported("report-to")], ["0 report-uri"]],
    ["no report line", [...START, LIMIT, PROBE, OUTAGE, ...UNCAUGHT], ["0 report-uri", "0 report-to"]],
    ["the report-to line twice", [...CLEAN, reported("report-to")], ["2 report-to"]],
    ["another page", [...CLEAN, reported("report-uri", { page: "(other)" })], ["a page policy report line"]],
    ["a pattern for the sign-in page", [...START, LIMIT, PROBE, OUTAGE, ...UNCAUGHT, reported("report-to"),
      reported("report-uri", { page: "/properties/[propertyId]" })], ["a page policy report line", "0 report-uri"]],
    ["another blocked", [...CLEAN, reported("report-uri", { blocked: "external" })], ["a page policy report line"]],
    ["a warning", [...CLEAN, reported("report-uri").replace('"INFO"', '"WARNING"')], ["a page policy report line"]],
    ["two violations in a line", [...CLEAN, reported("report-uri").replace("}]}", "},{}]}")],
      ["a page policy report line"]],
  ])("fails on a page policy report log with %s, and says so", (_, lines, named) => {
    const { status, out } = report(lines);
    expect(status).toBe(1);
    for (const text of named) expect(out).toContain(text);
  });

  it("stops with exit 2 on the report step's mark anywhere in the log", () => {
    const leaked = reported("report-uri").replace('"/login"', '"/login?run=rd11-report-0123"');
    expect(report([...CLEAN, leaked], ["rd11-report-0123"]).status).toBe(2);
  });

  it("prints a field that is not a plain word or route as (other)", () => {
    const { status, out } = report([...CLEAN, json({ severity: "INFO", component: "x", code: "https://h/?t=a@b" })]);
    expect(status).toBe(0);
    expect(out).toContain("| INFO | x | (other) |");
    expect(out).not.toContain("t=a@b");
  });
});
