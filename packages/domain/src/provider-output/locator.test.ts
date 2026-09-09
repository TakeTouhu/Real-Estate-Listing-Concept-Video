import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REDACTED_LOCATOR, TransientProviderOutputLocator } from "./locator";

/**
 * A provider's output location is a credential with an expiry, and this file is
 * the proof it cannot escape.
 *
 * The value used throughout is shaped like the real thing — a signed URL with a
 * signature parameter — so every assertion below is checking for the *actual*
 * string a leak would produce, not for a placeholder that happens not to appear.
 */

const RAW = "https://provider.example/outputs/abc123.mp4?X-Amz-Signature=SECRETSIGNATURE";

function locator(raw = RAW): TransientProviderOutputLocator {
  const built = TransientProviderOutputLocator.fromUnknown(raw);
  if (!built.ok) throw new Error(`fixture: ${built.reason}`);
  return built.value;
}

describe("constructing a locator", () => {
  it("accepts a non-blank string", () => {
    const built = TransientProviderOutputLocator.fromUnknown(RAW);
    expect(built.ok).toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an object", { url: RAW }],
    ["an array", [RAW]],
    ["a boolean", true],
  ])("refuses %s", (_label, value) => {
    const built = TransientProviderOutputLocator.fromUnknown(value);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.reason).toBe("NOT_A_STRING");
  });

  it.each([
    ["an empty string", ""],
    ["whitespace", "   "],
    ["a tab", "\t"],
  ])("refuses %s", (_label, value) => {
    // Blank is worse than missing: it satisfies every presence check while
    // naming nothing, and a transfer against it fails in a way that looks like a
    // provider problem rather than an adapter one.
    const built = TransientProviderOutputLocator.fromUnknown(value);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.reason).toBe("BLANK");
  });

  it("has no public constructor", () => {
    const text = readFileSync(join(__dirname, "locator.ts"), "utf8");
    expect(text).toContain("private constructor(raw: string)");
  });

  it("recognizes only locators it built", () => {
    expect(TransientProviderOutputLocator.isLocator(locator())).toBe(true);
    for (const impostor of [RAW, null, undefined, {}, { raw: RAW }, []]) {
      expect(TransientProviderOutputLocator.isLocator(impostor)).toBe(false);
    }
  });

  it("compares two locators without revealing either", () => {
    expect(locator().equals(locator())).toBe(true);
    expect(locator().equals(locator("https://provider.example/other"))).toBe(false);
  });
});

describe("the raw location cannot be read back", () => {
  const held = locator();

  it("is absent from JSON.stringify", () => {
    const serialized = JSON.stringify(held);
    expect(serialized).not.toContain("SECRETSIGNATURE");
    expect(serialized).not.toContain("provider.example");
    expect(serialized).toBe(JSON.stringify(REDACTED_LOCATOR));
  });

  it("is absent from a JSON.stringify of an enclosing object", () => {
    // The realistic leak: not stringifying the locator, but stringifying a
    // result or a log line that happens to hold one.
    const serialized = JSON.stringify({ attemptId: "sgen_1", source: held, nested: [held] });
    expect(serialized).not.toContain("SECRETSIGNATURE");
    expect(serialized).not.toContain("provider.example");
  });

  it("is absent from enumeration and spread", () => {
    expect(Object.keys(held)).toEqual([]);
    expect(Object.entries(held)).toEqual([]);
    expect(JSON.stringify({ ...held })).toBe("{}");
    expect(Object.getOwnPropertyNames(held)).toEqual([]);
  });

  it("is absent from string interpolation", () => {
    expect(`${held}`).toBe(REDACTED_LOCATOR);
    expect(String(held)).toBe(REDACTED_LOCATOR);
    expect([held].join(",")).toBe(REDACTED_LOCATOR);
  });

  it("is absent from node's inspector, which is what a console.log prints", () => {
    expect(inspect(held)).toBe(REDACTED_LOCATOR);
    expect(inspect({ source: held }, { depth: 5 })).not.toContain("SECRETSIGNATURE");
  });

  it("exposes no property, getter or method that returns it", () => {
    // Walks the whole prototype chain rather than trusting the class's shape:
    // an accessor added later would be caught here.
    const seen = new Set<string>();
    for (
      let current: object | null = held;
      current !== null && current !== Object.prototype;
      current = Object.getPrototypeOf(current) as object | null
    ) {
      for (const name of Object.getOwnPropertyNames(current)) seen.add(name);
    }
    for (const banned of ["value", "raw", "url", "href", "location", "unwrap", "reveal"]) {
      expect(`${banned}: ${seen.has(banned)}`).toBe(`${banned}: false`);
    }
    // Everything reachable returns the redaction or a boolean, never the value.
    for (const name of seen) {
      const member = (held as unknown as Record<string, unknown>)[name];
      if (typeof member === "string") expect(member).not.toContain("SECRETSIGNATURE");
    }
  });

  it("carries no extraction capability at all in this phase", () => {
    // Deliberate: dereferencing a locator is a network capability, and it will
    // be added and reviewed together with the adapter that needs it. Until then
    // there is nothing to misuse.
    const text = readFileSync(join(__dirname, "locator.ts"), "utf8");
    for (const banned of ["get raw", "get value", "reveal(", "unwrap(", "expose("]) {
      expect(`${banned}: ${text.includes(banned)}`).toBe(`${banned}: false`);
    }
  });
});
