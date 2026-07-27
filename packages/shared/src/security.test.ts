import { describe, expect, it } from "vitest";
import { signSession, timingSafeEqualString, verifySession } from "./security";

const SECRET = "test-secret-value-abc123";

describe("timingSafeEqualString", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeEqualString("abc123", "abc123")).toBe(true);
  });

  it("returns false for different strings of equal length", () => {
    expect(timingSafeEqualString("abc123", "abc124")).toBe(false);
  });

  it("returns false for different lengths without throwing", () => {
    expect(timingSafeEqualString("abc", "abcdef")).toBe(false);
  });
});

describe("session token", () => {
  it("signs and verifies a valid, unexpired token", () => {
    const now = 1_000;
    const token = signSession({ sub: "operator", exp: now + 100 }, SECRET);
    const payload = verifySession(token, SECRET, now);
    expect(payload).toEqual({ sub: "operator", exp: now + 100 });
  });

  it("rejects an expired token", () => {
    const now = 1_000;
    const token = signSession({ sub: "operator", exp: now - 1 }, SECRET);
    expect(verifySession(token, SECRET, now)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const token = signSession({ sub: "operator", exp: 9_999_999_999 }, SECRET);
    expect(verifySession(token, "other-secret-value", 1_000)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = signSession({ sub: "operator", exp: 9_999_999_999 }, SECRET);
    const tampered = `${Buffer.from('{"sub":"admin","exp":9999999999}').toString("base64url")}.${token.split(".")[1]}`;
    expect(verifySession(tampered, SECRET, 1_000)).toBeNull();
  });

  it("rejects undefined and malformed tokens", () => {
    expect(verifySession(undefined, SECRET)).toBeNull();
    expect(verifySession("not-a-token", SECRET)).toBeNull();
    expect(verifySession(".", SECRET)).toBeNull();
  });
});
