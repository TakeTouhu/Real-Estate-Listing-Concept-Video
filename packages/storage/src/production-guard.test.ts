import { describe, expect, it } from "vitest";
import { LocalObjectStorage } from "./local-storage";
import { PassthroughMalwareScanner } from "./scanner";
import { NonProductionAdapterError, assertNotProduction } from "./production-guard";

const SECRET = "super-secret-storage-signing-value";

describe("production guard — LocalObjectStorage", () => {
  it("throws when NODE_ENV=production", () => {
    expect(() => new LocalObjectStorage({ secret: SECRET, nodeEnv: "production" })).toThrow(
      NonProductionAdapterError,
    );
  });

  it("names the offending adapter and the required action", () => {
    try {
      new LocalObjectStorage({ secret: SECRET, nodeEnv: "production" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(NonProductionAdapterError);
      const err = error as NonProductionAdapterError;
      expect(err.adapter).toBe("LocalObjectStorage");
      expect(err.message).toContain("LocalObjectStorage");
      expect(err.message).toContain("NODE_ENV=production");
      expect(err.message).toMatch(/S3\/Azure/);
    }
  });

  it("never leaks the signing secret into the error message", () => {
    try {
      new LocalObjectStorage({ secret: SECRET, nodeEnv: "production" });
      expect.unreachable("should have thrown");
    } catch (error) {
      const err = error as Error;
      expect(err.message).not.toContain(SECRET);
      expect(err.stack ?? "").not.toContain(SECRET);
      expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(SECRET);
    }
  });

  it("still works in development, test, and unset environments", () => {
    for (const nodeEnv of ["development", "test", undefined]) {
      expect(() => new LocalObjectStorage({ secret: SECRET, nodeEnv })).not.toThrow();
    }
  });

  it("allows an explicit production override for staging smoke tests", () => {
    expect(
      () => new LocalObjectStorage({ secret: SECRET, nodeEnv: "production", allowInProduction: true }),
    ).not.toThrow();
  });
});

describe("production guard — PassthroughMalwareScanner", () => {
  it("throws when NODE_ENV=production", () => {
    expect(() => new PassthroughMalwareScanner({ nodeEnv: "production" })).toThrow(
      NonProductionAdapterError,
    );
  });

  it("names the offending adapter and the required action", () => {
    try {
      new PassthroughMalwareScanner({ nodeEnv: "production" });
      expect.unreachable("should have thrown");
    } catch (error) {
      const err = error as NonProductionAdapterError;
      expect(err.adapter).toBe("PassthroughMalwareScanner");
      expect(err.message).toContain("PassthroughMalwareScanner");
      expect(err.message).toContain("NODE_ENV=production");
      expect(err.message).toMatch(/malware-scanning engine/);
    }
  });

  it("still works in development, test, and unset environments", () => {
    for (const nodeEnv of ["development", "test", undefined]) {
      expect(() => new PassthroughMalwareScanner({ nodeEnv })).not.toThrow();
    }
  });

  it("allows an explicit production override", () => {
    expect(
      () => new PassthroughMalwareScanner({ nodeEnv: "production", allowInProduction: true }),
    ).not.toThrow();
  });

  it("remains functional after passing the guard", async () => {
    const scanner = new PassthroughMalwareScanner({ nodeEnv: "test" });
    await expect(scanner.scan(new Uint8Array([1, 2, 3]))).resolves.toMatchObject({
      verdict: "CLEAN",
    });
  });
});

describe("assertNotProduction", () => {
  it("is a no-op outside production", () => {
    expect(() => assertNotProduction("X", "r", "a", { nodeEnv: "development" })).not.toThrow();
  });

  it("throws in production with the adapter recorded", () => {
    try {
      assertNotProduction("SomeAdapter", "some reason", "some action", { nodeEnv: "production" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as NonProductionAdapterError).adapter).toBe("SomeAdapter");
    }
  });
});
