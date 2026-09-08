import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isSafePositiveByteCount,
  isSha256Digest,
  isWellFormedVerificationReceipt,
  managedGenerationOutputKey,
  safePositiveByteCount,
  sha256Digest,
} from "./output";
import { organizationIdFromStorageKey } from "../property/media";

/**
 * The values a managed output is made of, and the one thing a caller may not
 * supply: where it lives.
 */

const VALID = "a3f1".repeat(16);

describe("the SHA-256 boundary", () => {
  it("accepts canonical lowercase hex", () => {
    expect(isSha256Digest(VALID)).toBe(true);
    expect(sha256Digest(VALID)).toBe(VALID);
  });

  it.each([
    ["uppercase", "A".repeat(64)],
    ["mixed case", `${"a".repeat(63)}F`],
    ["63 characters", "a".repeat(63)],
    ["65 characters", "a".repeat(65)],
    ["empty", ""],
    ["whitespace-padded", ` ${"a".repeat(64)} `],
    ["a sha256: prefix", `sha256:${"a".repeat(64)}`],
    ["non-hex", "g".repeat(64)],
    ["a URL", "https://provider.example/out.mp4"],
    ["a number", 12345],
    ["null", null],
    ["undefined", undefined],
    ["an object", { sha256: "a".repeat(64) }],
    ["an array", ["a".repeat(64)]],
  ])("refuses %s", (_label, value) => {
    expect(isSha256Digest(value)).toBe(false);
    expect(() => sha256Digest(value)).toThrow(/64 lowercase hexadecimal/);
  });

  it("does not silently normalize uppercase into canonical form", () => {
    // Two spellings of one digest is how an equality check starts reporting
    // identical bytes as a corrupted output — and this value is compared on the
    // replay path, where a false mismatch reaches an operator as corruption.
    expect(() => sha256Digest("A".repeat(64))).toThrow();
  });
});

describe("the output size boundary", () => {
  it.each([1, 1024, 4_194_304, Number.MAX_SAFE_INTEGER])("accepts %i", (value) => {
    expect(isSafePositiveByteCount(value)).toBe(true);
    expect(safePositiveByteCount(value)).toBe(value);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["a numeric string", "1024"],
    ["null", null],
    ["undefined", undefined],
    ["an object", {}],
  ])("refuses %s", (_label, value) => {
    expect(isSafePositiveByteCount(value)).toBe(false);
    expect(() => safePositiveByteCount(value)).toThrow(/positive safe integer/);
  });

  it("refuses zero explicitly, because zero bytes is a failed copy", () => {
    // Not a small video: an object that exists because the destination was
    // created and nothing was written. Calling it verified closes an attempt
    // over nothing.
    expect(isSafePositiveByteCount(0)).toBe(false);
  });
});

describe("the verification receipt", () => {
  it("accepts a well-formed receipt", () => {
    expect(
      isWellFormedVerificationReceipt({ sha256: VALID, sizeBytes: 4_194_304 }),
    ).toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an array", []],
    ["an array carrying the fields", Object.assign([], { sha256: VALID, sizeBytes: 1 })],
    ["a string", VALID],
    ["an empty object", {}],
    ["a missing digest", { sizeBytes: 1 }],
    ["a missing size", { sha256: VALID }],
    ["a bad digest", { sha256: "nope", sizeBytes: 1 }],
    ["a bad size", { sha256: VALID, sizeBytes: 0 }],
  ])("refuses %s", (_label, value) => {
    expect(isWellFormedVerificationReceipt(value)).toBe(false);
  });

  it("carries no location, no provider detail and no bytes", () => {
    const text = readFileSync(join(__dirname, "output.ts"), "utf8");
    const contract = text.slice(text.indexOf("export interface ManagedOutputVerificationReceipt"));
    const body = contract.slice(0, contract.indexOf("}"));
    expect(body).toContain("sha256");
    expect(body).toContain("sizeBytes");
    for (const forbidden of [
      "storageKey",
      "providerUrl",
      "outputUrl",
      "url",
      "bytes:",
      "buffer",
      "mimeType",
      "contentType",
      "fileName",
    ]) {
      expect(`${forbidden}: ${body.includes(forbidden)}`).toBe(`${forbidden}: false`);
    }
  });
});

describe("the managed output key is derived, never supplied", () => {
  const key = managedGenerationOutputKey({
    organizationId: "org_1",
    attemptId: "sgen_1",
  });

  it("is deterministic for the same attempt", () => {
    // What makes a retried ingestion safe: the copy overwrites its own object
    // instead of scattering orphans, and a finalization can be replayed without
    // the platform remembering what it chose last time.
    expect(
      managedGenerationOutputKey({ organizationId: "org_1", attemptId: "sgen_1" }),
    ).toBe(key);
  });

  it("differs per attempt and per organization", () => {
    expect(
      managedGenerationOutputKey({ organizationId: "org_1", attemptId: "sgen_2" }),
    ).not.toBe(key);
    expect(
      managedGenerationOutputKey({ organizationId: "org_2", attemptId: "sgen_1" }),
    ).not.toBe(key);
  });

  it("keeps the tenant recoverable from the key alone", () => {
    // The existing asset convention, so retention and deletion tooling that
    // already reads `org/{id}/…` keeps working for generated output too.
    expect(organizationIdFromStorageKey(key)).toBe("org_1");
  });

  it("is built only from application-owned identifiers", () => {
    const text = readFileSync(join(__dirname, "output.ts"), "utf8");
    const fn = text.slice(text.indexOf("export function managedGenerationOutputKey"));
    for (const forbidden of [
      "providerUrl",
      "fileName",
      "prompt",
      "extension",
      "provider",
      "receipt",
    ]) {
      expect(`${forbidden}: ${fn.slice(0, fn.indexOf("\n}")).includes(forbidden)}`).toBe(
        `${forbidden}: false`,
      );
    }
  });

  it.each([
    ["a blank organization", { organizationId: "  ", attemptId: "sgen_1" }],
    ["an empty organization", { organizationId: "", attemptId: "sgen_1" }],
    ["a blank attempt", { organizationId: "org_1", attemptId: " " }],
    ["an empty attempt", { organizationId: "org_1", attemptId: "" }],
  ])("refuses %s", (_label, input) => {
    // A key with an empty segment is a different object than it looks like, and
    // two blank-id attempts would collapse onto one.
    expect(() => managedGenerationOutputKey(input)).toThrow(/non-blank/);
  });
});
