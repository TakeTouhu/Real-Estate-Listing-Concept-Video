import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { isViolationText, redactViolation } from "./csp-guard";

const E2E_DIRECTORY = new URL("../", import.meta.url);

/** Every spec under `tests/e2e`, nested ones included, by its path from there. */
const SPECS = readdirSync(E2E_DIRECTORY, { recursive: true, encoding: "utf8" })
  .map((path) => path.split("\\").join("/"))
  .filter((path) => path.endsWith(".spec.ts") && !path.split("/").includes("node_modules"));

/** The production-mode job's specs under `tests/production` (RD-11b), which take the guard from here too. */
const PRODUCTION_DIRECTORY = new URL("../../production/", import.meta.url);
const PRODUCTION_SPECS = readdirSync(PRODUCTION_DIRECTORY, { recursive: true, encoding: "utf8" })
  .map((path) => path.split("\\").join("/"))
  .filter((path) => path.endsWith(".spec.ts") && !path.split("/").includes("node_modules"));

/**
 * The one spec without the guard, and why: it makes the policy refuse a script
 * on purpose, to see the refusal reported (PT-7c3). Every other spec keeps it.
 */
const UNGUARDED: Readonly<Record<string, string>> = {
  "csp-report.spec.ts": "a refusal is what it tests",
};

/** The guard's module as a spec at that path imports it. */
function guardFrom(spec: string): string {
  const relative = posix.relative(posix.dirname(spec), "support/csp-guard");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/** The direct imports from `@playwright/test` that bring a value, not only types, in either quote style. */
function playwrightValueImports(source: string): string[] {
  const statements = source.matchAll(/^import\s[^;'"]*?from\s*(["'])@playwright\/test\1;?$/gm);
  return [...statements].map(([statement]) => statement).filter((statement) => !/^import\s+type\s/.test(statement));
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("the browser test's Content Security Policy guard", () => {
  it("knows Chromium's refusals, and nothing else", () => {
    const refusal = "Refused to execute inline script because it violates the following Content Security Policy";
    expect(isViolationText(refusal)).toBe(true);
    expect(isViolationText("Refused to connect to 'ws://localhost:3210/_next/webpack-hmr'")).toBe(true);
    expect(isViolationText("Download the React DevTools for a better development experience")).toBe(false);
  });

  it("never prints a signed link's token", () => {
    expect(redactViolation("Refused to load the image 'http://localhost:3210/api/storage/download?token=abc.def'"))
      .toBe("Refused to load the image 'http://localhost:3210/api/storage/download?…'");
  });

  it("reads a nested spec's path to the guard", () => {
    expect(guardFrom("readiness.spec.ts")).toBe("./support/csp-guard");
    expect(guardFrom("billing/buy-units.spec.ts")).toBe("../support/csp-guard");
  });

  it("finds a value import from @playwright/test in either quote style, with or without a semicolon", () => {
    expect(playwrightValueImports(`import { test } from '@playwright/test'\nconst x = 1;`)).toHaveLength(1);
    expect(playwrightValueImports(`import {\n  expect,\n  test,\n} from "@playwright/test";`)).toHaveLength(1);
    expect(playwrightValueImports(`import { x } from "a"\nimport type { Page } from '@playwright/test'`)).toEqual([]);
  });

  it("runs on every spec: each takes test from the guard, and only types from @playwright/test", () => {
    expect(SPECS.length).toBeGreaterThan(0);
    for (const spec of SPECS.filter((path) => UNGUARDED[path] === undefined)) {
      const source = readFileSync(new URL(spec, E2E_DIRECTORY), "utf8");
      const guard = escape(guardFrom(spec));
      expect(source, spec).toMatch(new RegExp(`^import \\{ expect, test \\} from (["'])${guard}\\1;?$`, "m"));
      expect(playwrightValueImports(source), spec).toEqual([]);
    }
  });

  it("is left out of one spec alone, which takes test and expect from @playwright/test", () => {
    expect(Object.keys(UNGUARDED)).toEqual(["csp-report.spec.ts"]);
    for (const spec of Object.keys(UNGUARDED)) {
      const source = readFileSync(new URL(spec, E2E_DIRECTORY), "utf8");
      expect(playwrightValueImports(source), spec).toEqual(['import { expect, test } from "@playwright/test";']);
      expect(source, spec).not.toMatch(/from ["'][^"']*csp-guard["']/);
    }
  });

  it("runs on the production-mode job's specs too", () => {
    expect(PRODUCTION_SPECS.length).toBeGreaterThan(0);
    for (const spec of PRODUCTION_SPECS) {
      const source = readFileSync(new URL(spec, PRODUCTION_DIRECTORY), "utf8");
      const guard = escape(posix.join(posix.relative(posix.dirname(`production/${spec}`), "e2e"), "support/csp-guard"));
      expect(source, spec).toMatch(new RegExp(`^import \\{ expect, test \\} from (["'])${guard}\\1;?$`, "m"));
      expect(playwrightValueImports(source), spec).toEqual([]);
    }
  });
});
