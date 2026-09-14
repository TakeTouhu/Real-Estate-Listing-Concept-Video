import { describe, expect, it } from "vitest";
import { hasExactlyOwnKeys, isPlainRecord } from "./untrusted";

/**
 * The shared preliminary shape check, as a trust boundary in its own right.
 *
 * Every parser and predicate that takes `unknown` at a provider, storage or
 * queue boundary asks this helper first, and asks it *before* opening its own
 * guard. That makes the helper the one place a value can throw ahead of every
 * `try` in the pipeline — so it has to be total itself, or none of them are.
 */

/** A Proxy that has been revoked: `typeof` still says "object"; everything else throws. */
function revokedProxy(): object {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
}

class Handle {
  readonly id = 1;
  close(): number {
    return this.id;
  }
}

describe("isPlainRecord", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "record"],
    ["a number", 1],
    ["a boolean", true],
    ["a bigint", 1n],
    ["a symbol", Symbol("s")],
    ["a function", () => undefined],
  ])("refuses the primitive %s", (_label, value) => {
    expect(isPlainRecord(value)).toBe(false);
  });

  it.each([
    ["an empty array", []],
    ["an array of records", [{ kind: "PUBLISHED" }]],
  ])("refuses %s", (_label, value) => {
    expect(isPlainRecord(value)).toBe(false);
  });

  it.each([
    ["an object literal", { kind: "PUBLISHED" }],
    ["an empty object", {}],
    ["a null-prototype object", Object.create(null) as object],
    ["a class instance", new Handle()],
    ["a live Proxy over a record", new Proxy({ kind: "OPEN" }, {})],
  ])("accepts %s", (_label, value) => {
    expect(isPlainRecord(value)).toBe(true);
  });

  it("answers false, rather than throwing, for a revoked Proxy", () => {
    // `typeof` on a revoked Proxy is still "object". `Array.isArray` on one
    // throws a TypeError from the runtime — not from any getter this
    // repository wrote, and ahead of every guard the parsers open after this
    // check. The helper is the only place that can catch it.
    const proxy = revokedProxy();
    expect(() => isPlainRecord(proxy)).not.toThrow();
    expect(isPlainRecord(proxy)).toBe(false);
  });

  it("proves the fixture itself is hostile to the unguarded question", () => {
    // If the runtime ever stopped throwing here, the revoked-Proxy tests
    // across the boundaries would be proving nothing. Pin the premise.
    expect(() => Array.isArray(revokedProxy())).toThrow(TypeError);
  });
});

describe("hasExactlyOwnKeys", () => {
  it("counts non-enumerable own properties", () => {
    const value = { kind: "PUBLISHED" };
    Object.defineProperty(value, "url", { value: "s3://x", enumerable: false });
    expect(hasExactlyOwnKeys(value, ["kind"])).toBe(false);
    expect(hasExactlyOwnKeys(value, ["kind", "url"])).toBe(true);
  });

  it("ignores inherited properties in both directions", () => {
    const parent = { kind: "PUBLISHED" };
    const child = Object.create(parent) as Record<string, unknown>;
    expect(hasExactlyOwnKeys(child, ["kind"])).toBe(false);
    expect(hasExactlyOwnKeys(child, [])).toBe(true);
  });
});
