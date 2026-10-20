import { describe, expect, it } from "vitest";
import { DEFAULT_DISCLOSURE_MODE, DISCLOSURE_MODES, isDisclosureMode } from "./mode";

describe("disclosure modes", () => {
  it("builds Mode A only, and it is the default (ADR-0052 Decision 8)", () => {
    expect(DISCLOSURE_MODES).toEqual(["THROUGHOUT"]);
    expect(DEFAULT_DISCLOSURE_MODE).toBe("THROUGHOUT");
  });

  it("accepts exactly the built modes", () => {
    expect(isDisclosureMode("THROUGHOUT")).toBe(true);
    // Mode B and Mode C are not stored until they are built, whatever they will
    // be spelled; nor is any near miss or non-string.
    for (const value of ["NONE", "FIRST_AND_LAST", "A", "throughout", " THROUGHOUT", "", null, undefined, 0, {}]) {
      expect(`${String(value)}: ${isDisclosureMode(value)}`).toBe(`${String(value)}: false`);
    }
  });
});
