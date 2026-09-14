import { describe, expect, it } from "vitest";
import {
  isWellFormedByteSourceOpenResult,
  isWellFormedByteStream,
  OPEN_BYTE_SOURCE_KEYS,
  parseProviderOutputByteSourceOpenResult,
  parseProviderOutputByteStream,
  RETRYABLE_FAILURE_BYTE_SOURCE_KEYS,
} from "./byte-source";

async function drain(body: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const chunk of body) out.push(chunk);
  return out;
}

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

  it.each([
    ["a throwing close getter", { get close(): never { throw new Error("GETTER-SECRET"); } }],
    ["a throwing body getter", { get body(): never { throw new Error("GETTER-SECRET"); } }],
    ["a throwing declaredSizeBytes getter", { get declaredSizeBytes(): never { throw new Error("x"); } }],
  ])("answers false, rather than throwing, for a handle with %s", (_label, hostile) => {
    // A predicate is total. A getter that throws is not "a callable close" —
    // it is a handle outside the contract — and the caller's fixed defect must
    // be what escapes, never the getter's own error.
    const value = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(value, {
      body: { value: someBytes(), enumerable: true, configurable: true },
      declaredSizeBytes: { value: null, enumerable: true, configurable: true },
      close: { value: async () => undefined, enumerable: true, configurable: true },
      ...Object.fromEntries(
        Object.getOwnPropertyNames(hostile).map((k) => [
          k,
          Object.getOwnPropertyDescriptor(hostile, k)!,
        ]),
      ),
    });
    expect(() => isWellFormedByteStream(value)).not.toThrow();
    expect(isWellFormedByteStream(value)).toBe(false);
  });

  it("answers false, rather than throwing, for a revoked Proxy", () => {
    // Hostile before `body` is read: `typeof` still answers "object", and the
    // shared record check's `Array.isArray` throws from the runtime ahead of
    // this predicate's guard. It is caught there, once, for every boundary.
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => isWellFormedByteStream(proxy)).not.toThrow();
    expect(isWellFormedByteStream(proxy)).toBe(false);
  });
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

  it.each([
    ["a throwing stream getter", "stream"],
    ["a throwing kind getter", "kind"],
  ])("answers false, rather than throwing, for a wrapper with %s", (_label, hostileKey) => {
    const value: Record<string, unknown> = { kind: "OPEN", stream: stream() };
    Object.defineProperty(value, hostileKey, {
      get(): never {
        throw new Error("GETTER-SECRET");
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => isWellFormedByteSourceOpenResult(value)).not.toThrow();
    expect(isWellFormedByteSourceOpenResult(value)).toBe(false);
  });

  it("refuses a wrapper whose stream close getter throws, without throwing itself", () => {
    const hostile = {
      body: someBytes(),
      declaredSizeBytes: null,
      get close(): never {
        throw new Error("GETTER-SECRET");
      },
    };
    expect(() => isWellFormedByteSourceOpenResult({ kind: "OPEN", stream: hostile })).not.toThrow();
    expect(isWellFormedByteSourceOpenResult({ kind: "OPEN", stream: hostile })).toBe(false);
  });

  it("answers false, rather than throwing, for a revoked Proxy as the result", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => isWellFormedByteSourceOpenResult(proxy)).not.toThrow();
    expect(isWellFormedByteSourceOpenResult(proxy)).toBe(false);
  });

  it("answers false, rather than throwing, for a revoked Proxy as the stream", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const wrapper = { kind: "OPEN", stream: proxy };
    expect(() => isWellFormedByteSourceOpenResult(wrapper)).not.toThrow();
    expect(isWellFormedByteSourceOpenResult(wrapper)).toBe(false);
  });
});

describe("parseProviderOutputByteStream captures each field exactly once", () => {
  it("reads body, declaredSizeBytes and close once each and never again", async () => {
    let bodyReads = 0;
    let declaredReads = 0;
    let closeReads = 0;
    let closeInvocations = 0;
    const source = someBytes();
    const handle = {
      get body(): AsyncIterable<Uint8Array> {
        bodyReads += 1;
        return source;
      },
      get declaredSizeBytes(): number | null {
        declaredReads += 1;
        return 3;
      },
      get close(): () => Promise<void> {
        closeReads += 1;
        return async () => void (closeInvocations += 1);
      },
    };
    const captured = parseProviderOutputByteStream(handle);
    if (captured === null) throw new Error("expected a captured stream");
    expect(bodyReads).toBe(1);
    expect(declaredReads).toBe(1);
    expect(closeReads).toBe(1);
    expect(captured.declaredSizeBytes).toBe(3);

    // Using the captured stream re-touches none of the raw getters.
    expect(await drain(captured.body)).toEqual([new Uint8Array([1, 2, 3])]);
    await captured.close();
    await captured.close();
    expect(closeInvocations).toBe(2);
    expect(bodyReads).toBe(1);
    expect(declaredReads).toBe(1);
    expect(closeReads).toBe(1);
  });

  it("looks up the body's async-iterator capability once, not on each iteration", async () => {
    let asyncIteratorReads = 0;
    const hostileBody = {
      get [Symbol.asyncIterator](): () => AsyncIterator<Uint8Array> {
        asyncIteratorReads += 1;
        return async function* (): AsyncGenerator<Uint8Array> {
          yield new Uint8Array([7]);
        };
      },
    };
    const captured = parseProviderOutputByteStream({
      body: hostileBody,
      declaredSizeBytes: null,
      close: async () => undefined,
    });
    if (captured === null) throw new Error("expected a captured stream");
    expect(asyncIteratorReads).toBe(1);
    expect(await drain(captured.body)).toEqual([new Uint8Array([7])]);
    // Iterating the captured body did not return to the hostile getter.
    expect(asyncIteratorReads).toBe(1);
  });

  it("invokes a prototype close against its original receiver", async () => {
    let sawReceiver: unknown;
    class Handle {
      readonly body = someBytes();
      readonly declaredSizeBytes = null;
      readonly tag = "self";
      async close(): Promise<void> {
        sawReceiver = (this as Handle).tag;
      }
    }
    const instance = new Handle();
    const captured = parseProviderOutputByteStream(instance);
    if (captured === null) throw new Error("expected a captured stream");
    await captured.close();
    expect(sawReceiver).toBe("self");
  });

  it("refuses hostile and malformed handles as null", () => {
    expect(parseProviderOutputByteStream({ body: "x", declaredSizeBytes: null, close() {} })).toBeNull();
    expect(
      parseProviderOutputByteStream({
        get body(): never {
          throw new Error("SECRET");
        },
      }),
    ).toBeNull();
    expect(parseProviderOutputByteStream(null)).toBeNull();
  });
});

describe("parseProviderOutputByteSourceOpenResult materializes the open result", () => {
  it("captures the stream of an OPEN result and reads kind and stream once", () => {
    let kindReads = 0;
    let streamReads = 0;
    const wrapper = {
      get kind(): string {
        kindReads += 1;
        return "OPEN";
      },
      get stream(): Record<string, unknown> {
        streamReads += 1;
        return { body: someBytes(), declaredSizeBytes: null, close: async () => undefined };
      },
    };
    const parsed = parseProviderOutputByteSourceOpenResult(wrapper);
    expect(parsed?.kind).toBe("OPEN");
    expect(kindReads).toBe(1);
    expect(streamReads).toBe(1);
  });

  it("materializes RETRYABLE_FAILURE as a fresh one-key object", () => {
    const parsed = parseProviderOutputByteSourceOpenResult({ kind: "RETRYABLE_FAILURE" });
    expect(parsed).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(Object.getOwnPropertyNames(parsed)).toEqual(["kind"]);
  });

  it("refuses a wrapper with an extra key, and a wrapper whose stream is malformed", () => {
    expect(
      parseProviderOutputByteSourceOpenResult({ kind: "OPEN", stream: stream(), status: 200 }),
    ).toBeNull();
    expect(
      parseProviderOutputByteSourceOpenResult({ kind: "OPEN", stream: stream({ body: "x" }) }),
    ).toBeNull();
  });
});
