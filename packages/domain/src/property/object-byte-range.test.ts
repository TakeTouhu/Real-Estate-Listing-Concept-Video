import { describe, expect, it } from "vitest";
import { resolveObjectByteRange } from "./ports";

/**
 * Which bytes of an object a range names (ADR-0115, RFC 9110 section
 * 14.1.2): the whole object with no range, a range cut to the object's end,
 * and none at all when the range starts past it.
 */
describe("the bytes a range names", () => {
  it("is the whole object when no range is asked for, an empty one included", () => {
    expect(resolveObjectByteRange(null, 10)).toEqual({ start: 0, length: 10 });
    expect(resolveObjectByteRange(null, 0)).toEqual({ start: 0, length: 0 });
  });

  it("runs from a start to an end, both included, cut to the last byte", () => {
    expect(resolveObjectByteRange({ kind: "FROM", start: 2, end: 5 }, 10)).toEqual({ start: 2, length: 4 });
    expect(resolveObjectByteRange({ kind: "FROM", start: 0, end: 0 }, 10)).toEqual({ start: 0, length: 1 });
    expect(resolveObjectByteRange({ kind: "FROM", start: 9, end: 9 }, 10)).toEqual({ start: 9, length: 1 });
    expect(resolveObjectByteRange({ kind: "FROM", start: 4, end: 99 }, 10)).toEqual({ start: 4, length: 6 });
    expect(resolveObjectByteRange({ kind: "FROM", start: 4, end: null }, 10)).toEqual({ start: 4, length: 6 });
    expect(resolveObjectByteRange({ kind: "FROM", start: 0, end: null }, 10)).toEqual({ start: 0, length: 10 });
  });

  it("is the last bytes for a suffix, the whole object when it is longer", () => {
    expect(resolveObjectByteRange({ kind: "LAST", length: 3 }, 10)).toEqual({ start: 7, length: 3 });
    expect(resolveObjectByteRange({ kind: "LAST", length: 10 }, 10)).toEqual({ start: 0, length: 10 });
    expect(resolveObjectByteRange({ kind: "LAST", length: 50 }, 10)).toEqual({ start: 0, length: 10 });
  });

  it("names no bytes for a start past the end, an empty suffix or an empty object", () => {
    expect(resolveObjectByteRange({ kind: "FROM", start: 10, end: null }, 10)).toBeNull();
    expect(resolveObjectByteRange({ kind: "FROM", start: 10, end: 20 }, 10)).toBeNull();
    expect(resolveObjectByteRange({ kind: "LAST", length: 0 }, 10)).toBeNull();
    expect(resolveObjectByteRange({ kind: "FROM", start: 0, end: null }, 0)).toBeNull();
    expect(resolveObjectByteRange({ kind: "LAST", length: 1 }, 0)).toBeNull();
    // An end before its start names nothing; the route never asks for one.
    expect(resolveObjectByteRange({ kind: "FROM", start: 5, end: 4 }, 10)).toBeNull();
  });
});
