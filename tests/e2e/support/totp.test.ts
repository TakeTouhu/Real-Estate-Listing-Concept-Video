import { describe, expect, it } from "vitest";
import { decodeBase32, hotp, totp } from "./totp";

/** RFC 4226 and RFC 6238's own key: the ASCII bytes of "12345678901234567890". */
const KEY = Buffer.from("12345678901234567890", "ascii");
const KEY_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("the browser test's authenticator", () => {
  it("decodes base32 as RFC 4648 does, ignoring spaces, padding and case", () => {
    expect(decodeBase32(KEY_BASE32)).toEqual(KEY);
    expect(decodeBase32("gezd gnbv gy3t qojq gezd gnbv gy3t qojq")).toEqual(KEY);
    // RFC 4648's own vectors, so every length of a last, partial group is read.
    for (const [encoded, plain] of [
      ["MY======", "f"],
      ["MZXQ====", "fo"],
      ["MZXW6===", "foo"],
      ["MZXW6YQ=", "foob"],
      ["MZXW6YTB", "fooba"],
      ["MZXW6YTBOI======", "foobar"],
    ] as const) {
      expect(decodeBase32(encoded)).toEqual(Buffer.from(plain));
    }
    expect(() => decodeBase32("not base32!")).toThrow("The key is not base32");
  });

  it("gives RFC 4226's HOTP values", () => {
    const expected = [
      ...["755224", "287082", "359152", "969429", "338314"],
      ...["254676", "287922", "162583", "399871", "520489"],
    ];
    expect(expected.map((_, counter) => hotp(KEY, counter))).toEqual(expected);
  });

  it("gives RFC 6238's SHA-1 codes, to eight digits and to the six an app shows", () => {
    const vectors: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [seconds, code] of vectors) {
      expect(hotp(KEY, Math.floor(seconds / 30), 8)).toBe(code);
      expect(totp(KEY_BASE32, new Date(seconds * 1000))).toBe(code.slice(2));
    }
  });
});
