import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { rateLimitSubject, rateLimitSubjectKey, type RateLimitSubjectFamily } from "./rate-limit-subject";

/** The subjects of the abuse limits (ADR-0170). Throwaway secrets: none is a real one. */
const SECRET = "session-secret-abcdef123456";
const OTHER_SECRET = "session-secret-abcdef654321";

describe("rate-limit subjects", () => {
  const key = rateLimitSubjectKey(SECRET);

  it("derive their key from the session secret under a fixed label", () => {
    const expected = createHmac("sha256", SECRET).update("vtavision rate-limit subject v1").digest();
    expect(key.equals(expected)).toBe(true);
    expect(key).toHaveLength(32);
    expect(rateLimitSubjectKey(SECRET).equals(key)).toBe(true);
    expect(rateLimitSubjectKey(OTHER_SECRET).equals(key)).toBe(false);
  });

  it("are 64 lowercase hex characters, the same for the same family and value", () => {
    const families: RateLimitSubjectFamily[] = ["address", "client", "user"];
    for (const family of families) {
      for (const value of ["person@example.com", "v4:203.0.113.7", "v6:2001:db8:aa:bb::/64", "usr_1", ""]) {
        const subject = rateLimitSubject(key, family, value);
        expect(subject).toMatch(/^[0-9a-f]{64}$/);
        expect(rateLimitSubject(rateLimitSubjectKey(SECRET), family, value)).toBe(subject);
      }
    }
    const expected = createHmac("sha256", key).update("address\u0000person@example.com").digest("hex");
    expect(rateLimitSubject(key, "address", "person@example.com")).toBe(expected);
  });

  it("differ by family, by value and by secret", () => {
    const subjects = [
      rateLimitSubject(key, "address", "usr_1"),
      rateLimitSubject(key, "client", "usr_1"),
      rateLimitSubject(key, "user", "usr_1"),
      rateLimitSubject(key, "user", "usr_2"),
      rateLimitSubject(key, "user", "USR_1"),
      rateLimitSubject(rateLimitSubjectKey(OTHER_SECRET), "user", "usr_1"),
    ];
    expect(new Set(subjects).size).toBe(subjects.length);
  });

  it("never carry the value", () => {
    for (const value of ["person@example.com", "203.0.113.7", "deadbeef", "0123456789abcdef"]) {
      const subject = rateLimitSubject(key, "address", value);
      expect(subject).not.toContain(value);
      expect(subject).not.toContain(Buffer.from(value).toString("hex"));
    }
  });
});
