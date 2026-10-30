import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The development pipeline's assembly builds the steps and runs none of them
 * (GS-9b, ADR-0106). The pipeline command (GS-9c) will be what runs them, when
 * a person or a test starts it; until then nothing reaches this folder.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const FOLDER = __dirname;

/** Comments stripped, so prose naming a symbol is not mistaken for using it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function sourceFiles(dir: string): { name: string; text: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === ".next" ? [] : sourceFiles(full);
    if (!/\.tsx?$/.test(entry.name) || entry.name.includes(".test.")) return [];
    return [{ name: full.slice(REPO_ROOT.length + 1), text: code(readFileSync(full, "utf8")) }];
  });
}

describe("the development pipeline's assembly", () => {
  it("runs no step, starts nothing by itself and reaches no network or real provider", () => {
    const files = sourceFiles(FOLDER);
    expect(files.map(({ name }) => name).sort()).toEqual([
      "apps/worker/src/development-pipeline/assembly.ts",
      "apps/worker/src/development-pipeline/photo-reader.ts",
    ]);
    for (const { name, text } of files) {
      for (const banned of [
        ".runOnce(",
        "runProviderOutputBatchOnce(",
        "runProviderOutputAttemptOnce(",
        "setInterval",
        "setTimeout",
        "setImmediate",
        "queueMicrotask",
        "process.on",
        "process.argv",
        "cron",
        "schedule(",
        "fetch(",
        "node:http",
        "node:https",
        "node:net",
        "undici",
        "axios",
        "@aws-sdk",
        "S3Client",
        "@app/ai-providers",
        "WaveSpeed",
        "createVideoProvider",
        "FalH3MaxSubmissionProvider",
        "FalQueueCompletionStatusSource",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("is reachable from no application's start-up or route", () => {
    const outside = [
      ...sourceFiles(join(REPO_ROOT, "apps", "worker", "src")).filter(
        ({ name }) => !name.startsWith("apps/worker/src/development-pipeline/"),
      ),
      ...sourceFiles(join(REPO_ROOT, "apps", "web", "src")),
      ...sourceFiles(join(REPO_ROOT, "apps", "ops", "src")),
    ];
    for (const { name, text } of outside) {
      expect(`${name}: ${text.includes("development-pipeline")}`).toBe(`${name}: false`);
    }
    const worker = readFileSync(join(REPO_ROOT, "apps", "worker", "package.json"), "utf8");
    expect(worker.includes("development-pipeline")).toBe(false);
  });
});
