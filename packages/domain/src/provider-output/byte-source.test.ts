import { describe, expect, it } from "vitest";
import {
  isWellFormedByteSourceOpenResult,
  isWellFormedByteStream,
  OPEN_BYTE_SOURCE_KEYS,
  RETRYABLE_FAILURE_BYTE_SOURCE_KEYS,
} from "./byte-source";

/**
 * The byte-source contract, checked against values nobody promised anything
 * about. A real adapter will hand back whatever it hands back; these predicates
 * are what stand between that and a `for await` over a string.
 */

async function* someBytes(): AsyncGenerator<Uint8Array, void, undefined> {
  yield new Uint8Array([1, 2, 3]);
}

function stream(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    body: someBytes(),
    declaredSizeBytes: null,
    close: async () => undefined,
    ...overrides,
  };
}

describe("isWellFormedByteStream", () => {
  it("accepts an async-iterable body, a null declared size and a callable close", () => {
    expect(isWellFormedByteStream(stream())).toBe(true);
  });

  it("accepts a positive safe-integer declared size", () => {
    expect(isWellFormedByteStream(stream({ declaredSizeBytes: 1 }))).toBe(true);
    expect(isWellFormedByteStream(stream({ declaredSizeBytes: Number.MAX_SAFE_INTEGER }))).toBe(
      true,
    );
  });

  it("accepts a class instance whose close lives on the prototype", () => {
    // The handle is deliberately not held to exact own keys: a real adapter
    // returns an instance, and its `close` is inherited.
    class Handle {
      readonly body = someBytes();
      readonly declaredSizeBytes = null;
      async close(): Promise<void> {}
    }
    expect(isWellFormedByteStream(new Handle())).toBe(true);
  });

  it.each([
    ["a zero declared size", { declaredSizeBytes: 0 }],
    ["a negative declared size", { declaredSizeBytes: -1 }],
    ["a fractional declared size", { declaredSizeBytes: 1.5 }],
    ["NaN", { declaredSizeBytes: Number.NaN }],
    ["Infinity", { declaredSizeBytes: Number.POSITIVE_INFINITY }],
    ["a string declared size", { declaredSizeBytes: "1024" }],
    ["an undefined declared size", { declaredSizeBytes: undefined }],
    ["an unsafe integer", { declaredSizeBytes: Number.MAX_SAFE_INTEGER + 1 }],
  ])("refuses %s", (_label, overrides) => {
    expect(isWellFormedByteStream(stream(overrides))).toBe(false);
  });

  it.each([
    ["a string body", { body: "bytes" }],
    ["a Uint8Array body", { body: new Uint8Array([1]) }],
    ["an array body", { body: [new Uint8Array([1])] }],
    ["a sync-iterable body", { body: new Set([new Uint8Array([1])]) }],
    ["a null body", { body: null }],
    ["a missing body", { body: undefined }],
  ])("refuses %s — the body must be asynchronously iterable", (_label, overrides) => {
    expect(isWellFormedByteStream(stream(overrides))).toBe(false);
  });

  it.each([
    ["a missing close", { close: undefined }],
    ["a non-function close", { close: true }],
  ])("refuses %s", (_label, overrides) => {
    expect(isWellFormedByteStream(stream(overrides))).toBe(false);
  });

  it.each([null, undefined, "stream", 7, [], [someBytes()]])(
    "refuses the non-record %o",
    (value) => {
      expect(isWellFormedByteStream(value)).toBe(false);
    },
  );
});

describe("isWellFormedByteSourceOpenResult", () => {
  it("accepts OPEN with a well-formed stream and nothing else", () => {
    expect(isWellFormedByteSourceOpenResult({ kind: "OPEN", stream: stream() })).toBe(true);
    expect(OPEN_BYTE_SOURCE_KEYS).toEqual(["kind", "stream"]);
  });

  it("accepts RETRYABLE_FAILURE with nothing else", () => {
    expect(isWellFormedByteSourceOpenResult({ kind: "RETRYABLE_FAILURE" })).toBe(true);
    expect(RETRYABLE_FAILURE_BYTE_SOURCE_KEYS).toEqual(["kind"]);
  });

  it.each([
    ["OPEN with a URL alongside", { kind: "OPEN", stream: stream(), url: "https://x" }],
    ["OPEN with a status alongside", { kind: "OPEN", stream: stream(), status: 200 }],
    ["OPEN without a stream", { kind: "OPEN" }],
    ["OPEN with a malformed stream", { kind: "OPEN", stream: stream({ body: "x" }) }],
    ["RETRYABLE_FAILURE with a message", { kind: "RETRYABLE_FAILURE", message: "boom" }],
    ["RETRYABLE_FAILURE with a status", { kind: "RETRYABLE_FAILURE", status: 503 }],
    ["RETRYABLE_FAILURE with a locator", { kind: "RETRYABLE_FAILURE", source: "https://x" }],
    ["an unknown kind", { kind: "TERMINAL_FAILURE" }],
    ["a missing kind", { stream: stream() }],
  ])("refuses %s", (_label, value) => {
    // An unrecognized discriminant is refused, never swept into RETRYABLE: a
    // source that says something this contract does not define has not said
    // "try later", and treating it so would loop forever on an adapter bug.
    expect(isWellFormedByteSourceOpenResult(value)).toBe(false);
  });

  it.each([null, undefined, "OPEN", 1, [], [{ kind: "OPEN" }]])(
    "refuses the non-record %o",
    (value) => {
      expect(isWellFormedByteSourceOpenResult(value)).toBe(false);
    },
  );
});
