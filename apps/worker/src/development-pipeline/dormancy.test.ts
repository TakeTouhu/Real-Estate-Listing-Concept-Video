import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The development pipeline's assembly builds the steps and runs none of them
 * (GS-9b, ADR-0106). The pipeline command (GS-9c, ADR-0108) runs them, and only
 * when a person or a test starts it: its entry point is the one file that reads
 * the command line, the command is the one file that runs a step's pass, and
 * nothing outside this folder reaches it but the worker's `pipeline` script.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const FOLDER = __dirname;
const ASSEMBLY = "apps/worker/src/development-pipeline/assembly.ts";
const ENTRY_POINT = "apps/worker/src/development-pipeline/cli.ts";
const COMMAND = "apps/worker/src/development-pipeline/command.ts";
const PHOTO_READER = "apps/worker/src/development-pipeline/photo-reader.ts";

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
    expect(files.map(({ name }) => name).sort()).toEqual([ASSEMBLY, ENTRY_POINT, COMMAND, PHOTO_READER]);
    for (const { name, text } of files) {
      for (const banned of [
        ".runOnce(",
        "runProviderOutputBatchOnce(",
        "runProviderOutputAttemptOnce(",
        "setInterval",
        "setTimeout",
        "setImmediate",
        "queueMicrotask",
        "node:timers",
        "scheduler.wait",
        "Atomics.wait",
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
        // The command runs each step's pass, as the assembly built it; it runs no single attempt.
        if (name === COMMAND && (banned === ".runOnce(" || banned === "runProviderOutputBatchOnce(")) continue;
        // The entry point reads the command line, and does nothing else of its own.
        if (name === ENTRY_POINT && banned === "process.argv") continue;
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("has the command run every step's pass, and build none of its own", () => {
    const command = sourceFiles(FOLDER).find(({ name }) => name === COMMAND)?.text ?? "";
    expect(command.match(/\.runOnce\(/g)).toHaveLength(11);
    expect(command.match(/\.runProviderOutputBatchOnce\(/g)).toHaveLength(1);
    for (const banned of ["assembleDevelopmentPipeline", "Runner(", "Repository(", "new ", "create"]) {
      // Fixed hosts and messages (`new Set(`, `new Map(`), the database address read (`new URL(`) and the refusals
      // (`new AppError(`); nothing else is built.
      const text = banned === "new " ? command.replace(/new (Set|Map|URL|AppError)\(/g, "") : command;
      expect(`${banned}: ${text.includes(banned)}`).toBe(`${banned}: false`);
    }
    // The entry point assembles the steps and hands them to the command; it runs none itself.
    const entry = sourceFiles(FOLDER).find(({ name }) => name === ENTRY_POINT)?.text ?? "";
    expect(entry).toContain("assembleDevelopmentPipeline(");
    expect(entry).toContain("refuseForeignAttempts(");
    expect(entry).toContain("runDevelopmentPipeline(");
    // The database's address is checked before the steps are built, so before any contact with it.
    const addressChecked = entry.indexOf("refuseRemoteDatabase(");
    expect([addressChecked > 0, addressChecked < entry.indexOf("assembleDevelopmentPipeline(")]).toEqual([true, true]);
    for (const banned of [".runOnce(", "runProviderOutputBatchOnce(", "BatchOnce"]) {
      expect(`${banned}: ${entry.includes(banned)}`).toBe(`${banned}: false`);
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
    // Only the worker's `pipeline` script names the folder: no start-up script, hook or other script.
    const worker = JSON.parse(readFileSync(join(REPO_ROOT, "apps", "worker", "package.json"), "utf8")) as {
      readonly scripts?: Readonly<Record<string, string>>;
    };
    const { pipeline, ...otherScripts } = worker.scripts ?? {};
    expect(pipeline).toBe("tsx src/development-pipeline/cli.ts");
    expect(JSON.stringify({ ...worker, scripts: otherScripts }).includes("development-pipeline")).toBe(false);
    // Nothing runs the script by itself: not the root's scripts, and not CI.
    const workflows = join(REPO_ROOT, ".github", "workflows");
    for (const file of [
      join(REPO_ROOT, "package.json"),
      ...readdirSync(workflows).map((entry) => join(workflows, entry)),
    ]) {
      const text = readFileSync(file, "utf8");
      for (const banned of ["development-pipeline", "cli.ts", "worker pipeline", "run pipeline"]) {
        expect(`${file}:${banned}: ${text.includes(banned)}`).toBe(`${file}:${banned}: false`);
      }
    }
  });
});
