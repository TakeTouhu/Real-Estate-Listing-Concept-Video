import { describe, expect, it } from "vitest";
import { bearerFrom } from "./auth";

describe("bearerFrom", () => {
  it("parses a well-formed bearer header", () => {
    expect(bearerFrom("Bearer abc.def")).toBe("abc.def");
    expect(bearerFrom("bearer  spaced-token")).toBe("spaced-token");
  });

  it("returns undefined for missing or malformed headers", () => {
    expect(bearerFrom(null)).toBeUndefined();
    expect(bearerFrom("")).toBeUndefined();
    expect(bearerFrom("Basic abc")).toBeUndefined();
  });
});
