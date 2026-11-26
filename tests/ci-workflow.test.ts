import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * When CI runs, and the one PostgreSQL every job runs (PT-6a, ADR-0179), read as text. The workflow's head is
 * compared whole; a line holding a credential is never compared or printed.
 */
const WORKFLOW = readFileSync(join(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
const LINES = WORKFLOW.split(/\r?\n/);

/** The workflow's own lines before `jobs:`, comments and blank lines left out. */
function head(): string[] {
  const end = LINES.indexOf("jobs:");
  return LINES.slice(0, end).filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
}

describe("the CI workflow", () => {
  it("runs once per commit: main's on push, a pull request's on pull_request, a newer commit cancelling its run", () => {
    expect(LINES.indexOf("jobs:")).toBeGreaterThan(0);
    expect(head()).toEqual([
      "name: CI",
      "on:",
      "  push:",
      "    branches: [main]",
      "  pull_request:",
      "concurrency:",
      "  group: ci-${{ github.event.pull_request.number || github.sha }}",
      "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    ]);
  });

  it("names no other trigger and sets no other concurrency in any job", () => {
    const keys = LINES.filter((line) => /^\s*(on|concurrency|workflow_dispatch|schedule|workflow_run):/.test(line));
    expect(keys).toEqual(["on:", "concurrency:"]);
  });

  it("runs every PostgreSQL by the production-mode job's tag and index digest", () => {
    const pinned = LINES.map((line) => /^\s+PG_IMAGE: (\S+)$/.exec(line)?.[1]).filter(Boolean);
    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toMatch(/^postgres:16\.\d+-trixie@sha256:[0-9a-f]{64}$/);
    const services = LINES.map((line) => /^\s+image: (postgres\S*)$/.exec(line)?.[1]).filter(Boolean);
    expect(services).toEqual([pinned[0], pinned[0]]);
    expect(LINES.filter((line) => /\bpostgres:\d/.test(line)).map((line) => line.trim())).toEqual([
      `image: ${pinned[0]}`,
      `image: ${pinned[0]}`,
      `PG_IMAGE: ${pinned[0]}`,
    ]);
  });
});
