import { describe, expect, it } from "vitest";
import { WAVESPEED_OPEN_VIDEO_MODEL_ID } from "@app/shared";
import { ProviderErrorException, isHttpStatus, providerError } from "./errors";
import { FakeVideoProvider } from "./fake/fake-provider";
import { WaveSpeedVideoProvider } from "./wavespeed/wavespeed-provider";
import { normalizeHttpStatusError, normalizeWaveSpeedError } from "./wavespeed/mapping";
import type { WaveSpeedConfig } from "./wavespeed/config";
import type { HttpClient, HttpResponse } from "./wavespeed/http";
import type { ProviderError, ProviderGenerationInput, ProviderGenerationRef } from "./types";

/**
 * The secrecy contract, exercised with values that would be catastrophic to
 * leak rather than with neutral placeholders.
 *
 * Every sentinel below is a *distinct* string, so a failure names which class of
 * secret escaped rather than only that something did.
 */
const SENTINELS = {
  signedUrl: "https://storage.internal/o/org-9/normalized.jpg?X-Signature=SIGNEDURLSENTINEL",
  apiToken: "sk-live-APITOKENSENTINEL",
  prompt: "PROMPTSENTINEL sunlit living room facing the bay",
  control: "CONTROLSENTINEL\n\r\u0000\u001b[31mred",
  providerText: "PROVIDERBODYSENTINEL: invalid parameter image=https://leak",
} as const;

/** A provider response body carrying every sentinel at once. */
const HOSTILE_BODY = JSON.stringify({
  error: SENTINELS.providerText,
  echoed: { image: SENTINELS.signedUrl, prompt: SENTINELS.prompt },
  token: SENTINELS.apiToken,
  note: SENTINELS.control,
});

/** An `Error` whose every readable surface carries a sentinel. */
function hostileError(): Error {
  const err = new Error(`${SENTINELS.providerText} ${SENTINELS.signedUrl}`);
  err.stack = `Error: ${SENTINELS.apiToken}\n    at ${SENTINELS.signedUrl}`;
  Object.assign(err, {
    cause: { address: SENTINELS.control, prompt: SENTINELS.prompt },
    errno: -111,
    hostname: SENTINELS.control,
  });
  return err;
}

/**
 * Everything a caller can reach from a normalized error, flattened.
 *
 * Checking the serialized form *and* the thrown value's default rendering is
 * the point: the second is what an unguarded `console.error(err)` prints, and
 * it is the surface `new Error(msg, { cause })` used to widen.
 */
function reachableText(error: ProviderError): string {
  const exception = new ProviderErrorException(error);
  return [
    JSON.stringify(error),
    JSON.stringify(exception),
    String(exception),
    exception.message,
    exception.stack ?? "",
    error.code,
    error.messageSanitized,
  ].join("");
}

function expectNoSentinels(error: ProviderError): void {
  const text = reachableText(error);
  for (const [name, sentinel] of Object.entries(SENTINELS)) {
    expect(`${name}:${text.includes(sentinel)}`).toBe(`${name}:false`);
  }
  expect(Object.prototype.hasOwnProperty.call(error, "cause")).toBe(false);
  // `new Error(msg, { cause })` defines `cause` as a non-enumerable own
  // property, so serialization alone would not see it. Ask directly.
  const exception = new ProviderErrorException(error);
  expect(Object.prototype.hasOwnProperty.call(exception, "cause")).toBe(false);
  expect(exception.cause).toBeUndefined();
}

const config: WaveSpeedConfig = {
  apiKey: SENTINELS.apiToken,
  baseUrl: "https://api.wavespeed.ai/api/v3",
  poll: { initialMs: 1000, maxMs: 10000, timeoutMs: 60000 },
  pricing: { currency: "USD", costPerSecondMinor: 10 },
};

const input: ProviderGenerationInput = {
  modelId: WAVESPEED_OPEN_VIDEO_MODEL_ID,
  sourceImageUrl: SENTINELS.signedUrl,
  prompt: SENTINELS.prompt,
  durationSeconds: 5,
  aspectRatio: "16:9",
  resolution: "1080p",
  requestHash: "hash1",
};

const ref: ProviderGenerationRef = {
  provider: "wavespeed",
  modelId: WAVESPEED_OPEN_VIDEO_MODEL_ID,
  predictionId: "pred_9",
  submittedAt: "2026-01-01T00:00:00.000Z",
};

function clientReturning(res: HttpResponse): HttpClient {
  return { request: () => Promise.resolve(res) };
}

function clientThrowing(value: unknown): HttpClient {
  return { request: () => Promise.reject(value) };
}

/**
 * The `ProviderError` from a submission that did not succeed, whichever
 * certainty arm it landed in. Fails loudly on ACCEPTED so a test that stops
 * exercising the failure path cannot pass silently.
 */
async function submissionErrorOf(provider: WaveSpeedVideoProvider): Promise<ProviderError> {
  const outcome = await provider.createGeneration(input);
  if (outcome.kind === "ACCEPTED") throw new Error("expected a failed submission outcome");
  return outcome.error;
}

async function caught(op: () => Promise<unknown>): Promise<ProviderErrorException> {
  try {
    await op();
  } catch (err) {
    if (err instanceof ProviderErrorException) return err;
    throw err;
  }
  throw new Error("expected the operation to reject");
}

/**
 * Statuses the adapter distinguishes today, plus one it does not.
 *
 * Retryability and kind are the **diagnostic** classification, and stay exactly
 * as they were. Whether a status proves the provider did not accept a paid
 * submission is a separate question, answered by `isDefinitiveRejectionStatus`
 * and covered in `submission-certainty.test.ts` — 429 and 500 appear below as
 * `retryable: true` and are nonetheless `SUBMISSION_UNKNOWN` (ADR-0032).
 */
const STATUS_CASES: readonly {
  status: number;
  kind: ProviderError["kind"];
  code: string;
  retryable: boolean;
}[] = [
  { status: 400, kind: "INVALID_INPUT", code: "WAVESPEED_INVALID_INPUT", retryable: false },
  { status: 401, kind: "AUTH", code: "WAVESPEED_AUTH_FAILED", retryable: false },
  { status: 403, kind: "AUTH", code: "WAVESPEED_AUTH_FAILED", retryable: false },
  { status: 422, kind: "INVALID_INPUT", code: "WAVESPEED_INVALID_INPUT", retryable: false },
  { status: 429, kind: "RATE_LIMITED", code: "WAVESPEED_RATE_LIMITED", retryable: true },
  { status: 500, kind: "PROVIDER", code: "WAVESPEED_SERVER_ERROR", retryable: true },
  { status: 418, kind: "PROVIDER", code: "WAVESPEED_UNEXPECTED_STATUS", retryable: false },
];

describe("HTTP status diagnostics are sanitized", () => {
  it.each(STATUS_CASES)(
    "status $status keeps its kind, records providerStatus, and needs no body",
    ({ status, kind, code, retryable }) => {
      const error = normalizeHttpStatusError(status);
      expect(error.kind).toBe(kind);
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(retryable);
      expect(error.providerStatus).toBe(status);
      expectNoSentinels(error);
    },
  );

  it("names the status in the unexpected-status message and nothing else", () => {
    expect(normalizeHttpStatusError(418).messageSanitized).toBe(
      "WaveSpeedAI returned an unexpected HTTP status 418",
    );
  });

  /**
   * The end-to-end form, and the one that fails if the body summary returns.
   * The stub answers every operation with a body full of sentinels.
   *
   * `createGeneration` now *returns* its failure rather than throwing
   * (ADR-0032), so its error is read off the outcome; the two idempotent
   * operations still throw. The sanitization assertion is identical either way
   * — which is the point, since the error object is the same type.
   */
  const operations: readonly {
    name: string;
    errorOf: (p: WaveSpeedVideoProvider) => Promise<ProviderError>;
  }[] = [
    { name: "createGeneration", errorOf: (p) => submissionErrorOf(p) },
    { name: "getStatus", errorOf: async (p) => (await caught(() => p.getStatus(ref))).error },
    {
      name: "cancelGeneration",
      errorOf: async (p) => (await caught(() => p.cancelGeneration(ref))).error,
    },
  ];

  for (const { name, errorOf } of operations) {
    it.each(STATUS_CASES)(`${name} discards a hostile $status body`, async ({ status }) => {
      const provider = new WaveSpeedVideoProvider(config, {
        http: clientReturning({ status, body: HOSTILE_BODY }),
      });
      const error = await errorOf(provider);
      expectNoSentinels(error);
      expect(error.providerStatus).toBe(status);
    });
  }

  it("keeps a hostile body out of a 2xx response that carries no prediction id", async () => {
    const provider = new WaveSpeedVideoProvider(config, {
      http: clientReturning({ status: 200, body: HOSTILE_BODY }),
    });
    const error = await submissionErrorOf(provider);
    expect(error.code).toBe("WAVESPEED_MISSING_PREDICTION_ID");
    expectNoSentinels(error);
  });
});

describe("network and abort diagnostics retain nothing external", () => {
  it("normalizes a hostile Error into the fixed network diagnostic", () => {
    const error = normalizeWaveSpeedError(hostileError());
    expect(error.kind).toBe("NETWORK");
    expect(error.code).toBe("WAVESPEED_NETWORK_ERROR");
    expect(error.messageSanitized).toBe("Network error contacting WaveSpeedAI");
    expect(error.providerStatus).toBeUndefined();
    expectNoSentinels(error);
  });

  it("normalizes an AbortError into the fixed timeout diagnostic", () => {
    const abort = hostileError();
    abort.name = "AbortError";
    const error = normalizeWaveSpeedError(abort);
    expect(error.kind).toBe("TIMEOUT");
    expect(error.code).toBe("WAVESPEED_TIMEOUT");
    expect(error.messageSanitized).toBe("WaveSpeedAI request timed out");
    expectNoSentinels(error);
  });

  it("normalizes a hostile plain object without retaining its content", () => {
    const error = normalizeWaveSpeedError({
      body: SENTINELS.providerText,
      url: SENTINELS.signedUrl,
    });
    expect(error.kind).toBe("NETWORK");
    expectNoSentinels(error);
  });

  it("carries nothing external out of a rejected request, end to end", async () => {
    const provider = new WaveSpeedVideoProvider(config, { http: clientThrowing(hostileError()) });
    const error = await submissionErrorOf(provider);
    expect(error.kind).toBe("NETWORK");
    expectNoSentinels(error);
  });
});

describe("no external value is promoted to a normalized error by its shape", () => {
  /**
   * The case that closed the last hole, and the reason shape validation was
   * abandoned rather than tightened.
   *
   * Every field here has exactly the right type: a real `ProviderErrorKind`, a
   * boolean `retryable`, string `code` and `messageSanitized`, a valid HTTP
   * status. A structural validator — including one that rebuilds a clean object
   * from those five fields — accepts it, and the attacker has then chosen both
   * public diagnostic strings. Only provenance can refuse it.
   */
  it("refuses a fully structurally valid hostile look-alike", () => {
    const lookAlike = {
      kind: "AUTH",
      retryable: false,
      code: SENTINELS.apiToken,
      messageSanitized: SENTINELS.signedUrl,
      providerStatus: 401,
    };
    const error = normalizeWaveSpeedError(lookAlike);
    expect(error.kind).toBe("NETWORK");
    expect(error.code).toBe("WAVESPEED_NETWORK_ERROR");
    expect(error.messageSanitized).toBe("Network error contacting WaveSpeedAI");
    expect(error.providerStatus).toBeUndefined();
    expectNoSentinels(error);
  });

  /**
   * The nominal boundary that survives, exercised where it actually lives.
   * `WaveSpeedVideoProvider.normalizeError` trusts an `instanceof`, never a
   * shape, so an error this application constructed comes back intact.
   */
  it("preserves an error this application constructed, via instanceof", () => {
    const provider = new WaveSpeedVideoProvider(config, { http: clientReturning({ status: 200, body: "{}" }) });
    for (const { status } of STATUS_CASES) {
      const original = normalizeHttpStatusError(status);
      expect(provider.normalizeError(new ProviderErrorException(original))).toEqual(original);
    }
  });

  /** Every one of these also satisfies the old `kind` + `retryable` duck test. */
  const IMPOSTORS: readonly { name: string; value: unknown }[] = [
    {
      name: "non-string code",
      value: { kind: "NETWORK", retryable: true, code: 7, messageSanitized: SENTINELS.prompt },
    },
    {
      name: "non-boolean retryable",
      value: {
        kind: "NETWORK",
        retryable: "yes",
        code: SENTINELS.providerText,
        messageSanitized: SENTINELS.signedUrl,
      },
    },
    {
      name: "kind borrowed from Object.prototype",
      value: {
        kind: "toString",
        retryable: true,
        code: SENTINELS.apiToken,
        messageSanitized: SENTINELS.control,
      },
    },
    {
      name: "unknown kind",
      value: {
        kind: "TOTALLY_FINE",
        retryable: false,
        code: SENTINELS.apiToken,
        messageSanitized: SENTINELS.prompt,
      },
    },
    {
      name: "non-string messageSanitized",
      value: { kind: "AUTH", retryable: false, code: "C", messageSanitized: { SENTINELS } },
    },
    {
      name: "out-of-range providerStatus",
      value: {
        kind: "PROVIDER",
        retryable: false,
        code: "C",
        messageSanitized: "M",
        providerStatus: 99,
      },
    },
    {
      name: "array wearing the right keys",
      value: Object.assign([], { kind: "NETWORK", retryable: true, code: "C", messageSanitized: "M" }),
    },
    { name: "null", value: null },
  ];

  it.each(IMPOSTORS)("rejects $name", ({ value }) => {
    const error = normalizeWaveSpeedError(value);
    expect(error.kind).toBe("NETWORK");
    expect(error.code).toBe("WAVESPEED_NETWORK_ERROR");
    expectNoSentinels(error);
  });

  it("refuses a look-alike smuggling a raw body and an Authorization header", () => {
    const error = normalizeWaveSpeedError({
      kind: "PROVIDER",
      retryable: false,
      code: "WAVESPEED_SERVER_ERROR",
      messageSanitized: "WaveSpeedAI returned a server error",
      providerStatus: 503,
      rawBody: HOSTILE_BODY,
      request: { headers: { Authorization: `Bearer ${SENTINELS.apiToken}` } },
    });
    expect(error.kind).toBe("NETWORK");
    expectNoSentinels(error);
  });
});

describe("the error vocabulary has exactly one runtime authority", () => {
  /**
   * Every kind resolves a declared default without an explicit `retryable`.
   * The map is `Record<ProviderErrorKind, boolean>`, so omitting a key fails
   * `tsc`; this asserts the runtime half — that no kind falls through to an
   * accidental value. The previous revision also exported a `isProviderErrorKind`
   * guard; it went with `asProviderError`, because a shape predicate with no
   * caller is the seed of the next shape-trust bypass.
   */
  it("resolves a declared default for every kind", () => {
    const expected: Record<ProviderError["kind"], boolean> = {
      NETWORK: true,
      RATE_LIMITED: true,
      TIMEOUT: true,
      AUTH: false,
      INVALID_INPUT: false,
      MODERATION: false,
      UNSUPPORTED: false,
      PROVIDER: false,
      UNKNOWN: false,
    };
    for (const [kind, retryable] of Object.entries(expected)) {
      const error = providerError({
        kind: kind as ProviderError["kind"],
        code: "c",
        messageSanitized: "m",
      });
      expect(`${kind}:${error.retryable}`).toBe(`${kind}:${retryable}`);
    }
  });

  it("admits only integer HTTP statuses", () => {
    for (const ok of [100, 200, 418, 503, 599]) expect(isHttpStatus(ok)).toBe(true);
    for (const bad of [99, 600, 200.5, NaN, Infinity, "200", null, undefined]) {
      expect(`${String(bad)}:${isHttpStatus(bad)}`).toBe(`${String(bad)}:false`);
    }
  });

  it("drops a providerStatus that is not a real status", () => {
    const error = providerError({
      kind: "PROVIDER",
      code: "c",
      messageSanitized: "m",
      providerStatus: 42,
    });
    expect(Object.prototype.hasOwnProperty.call(error, "providerStatus")).toBe(false);
  });
});

describe("the fake provider obeys the same contract", () => {
  it("returns a fixed diagnostic for a hostile error", () => {
    const error = new FakeVideoProvider().normalizeError(hostileError());
    expect(error).toEqual({
      kind: "UNKNOWN",
      retryable: false,
      code: "FAKE_PROVIDER_ERROR",
      messageSanitized: "Fake provider error",
    });
    expectNoSentinels(error);
  });

  it("returns the same fixed diagnostic for a hostile non-Error", () => {
    const error = new FakeVideoProvider().normalizeError({ body: HOSTILE_BODY });
    expect(error.messageSanitized).toBe("Fake provider error");
    expectNoSentinels(error);
  });
});

/**
 * `Assert<T>` fails to compile unless `T` is exactly `true`, so each pin below
 * is a build error rather than a runtime expectation. `[T] extends [never]`
 * rather than `T extends never`, because a bare `never` distributes and would
 * quietly answer `never` — i.e. neither true nor false — for every input.
 */
type Assert<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;
type IsExactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("the safe shape is pinned at the type level", () => {
  it("declares no cause and no details bag", () => {
    type Forbidden =
      | "cause"
      | "rawBody"
      | "response"
      | "request"
      | "headers"
      | "url"
      | "details"
      | "meta";
    const noneOnError: Assert<IsNever<Extract<keyof ProviderError, Forbidden>>> = true;
    const noneOnInit: Assert<
      IsNever<Extract<keyof Parameters<typeof providerError>[0], Forbidden>>
    > = true;
    expect([noneOnError, noneOnInit]).toEqual([true, true]);
  });

  /**
   * The exception cannot get the same pin, and the reason is worth stating
   * rather than working around: `ProviderErrorException extends Error`, and the
   * `Error` interface itself declares `cause?: unknown` (ES2022). `"cause"` is
   * therefore in `keyof ProviderErrorException` no matter what this class does,
   * so a `never` assertion over its keys could never pass and removing the key
   * would mean not being an `Error`.
   *
   * What *is* enforceable is the surface this class adds on top of `Error` —
   * exactly one field — plus the runtime facts below: the inherited `cause` is
   * never populated, and the only own properties are `error` and `name`.
   */
  it("adds exactly one field of its own to Error", () => {
    const onlyError: Assert<
      IsExactly<keyof Omit<ProviderErrorException, keyof Error>, "error">
    > = true;
    expect(onlyError).toBe(true);
  });

  it("types providerStatus as an optional number and nothing looser", () => {
    const exact: Assert<IsExactly<ProviderError["providerStatus"], number | undefined>> = true;
    expect(exact).toBe(true);
  });

  it("exposes only the normalized error on the exception", () => {
    const exception = new ProviderErrorException(normalizeHttpStatusError(500));
    const own = Object.keys(exception).sort();
    expect(own).toEqual(["error", "name"]);
    expect(exception.cause).toBeUndefined();
  });
});
