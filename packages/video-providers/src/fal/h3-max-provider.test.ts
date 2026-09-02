import { describe, expect, it, vi } from "vitest";
import { MINIMAX_H3_MAX_MODEL_ID } from "../catalog";
import { ProviderErrorException } from "../errors";
import type { HttpClient, HttpRequest, HttpResponse } from "../http";
import type { ProviderGenerationInput } from "../types";
import { FalH3MaxSubmissionProvider } from "./h3-max-provider";
import { falHttpError } from "./errors";

/**
 * The dormant fal / H3 Max submission adapter.
 *
 * Two things pull in opposite directions here. The **request** must be exact —
 * the frozen native token and the documented fields, nothing internal, nothing
 * invented. The **classification** must be conservative — no remote status is
 * treated as proof fal did not accept the request, because fal publishes
 * nothing that establishes it.
 *
 * Every test injects a stub transport. Nothing resolves a hostname, no
 * credential here is real, and no fal SDK is loaded.
 */

const CREDENTIAL = "fal-secret-credential";

/**
 * The submission deadline, stated here rather than imported.
 *
 * Importing the production constant would assert it against itself: a drift
 * from 60 s would move the implementation and the expectation together and this
 * suite would stay green. The contract is 60 seconds, so the test owns 60
 * seconds.
 */
const EXPECTED_SUBMISSION_TIMEOUT_MS = 60_000;

const input: ProviderGenerationInput = {
  modelId: MINIMAX_H3_MAX_MODEL_ID,
  sourceImageUrl: "https://storage.internal/o/org/img?token=SIGNEDTOKEN",
  prompt: "a sunlit living room, slow pan left",
  durationSeconds: 6,
  aspectRatio: "16:9",
  // The frozen native token for a 1080p product target on H3 Max.
  nativeGenerationResolution: "768P",
  requestHash: "sha256:v2:internal-only",
};

const now = () => new Date("2026-09-02T00:00:00.000Z");

function respondWith(response: HttpResponse) {
  const calls: HttpRequest[] = [];
  const http: HttpClient = {
    request(req) {
      calls.push(req);
      return Promise.resolve(response);
    },
  };
  return { http, calls };
}

function provider(http: HttpClient) {
  return new FalH3MaxSubmissionProvider({ credential: CREDENTIAL }, { http, now });
}

function bodyOf(calls: HttpRequest[]): Record<string, unknown> {
  return JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
}

const accepted: HttpResponse = {
  status: 200,
  body: JSON.stringify({
    request_id: "req_abc123",
    response_url: "https://queue.fal.run/x/requests/req_abc123",
    status_url: "https://queue.fal.run/x/requests/req_abc123/status",
    cancel_url: "https://queue.fal.run/x/requests/req_abc123/cancel",
    gateway_request_id: "gw_should_not_be_used",
  }),
};

describe("fal H3 Max submission — accepted", () => {
  it("returns ACCEPTED with the queue request_id as the prediction id", async () => {
    const { http, calls } = respondWith(accepted);

    const outcome = await provider(http).createGeneration(input);

    if (outcome.kind !== "ACCEPTED") throw new Error("expected ACCEPTED");
    expect(outcome.ref).toEqual({
      provider: "fal",
      modelId: MINIMAX_H3_MAX_MODEL_ID,
      predictionId: "req_abc123",
      submittedAt: "2026-09-02T00:00:00.000Z",
    });
    expect(calls).toHaveLength(1);
  });

  it("POSTs to the frozen queue URL with Key auth, manual redirect and a timeout", async () => {
    const { http, calls } = respondWith(accepted);

    await provider(http).createGeneration(input);

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://queue.fal.run/minimax/h3-max/image-to-video");
    expect(calls[0]?.headers.Authorization).toBe(`Key ${CREDENTIAL}`);
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]?.redirect).toBe("manual");
    expect(calls[0]?.timeoutMs).toBe(EXPECTED_SUBMISSION_TIMEOUT_MS);
  });

  it("trims a request_id that arrives padded", async () => {
    const { http } = respondWith({ status: 200, body: JSON.stringify({ request_id: " req_1 \n" }) });

    const outcome = await provider(http).createGeneration(input);

    if (outcome.kind !== "ACCEPTED") throw new Error("expected ACCEPTED");
    expect(outcome.ref.predictionId).toBe("req_1");
  });
});

describe("fal H3 Max submission — request mapping", () => {
  it("sends exactly the documented fields with the frozen constants", async () => {
    const { http, calls } = respondWith(accepted);

    await provider(http).createGeneration(input);

    expect(bodyOf(calls)).toEqual({
      image_url: input.sourceImageUrl,
      prompt: input.prompt,
      duration: 6,
      resolution: "768P",
      prompt_expansion_mode: "balanced",
      enable_safety_checker: true,
    });
  });

  it("includes seed only when the caller supplies one", async () => {
    const withSeed = respondWith(accepted);
    await provider(withSeed.http).createGeneration({ ...input, seed: 99 });
    expect(bodyOf(withSeed.calls).seed).toBe(99);

    const without = respondWith(accepted);
    await provider(without.http).createGeneration(input);
    expect(Object.keys(bodyOf(without.calls))).not.toContain("seed");
  });

  /**
   * The financially significant regression.
   *
   * H3 Max generates at 768P; the product target for this path is 1080p. Asking
   * fal for `1080p` would either be refused or answered with something the model
   * cannot actually produce — and billed either way. The provider receives the
   * native token and nothing else; composition owns the deliverable.
   */
  it("sends the frozen native 768P for a 1080p delivery path, never 1080p", async () => {
    const { http, calls } = respondWith(accepted);

    await provider(http).createGeneration(input);

    expect(bodyOf(calls).resolution).toBe("768P");
    expect(calls[0]?.body).not.toContain("1080p");
  });

  it("transmits no internal identity, idempotency or product-delivery field", async () => {
    const { http, calls } = respondWith(accepted);

    await provider(http).createGeneration(input);

    const serialized = calls[0]?.body ?? "";
    for (const forbidden of [
      "requestHash",
      "request_hash",
      "sha256",
      "targetOutputResolution",
      "resolutionNormalization",
      "nativeMeetsTarget",
      "aspect_ratio",
      "aspectRatio",
      "webhook",
      "end_image_url",
      "sync_mode",
    ]) {
      expect(`${forbidden}:${serialized.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    expect(Object.keys(calls[0]?.headers ?? {})).not.toContain("Idempotency-Key");
    expect(Object.keys(calls[0]?.headers ?? {}).sort()).toEqual(["Authorization", "Content-Type"]);
  });
});

describe("fal H3 Max submission — every remote result without a request_id is UNKNOWN", () => {
  it.each([301, 302, 400, 401, 403, 408, 422, 429, 500, 503])(
    "treats %i as SUBMISSION_UNKNOWN, after one invocation",
    async (status) => {
      const { http, calls } = respondWith({ status, body: JSON.stringify({ detail: "whatever" }) });

      const outcome = await provider(http).createGeneration(input);

      expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
      expect(calls).toHaveLength(1);
    },
  );

  it("does not copy WaveSpeed's definitive 400/401/403 rule", async () => {
    // WaveSpeed allowlists these because its contract establishes them. fal's
    // does not, and inheriting the rule would invent a certainty fal never gave.
    for (const status of [400, 401, 403]) {
      const { http } = respondWith({ status, body: "" });
      expect((await provider(http).createGeneration(input)).kind).toBe("SUBMISSION_UNKNOWN");
    }
  });

  it("keeps a 429 UNKNOWN even though its error is retryable", async () => {
    const { http } = respondWith({ status: 429, body: "slow down" });

    const outcome = await provider(http).createGeneration(input);

    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    if (outcome.kind === "ACCEPTED") throw new Error("expected a failure outcome");
    expect(outcome.error.retryable).toBe(true);
  });

  it.each([
    ["malformed JSON", "<html>not json</html>"],
    ["JSON null", "null"],
    ["an empty body", ""],
    ["an array", "[]"],
    ["a scalar", "42"],
    ["an unexpected envelope", JSON.stringify({ data: { id: "req_1" } })],
    ["a missing request_id", JSON.stringify({ status: "IN_QUEUE" })],
    ["a non-string request_id", JSON.stringify({ request_id: 12345 })],
    ["a null request_id", JSON.stringify({ request_id: null })],
    ["an empty request_id", JSON.stringify({ request_id: "" })],
    ["a whitespace-only request_id", JSON.stringify({ request_id: "  \t\n" })],
  ])("treats a 2xx with %s as UNKNOWN, after one invocation", async (_label, body) => {
    const { http, calls } = respondWith({ status: 200, body });

    const outcome = await provider(http).createGeneration(input);

    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    if (outcome.kind === "ACCEPTED") throw new Error("expected a failure outcome");
    expect(outcome.error.code).toBe("FAL_SUBMISSION_RESPONSE_INVALID");
    expect(calls).toHaveLength(1);
  });

  it("never treats an adjacent identifier as acceptance", async () => {
    // Only `request_id` names the work. A URL or a gateway id would let a body
    // that never identified the job look trackable.
    const { http } = respondWith({
      status: 200,
      body: JSON.stringify({
        response_url: "https://queue.fal.run/x/requests/req_9",
        status_url: "https://queue.fal.run/x/requests/req_9/status",
        cancel_url: "https://queue.fal.run/x/requests/req_9/cancel",
        gateway_request_id: "gw_9",
      }),
    });

    expect((await provider(http).createGeneration(input)).kind).toBe("SUBMISSION_UNKNOWN");
  });

  it("never says a malformed success was accepted", async () => {
    const { http } = respondWith({ status: 200, body: "null" });

    const outcome = await provider(http).createGeneration(input);

    if (outcome.kind === "ACCEPTED") throw new Error("expected a failure outcome");
    expect(outcome.error.messageSanitized).toBe(
      "fal submission response did not contain a usable request id",
    );
    expect(outcome.error.messageSanitized).not.toContain("accepted");
  });

  it.each([
    ["a network failure", new Error("ECONNRESET"), "FAL_SUBMISSION_NETWORK_ERROR"],
    ["a timeout", Object.assign(new Error("aborted"), { name: "AbortError" }), "FAL_SUBMISSION_TIMEOUT"],
  ])("treats %s as UNKNOWN and does not retry", async (_label, thrown, code) => {
    const request = vi.fn().mockRejectedValue(thrown);

    const outcome = await provider({ request }).createGeneration(input);

    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    if (outcome.kind === "ACCEPTED") throw new Error("expected a failure outcome");
    expect(outcome.error.code).toBe(code);
    // A second POST here is the exact duplicate charge this prevents.
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("treats a synchronous throw from inside the transport as UNKNOWN", async () => {
    // Raised from within the invoked method, so it is post-invocation: fal may
    // already hold the request.
    const request = vi.fn(() => {
      throw new Error("socket exploded");
    });

    const outcome = await provider({ request }).createGeneration(input);

    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("fal H3 Max submission — local refusals happen before any POST", () => {
  it("refuses an unsupported model definitively, with zero HTTP calls", async () => {
    const request = vi.fn();

    const outcome = await provider({ request }).createGeneration({
      ...input,
      modelId: "minimax/h3/image-to-video",
    });

    expect(outcome.kind).toBe("DEFINITIVELY_REJECTED");
    if (outcome.kind === "ACCEPTED") throw new Error("expected a failure outcome");
    expect(outcome.error.code).toBe("FAL_UNSUPPORTED_MODEL");
    // The whole basis for calling it definitive: nothing was sent.
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses a blank credential definitively, with zero HTTP calls", async () => {
    const request = vi.fn();
    const adapter = new FalH3MaxSubmissionProvider({ credential: "   " }, { http: { request }, now });

    const outcome = await adapter.createGeneration(input);

    expect(outcome.kind).toBe("DEFINITIVELY_REJECTED");
    if (outcome.kind === "ACCEPTED") throw new Error("expected a failure outcome");
    expect(outcome.error.code).toBe("FAL_MISSING_CREDENTIAL");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("fal H3 Max submission — a local defect is not certainty", () => {
  it("propagates an unexpected pre-invocation defect instead of classifying it", async () => {
    // `DEFINITIVELY_REJECTED` asserts fal could not have begun or billed work;
    // a bug here is no evidence for that. Injected through the input, so no
    // framework is needed.
    const defective: ProviderGenerationInput = Object.defineProperty({ ...input }, "prompt", {
      get(): string {
        throw new TypeError("invariant violated while building the request");
      },
    });
    const request = vi.fn();

    await expect(provider({ request }).createGeneration(defective)).rejects.toThrow(TypeError);
    expect(request).not.toHaveBeenCalled();
  });

  it("propagates a defect raised while resolving the transport method", async () => {
    // Resolving `http.request` is pre-invocation work. Inside the certainty
    // `try`, a broken transport would become an unknown submission — when
    // nothing was ever called.
    const http: HttpClient = {
      get request(): never {
        throw new TypeError("transport is not wired");
      },
    };

    await expect(provider(http).createGeneration(input)).rejects.toThrow(TypeError);
  });
});

describe("fal H3 Max submission — nothing sensitive escapes", () => {
  it.each([400, 422, 500])("keeps provider bytes out of a %i outcome", async (status) => {
    const { http } = respondWith({
      status,
      body: JSON.stringify({
        detail: `image_url=${input.sourceImageUrl}`,
        credential: CREDENTIAL,
        prompt: input.prompt,
      }),
    });

    const serialized = JSON.stringify(await provider(http).createGeneration(input));

    expect(serialized).not.toContain(CREDENTIAL);
    expect(serialized).not.toContain("SIGNEDTOKEN");
    expect(serialized).not.toContain("storage.internal");
    expect(serialized).not.toContain(input.prompt);
    expect(serialized).not.toContain(input.requestHash);
    expect(serialized).not.toContain("detail");
  });

  it("does not put an arbitrary thrown message into the error", async () => {
    const hostile = new Error(`Key ${CREDENTIAL} leaked via ${input.sourceImageUrl}`);
    const request = vi.fn().mockRejectedValue(hostile);

    const serialized = JSON.stringify(await provider({ request }).createGeneration(input));

    expect(serialized).not.toContain(CREDENTIAL);
    expect(serialized).not.toContain("SIGNEDTOKEN");
    expect(serialized).not.toContain("leaked");
  });

  it("carries no cause or raw body on the error object", async () => {
    const { http } = respondWith({ status: 500, body: "raw provider bytes" });

    const outcome = await provider(http).createGeneration(input);

    if (outcome.kind === "ACCEPTED") throw new Error("expected a failure outcome");
    expect(Object.keys(outcome.error).sort()).toEqual(
      ["code", "kind", "messageSanitized", "providerStatus", "retryable"].sort(),
    );
    expect(JSON.stringify(outcome.error)).not.toContain("raw provider bytes");
  });

  /**
   * The local refusal path, which every case above skips.
   *
   * All the other secrecy tests run *after* a POST, so a local refusal could
   * have quoted the credential straight back with nothing failing — and a local
   * refusal is the message most likely to be written as a helpful diagnostic,
   * because the fault is on this side. This is the gap the superseded PR left
   * open. The adapter holds the real credential on this path, so its absence
   * here is evidence rather than an accident of the fixture.
   */
  it("keeps the credential out of a local refusal, where it is in scope", async () => {
    const request = vi.fn();

    const outcome = await provider({ request }).createGeneration({
      ...input,
      modelId: "minimax/h3/image-to-video",
    });

    expect(request).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome)).not.toContain(CREDENTIAL);
  });
});

describe("fal trusts a thrown value by provenance, never by shape", () => {
  it("refuses a structurally valid look-alike thrown by the transport", async () => {
    // Every field has the right type, so a duck test accepts it — and the
    // thrower has then chosen both public diagnostic strings (ADR-0031 §4).
    const request = vi.fn().mockRejectedValue({
      error: {
        kind: "AUTH",
        retryable: false,
        code: CREDENTIAL,
        messageSanitized: input.sourceImageUrl,
        providerStatus: 401,
      },
      kind: "AUTH",
      retryable: false,
      code: CREDENTIAL,
      messageSanitized: input.sourceImageUrl,
      providerStatus: 401,
    });

    const outcome = await provider({ request }).createGeneration(input);

    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    if (outcome.kind === "ACCEPTED") throw new Error("expected a failure outcome");
    expect(outcome.error.code).toBe("FAL_SUBMISSION_NETWORK_ERROR");
    expect(outcome.error.messageSanitized).toBe("Network error contacting fal");
    expect(outcome.error.retryable).toBe(true);
    expect(outcome.error.providerStatus).toBeUndefined();
    expect(JSON.stringify(outcome)).not.toContain(CREDENTIAL);
  });

  it("preserves an error this application constructed, via instanceof", () => {
    const original = falHttpError(503);

    expect(provider({ request: vi.fn() }).normalizeError(new ProviderErrorException(original))).toEqual(
      original,
    );
  });
});
