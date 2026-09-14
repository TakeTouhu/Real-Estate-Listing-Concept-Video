import { describe, expect, it } from "vitest";
import {
  parseSubmissionDiagnosticCode,
  type SubmissionDiagnosticCode,
} from "../submission/diagnostic-code";
import { TransientProviderOutputLocator } from "./locator";
import {
  isWellFormedPollObservation,
  parseProviderPollObservation,
  type ProviderPollObservation,
} from "./observation";

/**
 * What a status source is allowed to say, and every way of saying something
 * else.
 *
 * The rule doing the most work here is the locator one: `outputLocator` must be
 * `null` or an opaque locator this process built. A raw string is refused at the
 * boundary, so a vendor's response text cannot become an ordinary value
 * travelling through the orchestrator — spreadable, loggable, serializable.
 * That moves locator secrecy from a convention everyone must remember to a type
 * the compiler and the validator both enforce.
 */

function code(raw: string): SubmissionDiagnosticCode {
  const parsed = parseSubmissionDiagnosticCode(raw);
  if (!parsed.ok || parsed.code === null) throw new Error(`fixture: ${raw}`);
  return parsed.code;
}

const RAW_URL = "https://provider.example/o.mp4?X-Amz-Signature=SECRET";

function locator(): TransientProviderOutputLocator {
  const built = TransientProviderOutputLocator.fromUnknown(RAW_URL);
  if (!built.ok) throw new Error("fixture");
  return built.value;
}

describe("the three things a status source may report", () => {
  it("accepts IN_PROGRESS", () => {
    expect(isWellFormedPollObservation({ kind: "IN_PROGRESS" })).toBe(true);
  });

  it("accepts SUCCEEDED with a locator", () => {
    expect(isWellFormedPollObservation({ kind: "SUCCEEDED", outputLocator: locator() })).toBe(
      true,
    );
  });

  it("accepts SUCCEEDED with an explicitly absent locator", () => {
    // The case that keeps provider truth separate from output acquisition: the
    // provider finished, and the platform cannot currently reach the artifact.
    expect(isWellFormedPollObservation({ kind: "SUCCEEDED", outputLocator: null })).toBe(true);
  });

  it.each([
    ["retryable", { kind: "FAILED", retryable: true, diagnosticCode: null }],
    ["terminal", { kind: "FAILED", retryable: false, diagnosticCode: code("TIMEOUT") }],
  ])("accepts a %s failure", (_label, value) => {
    expect(isWellFormedPollObservation(value)).toBe(true);
  });

  it("narrows the type for a caller that started from unknown", () => {
    const decoded: unknown = { kind: "IN_PROGRESS" };
    if (!isWellFormedPollObservation(decoded)) throw new Error("expected well-formed");
    const observation: ProviderPollObservation = decoded;
    expect(observation.kind).toBe("IN_PROGRESS");
  });
});

describe("the validator treats its input as unknown, because it is", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 200],
    ["a string", "SUCCEEDED"],
    ["a boolean", true],
    ["an array", []],
    ["an array carrying a valid arm's properties", Object.assign([], { kind: "IN_PROGRESS" })],
    ["an empty object", {}],
    ["an object with no kind", { retryable: true }],
  ])("refuses %s", (_label, value) => {
    expect(isWellFormedPollObservation(value)).toBe(false);
  });

  it.each([
    ["UNKNOWN", { kind: "UNKNOWN" }],
    ["a lowercase arm", { kind: "succeeded", outputLocator: null }],
    ["a numeric kind", { kind: 1 }],
    ["a null kind", { kind: null }],
    ["a submission-phase arm", { kind: "ACCEPTED", providerPredictionId: "p" }],
    ["a completion-phase arm", { kind: "PROVIDER_SUCCEEDED" }],
    // The dangerous shape: an unrecognised arm whose body would pass FAILED
    // validation. Sweeping it into that branch would move a paid, accepted
    // attempt to a terminal state on a value nobody defined.
    ["a failure body under an unknown kind", { kind: "NOPE", retryable: true, diagnosticCode: null }],
  ])("refuses the unrecognised discriminant %s rather than guessing", (_l, value) => {
    expect(isWellFormedPollObservation(value)).toBe(false);
  });

  it("never throws on hostile input", () => {
    for (const hostile of [null, undefined, 1, "x", [], {}, { kind: "FAILED", retryable: {} }]) {
      expect(() => isWellFormedPollObservation(hostile)).not.toThrow();
    }
  });
});

describe("a raw provider URL is not a locator", () => {
  it.each([
    ["a raw signed URL", RAW_URL],
    ["a bare string", "abc"],
    ["an object shaped like one", { url: RAW_URL }],
    ["an object with a raw field", { raw: RAW_URL }],
    ["a number", 1],
    ["undefined", undefined],
    ["an array", [RAW_URL]],
  ])("refuses SUCCEEDED whose outputLocator is %s", (_label, outputLocator) => {
    // If a string were accepted here, a vendor's response text would travel
    // through the orchestrator as an ordinary value and every guarantee about
    // locator secrecy would rest on nobody ever spreading or logging it.
    expect(isWellFormedPollObservation({ kind: "SUCCEEDED", outputLocator })).toBe(false);
  });

  it("refuses a structural impostor carrying the same shape", () => {
    // `#validated in value` is nominal: a hand-built object cannot pass, however
    // carefully it copies the class's surface.
    const impostor = { toJSON: () => "[redacted provider output locator]", equals: () => true };
    expect(isWellFormedPollObservation({ kind: "SUCCEEDED", outputLocator: impostor })).toBe(
      false,
    );
  });

  it("refuses SUCCEEDED with no outputLocator field at all", () => {
    // Absent is not the same as `null`: a sender that omitted the field has not
    // stated that no location exists, and guessing which it meant is how an
    // adapter bug becomes an application decision.
    expect(isWellFormedPollObservation({ kind: "SUCCEEDED" })).toBe(false);
  });
});

describe("the arms are closed against provider payloads", () => {
  it.each([
    ["a provider output URL", "providerOutputUrl"],
    ["an output URL", "outputUrl"],
    ["a raw provider response", "rawProviderResponse"],
    ["a provider response", "providerResponse"],
    ["an HTTP status", "httpStatus"],
    ["a progress percentage", "progress"],
    ["an ETA", "etaSeconds"],
    ["an authorization header", "authorization"],
    ["a prompt", "prompt"],
    ["an unremarkable unknown field", "note"],
  ])("refuses IN_PROGRESS carrying %s", (_label, extra) => {
    expect(isWellFormedPollObservation({ kind: "IN_PROGRESS", [extra]: "anything" })).toBe(false);
  });

  it.each([
    ["a provider output URL", "providerOutputUrl"],
    ["a raw provider response", "rawProviderResponse"],
    ["a MIME type", "mimeType"],
    ["a size", "sizeBytes"],
    ["an unremarkable unknown field", "note"],
  ])("refuses SUCCEEDED carrying %s", (_label, extra) => {
    // The valid locator makes this the realistic case: an adapter that builds
    // the opaque type correctly and *also* passes the URL through beside it.
    expect(
      isWellFormedPollObservation({
        kind: "SUCCEEDED",
        outputLocator: locator(),
        [extra]: RAW_URL,
      }),
    ).toBe(false);
  });

  it.each([
    ["a provider body", "providerBody"],
    ["a raw provider response", "rawProviderResponse"],
    ["a vendor status string", "providerStatus"],
    ["an HTTP status", "httpStatus"],
    ["an unremarkable unknown field", "note"],
  ])("refuses FAILED carrying %s", (_label, extra) => {
    expect(
      isWellFormedPollObservation({
        kind: "FAILED",
        retryable: true,
        diagnosticCode: null,
        [extra]: "anything",
      }),
    ).toBe(false);
  });

  it("is not fooled by a field hidden from enumeration", () => {
    const smuggled: Record<string, unknown> = { kind: "IN_PROGRESS" };
    Object.defineProperty(smuggled, "providerOutputUrl", { value: RAW_URL, enumerable: false });
    expect(isWellFormedPollObservation(smuggled)).toBe(false);
  });

  it("does not refuse an ordinary object for inheriting Object.prototype", () => {
    const ordinary = { kind: "IN_PROGRESS" };
    expect(typeof ordinary.hasOwnProperty).toBe("function");
    expect(isWellFormedPollObservation(ordinary)).toBe(true);
  });

  it("does not accept a discriminant that exists only on a prototype", () => {
    const inherited = Object.create({ kind: "IN_PROGRESS" }) as Record<string, unknown>;
    expect(inherited.kind).toBe("IN_PROGRESS");
    expect(isWellFormedPollObservation(inherited)).toBe(false);
  });
});

describe("the observation is read once, under a guard, into a fresh object", () => {
  it("materializes each arm as a fresh plain object with exactly its own keys", () => {
    const inProgress = parseProviderPollObservation({ kind: "IN_PROGRESS" });
    expect(inProgress).toEqual({ kind: "IN_PROGRESS" });
    expect(Object.getOwnPropertyNames(inProgress)).toEqual(["kind"]);

    const loc = locator();
    const succeeded = parseProviderPollObservation({ kind: "SUCCEEDED", outputLocator: loc });
    expect(Object.getOwnPropertyNames(succeeded)).toEqual(["kind", "outputLocator"]);
    // The locator is carried through by reference — never rebuilt or inspected.
    expect((succeeded as { outputLocator: unknown }).outputLocator).toBe(loc);

    const failed = parseProviderPollObservation({
      kind: "FAILED",
      retryable: true,
      diagnosticCode: null,
    });
    expect(failed).toEqual({ kind: "FAILED", retryable: true, diagnosticCode: null });
    expect(Object.getOwnPropertyNames(failed)).toEqual(["kind", "retryable", "diagnosticCode"]);
  });

  it("returns a value that does not alias the input", () => {
    const input = { kind: "IN_PROGRESS" as const };
    expect(parseProviderPollObservation(input)).not.toBe(input);
  });

  it.each([
    ["a throwing kind getter", { get kind(): never { throw new Error("SECRET"); } }],
    [
      "a throwing outputLocator getter on SUCCEEDED",
      { kind: "SUCCEEDED", get outputLocator(): never { throw new Error("SECRET"); } },
    ],
    [
      "a throwing retryable getter on FAILED",
      { kind: "FAILED", get retryable(): never { throw new Error("SECRET"); }, diagnosticCode: null },
    ],
  ])("returns null, rather than throwing, for %s", (_label, hostile) => {
    expect(() => parseProviderPollObservation(hostile)).not.toThrow();
    expect(parseProviderPollObservation(hostile)).toBeNull();
    expect(() => isWellFormedPollObservation(hostile)).not.toThrow();
    expect(isWellFormedPollObservation(hostile)).toBe(false);
  });

  it("returns null when own-key enumeration itself throws", () => {
    const trapped = new Proxy(
      { kind: "IN_PROGRESS" },
      {
        ownKeys() {
          throw new Error("SECRET");
        },
      },
    );
    expect(() => parseProviderPollObservation(trapped)).not.toThrow();
    expect(parseProviderPollObservation(trapped)).toBeNull();
  });

  it("reads the SUCCEEDED locator exactly once and holds that reference", () => {
    let reads = 0;
    const loc = locator();
    const stateful = {
      kind: "SUCCEEDED",
      get outputLocator(): unknown {
        reads += 1;
        if (reads > 1) throw new Error("SECOND-READ");
        return loc;
      },
    };
    const parsed = parseProviderPollObservation(stateful);
    expect((parsed as { outputLocator: unknown }).outputLocator).toBe(loc);
    expect(reads).toBe(1);
  });

  it("reads the FAILED fields exactly once each", () => {
    let retryableReads = 0;
    let codeReads = 0;
    const stateful = {
      kind: "FAILED",
      get retryable(): boolean {
        retryableReads += 1;
        if (retryableReads > 1) throw new Error("SECOND-READ");
        return true;
      },
      get diagnosticCode(): null {
        codeReads += 1;
        if (codeReads > 1) throw new Error("SECOND-READ");
        return null;
      },
    };
    expect(parseProviderPollObservation(stateful)).toEqual({
      kind: "FAILED",
      retryable: true,
      diagnosticCode: null,
    });
    expect(retryableReads).toBe(1);
    expect(codeReads).toBe(1);
  });

  it("returns null, rather than throwing, for a revoked Proxy", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => parseProviderPollObservation(proxy)).not.toThrow();
    expect(parseProviderPollObservation(proxy)).toBeNull();
  });
});

describe("a failure's fields are proved, not assumed", () => {
  it.each([
    ['the string "false"', "false"],
    ['the string "true"', "true"],
    ["the number 1", 1],
    ["the number 0", 0],
    ["null", null],
    ["undefined", undefined],
    ["an object", {}],
  ])("refuses a retryable flag that is %s", (_label, retryable) => {
    // `"false"` is truthy. Believing it rather than proving it decides whether
    // the customer's request may be attempted again at all.
    expect(isWellFormedPollObservation({ kind: "FAILED", retryable, diagnosticCode: null })).toBe(
      false,
    );
  });

  it.each([
    ["a number", 429],
    ["an object", { code: "TIMEOUT" }],
    ["lowercase", "timeout"],
    ["padded", "TIMEOUT "],
    ["a credential", "Bearer sk-live-abcdef"],
    ["a signed URL", RAW_URL],
    ["a prompt", "a sunlit living room, cinematic"],
    ["a retired code", "RATE_LIMITED"],
  ])("refuses a diagnostic that is %s", (_label, diagnosticCode) => {
    expect(
      isWellFormedPollObservation({ kind: "FAILED", retryable: true, diagnosticCode }),
    ).toBe(false);
  });

  it("refuses a failure missing either required field", () => {
    expect(isWellFormedPollObservation({ kind: "FAILED", diagnosticCode: null })).toBe(false);
    expect(isWellFormedPollObservation({ kind: "FAILED", retryable: true })).toBe(false);
  });
});
