import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What DS-1 may and may not have changed (ADR-0071).
 *
 * It adds the disclosure layer v1 table, its committed images and the renderer
 * that made them. Nothing draws the disclosure into a video yet: composition,
 * validation and both applications are as they were, and the renderer runs only
 * by hand.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".next" || name === "dist") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

function matching(root: string, pattern: RegExp): string[] {
  return sourceFiles(join(REPO_ROOT, root))
    .filter((file) => pattern.test(code(readFileSync(file, "utf8"))))
    .map((file) => file.slice(REPO_ROOT.length + 1))
    .sort();
}

describe("DS-1 shape", () => {
  it("renders the images only from the command run by hand", () => {
    expect(matching("packages", /(?<!function )renderDisclosureLayer\(/)).toEqual([
      "packages/storage/src/bin/render-disclosure-layers.ts",
    ]);
  });

  it("puts the disclosure into no video yet", () => {
    const layer = /AI_DISCLOSURE_TEXT|DISCLOSURE_LAYER_ASSETS|disclosureLayerFor|disclosureLayout|renderDisclosureLayer/;
    expect(matching("apps", layer)).toEqual([]);
    expect(matching("packages/storage/src/managed-output", layer)).toEqual([]);
    expect(matching("packages/domain/src/deliverable-composition-execution", layer)).toEqual([]);
    expect(matching("packages/domain/src/deliverable-validation", layer)).toEqual([]);
    expect(matching("packages/database/src", layer)).toEqual([]);
  });
});
