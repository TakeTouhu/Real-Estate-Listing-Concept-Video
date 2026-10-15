import { describe, expect, it } from "vitest";
import { base32Encode, hotp, keyFingerprint, openAesGcm, sealAesGcm, secureRandomBytes } from "./mfa-crypto";

const ascii = (text: string) => Buffer.from(text, "ascii");

describe("base32Encode", () => {
  it("matches the RFC 4648 test vectors, without padding", () => {
    const vectors: [string, string][] = [
      ["", ""],
      ["f", "MY"],
      ["fo", "MZXQ"],
      ["foo", "MZXW6"],
      ["foob", "MZXW6YQ"],
      ["fooba", "MZXW6YTB"],
      ["foobar", "MZXW6YTBOI"],
    ];
    for (const [input, encoded] of vectors) expect(base32Encode(ascii(input))).toBe(encoded);
  });

  it("encodes the RFC 6238 SHA-1 secret as authenticator apps expect it", () => {
    expect(base32Encode(ascii("12345678901234567890"))).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it("uses another alphabet when given one", () => {
    expect(base32Encode(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff), "0123456789ABCDEFGHJKMNPQRSTVWXYZ")).toBe("ZZZZZZZZ");
    expect(base32Encode(new Uint8Array(5), "0123456789ABCDEFGHJKMNPQRSTVWXYZ")).toBe("00000000");
  });
});

describe("hotp", () => {
  it("matches the RFC 4226 Appendix D test values", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expected.forEach((code, counter) => expect(hotp(ascii("12345678901234567890"), counter)).toBe(code));
  });

  it("matches the RFC 6238 Appendix B SHA-1 values (8 digits, 30-second steps)", () => {
    const secret = ascii("12345678901234567890");
    const vectors: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [seconds, code] of vectors) expect(hotp(secret, Math.floor(seconds / 30), 8)).toBe(code);
  });
});

describe("AES-256-GCM sealing", () => {
  const key = Buffer.alloc(32, 7);

  it("opens what it sealed, with the same associated data", () => {
    const sealed = sealAesGcm(key, ascii("secret"), "usr_1");
    expect(openAesGcm(key, sealed, "usr_1").toString("ascii")).toBe("secret");
    expect(sealed).not.toContain(Buffer.from("secret").toString("base64url"));
  });

  it("uses a fresh IV each time", () => {
    expect(sealAesGcm(key, ascii("secret"), "usr_1")).not.toBe(sealAesGcm(key, ascii("secret"), "usr_1"));
  });

  it("refuses another key, other associated data, an altered value or a truncated one", () => {
    const sealed = sealAesGcm(key, ascii("secret"), "usr_1");
    expect(() => openAesGcm(Buffer.alloc(32, 8), sealed, "usr_1")).toThrow();
    expect(() => openAesGcm(key, sealed, "usr_2")).toThrow();
    const raw = Buffer.from(sealed, "base64url");
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
    expect(() => openAesGcm(key, raw.toString("base64url"), "usr_1")).toThrow();
    expect(() => openAesGcm(key, sealed.slice(0, 20), "usr_1")).toThrow("too short");
  });
});

describe("keys and randomness", () => {
  it("fingerprints a key stably and differently from another key", () => {
    expect(keyFingerprint(Buffer.alloc(32, 7))).toBe(keyFingerprint(Buffer.alloc(32, 7)));
    expect(keyFingerprint(Buffer.alloc(32, 7))).not.toBe(keyFingerprint(Buffer.alloc(32, 8)));
    expect(keyFingerprint(Buffer.alloc(32, 7))).toMatch(/^[0-9a-f]{12}$/);
  });

  it("returns the requested number of random bytes", () => {
    expect(secureRandomBytes(20)).toHaveLength(20);
    expect(Buffer.from(secureRandomBytes(20)).equals(Buffer.from(secureRandomBytes(20)))).toBe(false);
  });
});
