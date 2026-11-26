import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/csp-report` (ADR-0189): its answers, and that a refusal or a
 * report from another site's page writes no line. Only the environment is
 * stubbed; the route reads nothing else.
 */
const BASE = "https://app.example.test";
const env = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => env.value }));

const { POST } = await import("@/app/api/csp-report/route");
const { resetCspReportCountsForTests } = await import("@/lib/csp-report");

let lines: string[];
beforeEach(() => {
  env.value = { NODE_ENV: "test", APP_BASE_URL: BASE };
  resetCspReportCountsForTests();
  lines = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => void lines.push(line));
});
afterEach(() => vi.restoreAllMocks());

const REPORT = JSON.stringify({
  "csp-report": { "document-uri": `${BASE}/login`, "effective-directive": "script-src-elem", "blocked-uri": "inline" },
});
const BATCH = JSON.stringify([
  { type: "csp-violation", url: `${BASE}/login`, body: { documentURL: `${BASE}/login`, blockedURL: "eval" } },
]);
type Body = string | ReadableStream<Uint8Array>;
const post = (body: Body, type = "application/csp-report", headers: Record<string, string> = {}) =>
  POST(new Request(`${BASE}/api/csp-report`, {
    method: "POST",
    headers: { "content-type": type, ...headers },
    body,
    duplex: "half",
  } as RequestInit));
/** A body of `chunks` chunks of 4 KiB that records whether it was pulled and cancelled. */
function stream(chunks: number, pullThrows = false) {
  const seen = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pullThrows) throw new Error("pulled");
      seen.pulled += 1;
      if (seen.pulled > chunks) controller.close();
      else controller.enqueue(new Uint8Array(4096).fill(32));
    },
    cancel() {
      seen.cancelled = true;
    },
  });
  return { body, seen };
}

describe("POST /api/csp-report", () => {
  it("answers 204 with no body for each shape, and writes one line each", async () => {
    for (const [body, type] of [[REPORT, "application/csp-report"], [BATCH, "application/reports+json"]] as const) {
      const response = await post(body, type);
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    }
    expect(lines.map((line) => (JSON.parse(line) as { component: string }).component)).toEqual([
      "csp-report",
      "csp-report",
    ]);
  });

  it("answers 415 for another type, 400 for a body that is not JSON or not a report, and writes no line", async () => {
    expect((await post(REPORT, "text/plain")).status).toBe(415);
    expect((await post(REPORT, "application/json")).status).toBe(415);
    expect((await post("{", "application/csp-report")).status).toBe(400);
    expect((await post(BATCH, "application/csp-report")).status).toBe(400);
    expect((await post(REPORT, "application/reports+json")).status).toBe(400);
    expect((await post(JSON.stringify({ "csp-report": { "document-uri": "x".repeat(5000) } }))).status).toBe(400);
    expect(lines).toEqual([]);
  });

  it("answers 413 for a Content-Length past 16 KiB without pulling the body", async () => {
    const { body } = stream(5, true);
    expect((await post(body, "application/csp-report", { "content-length": "20480" })).status).toBe(413);
    expect(lines).toEqual([]);
  });

  it("answers 413 for a body with no length that streams past 16 KiB, and cancels it", async () => {
    const { body, seen } = stream(10);
    expect((await post(body)).status).toBe(413);
    expect(seen).toEqual({ pulled: 5, cancelled: true });
    const exact = stream(4);
    expect((await post(exact.body)).status).toBe(400);
    expect(exact.seen.cancelled).toBe(false);
    expect(lines).toEqual([]);
  });

  it("answers 204 and writes no line for a report from another site's page", async () => {
    const other = REPORT.replace(BASE, "https://evil.example");
    expect((await post(other)).status).toBe(204);
    expect(lines).toEqual([]);
  });

  it("imports nothing that reads a cookie, a session, the database or a limiter", () => {
    const web = join(__dirname, "..", "..", "apps", "web", "src");
    const imports = (file: string) =>
      [...readFileSync(join(web, file), "utf8").matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);
    expect(imports("app/api/csp-report/route.ts")).toEqual(["@/lib/csp-report", "@/lib/env", "@/lib/http"]);
    expect(imports("lib/csp-report.ts")).toEqual(["zod", "@app/observability"]);
  });
});
