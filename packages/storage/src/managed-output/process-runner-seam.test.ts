/**
 * The subprocess seam extraction, proved to be a move and nothing more.
 *
 * `ProcessRunner` was declared inside the media inspector's module until a
 * second adapter needed it. Moving a type is exactly the kind of change that
 * looks free and is not: it can widen a deliberately narrow interface, silently
 * fork it into two near-identical declarations, or introduce a new place that
 * launches a program. This suite pins that none of those happened.
 *
 * It asserts on the extracted module's *source* rather than only on its types,
 * because a type-level test cannot notice a runtime import appearing in a file
 * that is supposed to have none.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exitedWith, FakeProcessRunner, ffprobeDocument, videoStream } from "../testing/media-fakes";
import {
  DEFAULT_PROBE_MAX_STDOUT_BYTES,
  DEFAULT_PROBE_PROGRAM,
  DEFAULT_PROBE_TIMEOUT_MS,
  FfprobeMediaProbe,
  classifyProcessError,
  ffprobeArgsFor,
} from "./ffprobe";
import type { ProcessRunInput, ProcessRunOutcome, ProcessRunner } from "./process-runner";

const CORE_DIR = __dirname;
const PATH = "/tmp/managed-output-media-abc123/input";

/** Comments stripped, so prose naming a symbol is not mistaken for using it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function source(name: string): string {
  return code(readFileSync(join(CORE_DIR, name), "utf8"));
}

// ---------------------------------------------------------------------------

describe("the extracted seam is declarations only", () => {
  it("has no runtime code of any kind", () => {
    const seam = source("process-runner.ts");
    // A types-only module compiles to nothing. Anything below would mean the
    // seam had grown an implementation, and the one place that launches a
    // program would no longer be the one place.
    for (const banned of [
      "export function",
      "export const",
      "export class",
      "export default",
      "require(",
      "import ",
    ]) {
      expect(`${banned}: ${seam.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("names no process API, and no way to reach a shell", () => {
    const seam = source("process-runner.ts");
    for (const banned of [
      "node:child_process",
      "execFile",
      "execSync",
      "spawn(",
      "spawnSync",
      "exec(",
      "shell",
      "/bin/sh",
      "process.env",
    ]) {
      expect(`${banned}: ${seam.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("declares exactly the three members it declared before, and no more", () => {
    const seam = source("process-runner.ts");
    expect(seam.includes("export interface ProcessRunInput")).toBe(true);
    expect(seam.includes("export type ProcessRunOutcome")).toBe(true);
    expect(seam.includes("export interface ProcessRunner")).toBe(true);
    // Not a generic process abstraction. A fixed program, a fixed argument
    // vector, a timeout and an output ceiling — nothing that would let a caller
    // hand over a command string, an environment, a working directory or a
    // shell.
    expect([...seam.matchAll(/export (interface|type|const|function|class)/g)]).toHaveLength(3);
    for (const banned of ["cwd", "env", "stdin", "command"]) {
      expect(`${banned}: ${seam.includes(banned)}`).toBe(`${banned}: false`);
    }
  });
});

describe("the seam has one definition and one launch site", () => {
  it("is re-exported by the inspector, so no importer had to change", () => {
    const probe = source("ffprobe.ts");
    expect(
      probe.includes(
        'export type { ProcessRunInput, ProcessRunOutcome, ProcessRunner } from "./process-runner"',
      ),
    ).toBe(true);
    // Re-exported, never re-declared. A second declaration would typecheck
    // structurally and then drift.
    for (const banned of [
      "export interface ProcessRunInput",
      "export type ProcessRunOutcome =",
      "export interface ProcessRunner",
    ]) {
      expect(`${banned}: ${probe.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("leaves the inspector as the only file that launches a program", () => {
    const probe = source("ffprobe.ts");
    expect(probe.includes('from "node:child_process"')).toBe(true);
    expect(probe.includes("execFile(")).toBe(true);
    expect(probe.includes("shell: false")).toBe(true);
    for (const banned of ["shell: true", "execSync", "spawnSync", "/bin/sh"]) {
      expect(`${banned}: ${probe.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("has the composer reach the seam directly, never through the inspector", () => {
    const composer = source("ffmpeg-composer.ts");
    expect(composer.includes('from "./process-runner"')).toBe(true);
    expect(composer.includes('from "./ffprobe"')).toBe(false);
    expect(composer.includes("node:child_process")).toBe(false);
  });
});

describe("the inspector's behaviour through the extracted seam is unchanged", () => {
  it("still builds the documented argument vector with the path last", () => {
    const args = ffprobeArgsFor(PATH);
    expect(args.at(-1)).toBe(PATH);
    expect(args.filter((arg) => arg === PATH)).toHaveLength(1);
  });

  it("still passes the documented program and bounds to the runner", async () => {
    const runner = new FakeProcessRunner({
      outcome: exitedWith(ffprobeDocument({ streams: [videoStream(1920, 1080)] })),
    });
    // Typed as the *extracted* seam, so this fails to compile if the inspector
    // ever starts requiring something the moved interface does not declare.
    const asSeam: ProcessRunner = runner;
    await new FfprobeMediaProbe({}, { runner: asSeam }).probe(PATH);

    const run = runner.lastRun;
    expect(run.program).toBe(DEFAULT_PROBE_PROGRAM);
    expect(run.timeoutMs).toBe(DEFAULT_PROBE_TIMEOUT_MS);
    expect(run.maxStdoutBytes).toBe(DEFAULT_PROBE_MAX_STDOUT_BYTES);
    expect(run.args).toEqual(ffprobeArgsFor(PATH));
  });

  it("still classifies host and process failures into the same five outcomes", () => {
    // The classifier is what turns an opaque failure into something a customer
    // may be told about, so the mapping is pinned here as well as in the
    // inspector's own suite: an extraction that changed it would change what a
    // customer is told, not merely where a type lives.
    const failure = (properties: Record<string, unknown>): Error =>
      Object.assign(new Error("diagnostic text"), properties);
    const outcomes: ProcessRunOutcome[] = [
      classifyProcessError(failure({ code: 1 }), "{}"),
      classifyProcessError(failure({ code: "ENOENT" }), ""),
      classifyProcessError(failure({ code: "EACCES" }), ""),
      classifyProcessError(failure({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), ""),
      classifyProcessError(failure({ killed: true, signal: "SIGTERM" }), ""),
      classifyProcessError(failure({ signal: "SIGKILL" }), ""),
      classifyProcessError(failure({ code: "EMFILE" }), ""),
      // A non-object error cannot be read at all; guessing would be a claim
      // about the deployment.
      classifyProcessError(null, "{}"),
    ];
    expect(outcomes.map((outcome) => outcome.kind)).toEqual([
      "EXITED",
      "LAUNCH_FAILED",
      "LAUNCH_FAILED",
      "OUTPUT_TOO_LARGE",
      "TIMED_OUT",
      "TRANSIENT_FAILURE",
      "TRANSIENT_FAILURE",
      "TRANSIENT_FAILURE",
    ]);
    // Only a genuine numeric status carries stdout, and only there.
    expect(outcomes[0]).toEqual({ kind: "EXITED", exitCode: 1, stdout: "{}" });
    // None of them carries the error's own text across the seam.
    expect(JSON.stringify(outcomes).includes("diagnostic text")).toBe(false);
  });

  it("accepts a bare structural runner, so the seam stayed narrow", () => {
    const seen: ProcessRunInput[] = [];
    const minimal: ProcessRunner = {
      async run(input) {
        seen.push(input);
        return { kind: "TIMED_OUT" };
      },
    };
    expect(typeof minimal.run).toBe("function");
    expect(seen).toHaveLength(0);
  });
});
