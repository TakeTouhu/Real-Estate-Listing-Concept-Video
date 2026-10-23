import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What DS-5b-2b-2 may and may not have changed (ADR-0079). It adds no migration:
 * DS-5b-2a's shape test still pins migration 31 as the newest.
 *
 * 1. **No video without its master**: the finalize input requires the master's
 *    receipt, and Transaction J2 refuses one naming none before its transaction
 *    opens, then records the master on every commit.
 * 2. **No encode of the scenes into a video**: neither the composer's port nor
 *    the FFmpeg composer offers the one-pass `compose`, and its argument vector
 *    is gone from the package.
 *
 * The behaviour is the database suite's and the composer's; these pin the
 * source so a later change cannot quietly bring either back.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function source(...path: string[]): string {
  return code(readFileSync(join(REPO_ROOT, ...path), "utf8"));
}

/** The text from `start` to the first `end` after it, both of which must occur. */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(`${start}: ${from > -1}`).toBe(`${start}: true`);
  const to = text.indexOf(end, from);
  expect(`${end}: ${to > -1}`).toBe(`${end}: true`);
  return text.slice(from, to);
}

const ports = source("packages", "domain", "src", "deliverable-composition-execution", "ports.ts");

describe("DS-5b-2b-2 shape", () => {
  it("requires the master's receipt on every finalize", () => {
    const input = between(ports, "export interface FinalizeCompositionInput {", "}");
    expect(input).toContain("readonly cleanMaster: CleanMasterReceipt;");
    expect(input.includes("null")).toBe(false);
  });

  it("has J2 refuse a missing receipt before its transaction, and record the master on every commit", () => {
    const repository = source("packages", "database", "src", "deliverable-composition-execution-repository.ts");
    const finalize = between(repository, "async finalizeComposition(", "async deferComposition(");
    const guard = finalize.indexOf("if (cleanMaster === null || cleanMaster === undefined) {");
    const refused = finalize.indexOf(`throw new DeliverableCompositionExecutionDefect("CLEAN_MASTER_RECEIPT_MISSING");`);
    expect(guard).toBeGreaterThan(-1);
    expect(refused).toBeGreaterThan(guard);
    expect(refused).toBeLessThan(finalize.indexOf("prisma.$transaction("));
    // Nothing after the guard asks again whether there is a master.
    expect(finalize.match(/cleanMaster (===|!==) null/g)).toEqual(["cleanMaster === null"]);
    expect(finalize.includes("if (input.cleanMaster")).toBe(false);
    expect(finalize.split("tx.generationDeliverableCleanMaster.create(").length - 1).toBe(1);
  });

  it("offers no encode of the scenes into the customer's video", () => {
    const composer = between(ports, "export interface DeliverableMediaComposer {", "\n}");
    expect(composer.match(/^\s+(\w+)\(/gm)?.map((line) => line.trim())).toEqual([
      "composeCleanMaster(",
      "applyDisclosure(",
    ]);
    const ffmpeg = source("packages", "storage", "src", "managed-output", "ffmpeg-composer.ts");
    expect(ffmpeg.includes("async compose(")).toBe(false);
    expect(ffmpeg.includes("ffmpegComposeArgsFor")).toBe(false);
    const exported = source("packages", "storage", "src", "managed-output", "index.ts");
    expect(exported.includes("ffmpegComposeArgsFor")).toBe(false);
  });
});
