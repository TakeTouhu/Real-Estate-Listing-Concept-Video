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
const CLEAN = [...START, LIMIT, PROBE, OUTAGE];

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
    const { status, out } = report([...START, LIMIT, closed, OUTAGE, PROBE]);
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
    ["no outage line", [...START, LIMIT, PROBE]],
    ["two outage lines", [...CLEAN, OUTAGE]],
  ])("fails on %s", (_, lines) => {
    expect(report(lines).status).toBe(1);
  });

  it("prints a field that is not a plain word or route as (other)", () => {
    const { status, out } = report([...CLEAN, json({ severity: "INFO", component: "x", code: "https://h/?t=a@b" })]);
    expect(status).toBe(0);
    expect(out).toContain("| INFO | x | (other) |");
    expect(out).not.toContain("t=a@b");
  });
});
