import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The patch overrides of PT-6c and the one sharp the lockfile holds, read as text, and the one zod it holds (PT-6d),
 * a direct pin rather than an override. Each override lifts only the versions below its fix to that fix, so it stops
 * applying once every dependent asks for a fixed version.
 */
const ROOT = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  pnpm?: { overrides?: Record<string, string> };
};
const LOCK = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8").split(/\r?\n/);

/** The lines of a top-level lockfile section, up to the next top-level key. */
function section(name: string): string[] {
  const first = LOCK.indexOf(`${name}:`);
  if (first < 0) return [];
  const rest = LOCK.slice(first + 1);
  const end = rest.findIndex((line) => /^\S/.test(line));
  return end < 0 ? rest : rest.slice(0, end);
}

describe("the dependency overrides", () => {
  const overrides = Object.entries(manifest.pnpm?.overrides ?? {});

  it("are the two patch fixes, each lifting only the versions below it", () => {
    expect(overrides).toEqual([
      ["nanoid@<3.3.18", "3.3.18"],
      ["source-map-js@<1.2.2", "1.2.2"],
    ]);
    for (const [key, value] of overrides) expect(key).toBe(`${key.slice(0, key.indexOf("@<"))}@<${value}`);
  });

  it("are the lockfile's own, in the same order", () => {
    const locked = section("overrides").filter((line) => line.trim() !== "");
    expect(locked).toEqual(overrides.map(([key, value]) => `  ${key}: ${value}`));
  });

  it("leave one sharp in the lockfile, the fixed 0.35.5", () => {
    const sharp = section("packages").filter((line) => /^ {2}sharp@/.test(line));
    expect(sharp).toEqual(["  sharp@0.35.5:"]);
  });
});

describe("the zod pin (PT-6d)", () => {
  it("leaves one zod in the lockfile, the fixed 4.6.7", () => {
    const zod = section("packages").filter((line) => /^ {2}zod@/.test(line));
    expect(zod).toEqual(["  zod@4.6.7:"]);
  });
});
