import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISCLOSURE_MODE,
  DISCLOSURE_MODES,
  assertRenderableDisclosureMode,
  isDisclosureMode,
} from "./mode";

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

  it("reads back only a mode this build can render", () => {
    expect(assertRenderableDisclosureMode("THROUGHOUT")).toBe("THROUGHOUT");
    // A value the database could hold only once a later build adds it, and
    // anything else, is a deployment fault, not a mode to approximate.
    for (const value of ["NONE", "FIRST_AND_LAST", "throughout", "", null, undefined]) {
      expect(() => assertRenderableDisclosureMode(value)).toThrow(
        expect.objectContaining({
          code: "CONFIGURATION_ERROR",
          message: "This build cannot render the disclosure mode frozen on that record",
        }),
      );
    }
  });
});
