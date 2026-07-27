import { describe, expect, it } from "vitest";
import { hashPassword, randomId, randomToken, sha256Hex, slugify, verifyPassword } from "./crypto";

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("produces a different salt/hash each time", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
  });

  it("rejects malformed stored hashes", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
  });
});

describe("tokens and ids", () => {
  it("hashes tokens deterministically", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
    expect(sha256Hex("abc")).not.toBe(sha256Hex("abd"));
  });

  it("generates unique prefixed ids and random tokens", () => {
    expect(randomId("usr")).toMatch(/^usr_/);
    expect(randomId("usr")).not.toBe(randomId("usr"));
    expect(randomToken().length).toBeGreaterThan(20);
  });
});

describe("slugify", () => {
  it("normalizes names", () => {
    expect(slugify("  Acme Realty Co.  ")).toBe("acme-realty-co");
    expect(slugify("***")).toBe("org");
  });
});
