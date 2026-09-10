import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyProviderCostExposure } from "../authorization/exposure";

/**
 * The two claims that are only worth anything if nobody can quietly undo them:
 * this phase changes no money classification, and nothing in production calls
 * it.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

describe("the Safety Guard's arithmetic is untouched", () => {
  it.each([
    ["PROCESSING", "ACCEPTED", "IN_FLIGHT"],
    ["PROVIDER_SUCCEEDED", "ACCEPTED", "IN_FLIGHT"],
    ["OUTPUT_INGESTING", "ACCEPTED", "IN_FLIGHT"],
    ["OUTPUT_VERIFIED", "ACCEPTED", "SETTLED_ESTIMATED"],
    ["FAILED_RETRYABLE", "ACCEPTED", "SETTLED_ESTIMATED"],
    ["FAILED_TERMINAL", "ACCEPTED", "SETTLED_ESTIMATED"],
    ["RECONCILIATION_EXHAUSTED", "SUBMISSION_UNKNOWN", "UNCERTAIN"],
    ["FAILED_TERMINAL", "DEFINITIVELY_REJECTED", "NONE"],
    ["FAILED_RETRYABLE", "DEFINITIVELY_REJECTED", "NONE"],
  ] as const)("classifies %s + %s as %s", (state, certainty, category) => {
    expect(classifyProviderCostExposure(state, certainty)).toBe(category);
  });

  it("never classifies a state this orchestration can reach as costing nothing", () => {
    // The orchestration moves attempts between exactly these states. If any of
    // them were ever classified NONE, a poll could silently erase a charge.
    for (const state of [
      "PROCESSING",
      "PROVIDER_SUCCEEDED",
      "OUTPUT_INGESTING",
      "OUTPUT_VERIFIED",
      "FAILED_RETRYABLE",
      "FAILED_TERMINAL",
    ] as const) {
      expect(classifyProviderCostExposure(state, "ACCEPTED")).not.toBe("NONE");
    }
  });

  it("is not modified by this phase", () => {
    // The classifier is imported and exercised, never redefined. A second
    // classification table in this module would be a second answer to a money
    // question.
    for (const name of readdirSync(__dirname).filter(
      (f) => f.endsWith(".ts") && !f.includes(".test."),
    )) {
      const text = readFileSync(join(__dirname, name), "utf8");
      for (const banned of [
        "IN_FLIGHT",
        "SETTLED_ESTIMATED",
        "UNCERTAIN",
        "classifyProviderCostExposure",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });
});

describe("nothing in production calls the orchestration", () => {
  /** Every source file outside this module and outside test files. */
  function productionSources(): { name: string; text: string }[] {
    const roots = [
      join(REPO_ROOT, "apps", "web", "src"),
      join(REPO_ROOT, "apps", "worker", "src"),
      join(REPO_ROOT, "packages", "database", "src"),
      join(REPO_ROOT, "packages", "video-providers", "src"),
    ].filter((dir) => existsSync(dir));

    const found: { name: string; text: string }[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          if (entry.name.includes(".test.")) continue;
          found.push({ name: full.slice(REPO_ROOT.length + 1), text: readFileSync(full, "utf8") });
        }
      }
    };
    for (const root of roots) walk(root);
    return found;
  }

  it("has no caller in any application, worker or adapter source", () => {
    // The phase is dormant by construction *and* by absence of a caller. If a
    // future PR wires a route, a startup path or a cron to either entry point,
    // this fails and the wiring gets the review it needs.
    for (const { name, text } of productionSources()) {
      for (const banned of [
        "runProviderOutputAttemptOnce",
        "runProviderOutputBatchOnce",
        "createProviderOutputRunner",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("keeps the database package free of provider adapters", () => {
    // The persistence layer reads columns. A provider SDK reaching it would put
    // a network client behind a repository interface, where no test would think
    // to look for one.
    const dir = join(REPO_ROOT, "packages", "database", "src");
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(join(dir, name), "utf8");
      for (const banned of [
        "@app/video-providers",
        "@app/ai-providers",
        "FetchHttpClient",
        "createVideoProvider",
        "WaveSpeedVideoProvider",
        "@aws-sdk",
        "@google-cloud",
      ]) {
        expect(`${name}:${banned}: ${text.includes(banned)}`).toBe(`${name}:${banned}: false`);
      }
    }
  });

  it("keeps the domain package free of provider adapters", () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, "packages", "domain", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const deps = Object.keys(pkg.dependencies ?? {});
    for (const banned of [
      "@app/video-providers",
      "@app/ai-providers",
      "@app/storage",
      "@aws-sdk/client-s3",
      "@google-cloud/storage",
      "axios",
      "undici",
      "node-fetch",
      "stripe",
    ]) {
      expect(`${banned}: ${deps.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("imports nothing but this repository's own modules", () => {
    // Both ports are plain interfaces returning `unknown`, and the whole unit
    // suite is built on object literals — no HTTP mock, no SDK stub, no fixture
    // server. That is the practical test of whether a seam is really a seam;
    // this is the structural one.
    for (const name of readdirSync(__dirname).filter(
      (f) => f.endsWith(".ts") && !f.includes(".test."),
    )) {
      // Comments stripped first: prose quoting a phrase after the word "from"
      // is not an import, and this file has one.
      const text = readFileSync(join(__dirname, name), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\n]*/g, " ");
      const specifiers = [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
      for (const specifier of specifiers) {
        const internal = specifier.startsWith(".") || specifier === "@app/shared";
        expect(`${name} imports ${specifier}: ${internal}`).toBe(
          `${name} imports ${specifier}: true`,
        );
      }
    }
  });
});
