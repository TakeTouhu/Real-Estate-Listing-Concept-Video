import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GRANTABLE_PERMISSIONS } from "@app/domain";
import { NOT_YET_USED } from "./permission-names";

/**
 * The permissions page says "Nothing in VTaVision uses it yet." of exactly
 * the permissions no application or package code checks (ADR-0146 Decision
 * 4). A feature that starts checking one fails this until it takes the
 * permission off `NOT_YET_USED`.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

/** Source files of the applications and packages, less tests, test doubles and the vocabulary's own lists. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (["node_modules", ".next", "dist", "testing"].includes(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!/\.(ts|tsx)$/.test(name) || /\.(test|spec)\.tsx?$/.test(name)) return [];
    return ["roles.ts", "permission-names.ts"].includes(name) ? [] : [path];
  });
}

describe("permissions nothing uses yet", () => {
  it("are exactly those no application or package code names", () => {
    const code = ["apps", "packages"]
      .flatMap((dir) => sourceFiles(join(REPO_ROOT, dir)))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(GRANTABLE_PERMISSIONS.filter((permission) => !code.includes(`"${permission}"`))).toEqual(NOT_YET_USED);
  });
});
