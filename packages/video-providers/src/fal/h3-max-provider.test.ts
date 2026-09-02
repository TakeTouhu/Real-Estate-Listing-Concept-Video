import { describe, expect, it, vi } from "vitest";
import { ProviderErrorException } from "../errors";
import type { HttpClient, HttpRequest, HttpResponse } from "../http";
import type { ProviderGenerationInput } from "../types";
import { FalH3MaxSubmissionProvider, FAL_SUBMISSION_TIMEOUT_MS } from "./h3-max-provider";
import { falHttpError } from "./errors";
import { FAL_H3_MAX_ENDPOINT_ID } from "./h3-max-mapping";

/**
 * The dormant fal / H3 Max submission adapter.
 *
 * Two things are being proven, and they pull in opposite directions:
 *
 * 1. The **request** is exact. What reaches fal's queue is the frozen native
 *    token and the documented fields, with nothing invented and nothing
 *    internal leaked.
 * 2. The **classification** is conservative. Unlike WaveSpeed, no remote status
 *    is treated as proof that fal did not accept the request — because fal's
 *    queue documents client and model errors, 422 included, that can be raised
 *    after work has begun.
 *
 * Every test injects a stub transport. Nothing here resolves a hostname, and no
 * credential in this file is real.
 */

const CREDENTIAL = "fal-secret-credential";
const BASE_URL = "https://queue.fal.test";

const input: ProviderGenerationInput = {
  modelId: FAL_H3_MAX_ENDPOINT_ID,
  sourceImageUrl: "https://storage.internal/o/org/img?token=SIGNED",
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
  return new FalH3MaxSubmissionProvider({ credential: CREDENTIAL, baseUrl: BASE_URL }, { http, now });
}

function bodyOf(calls: HttpRequest[]): Record<string, unknown> {
  return JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
}

const acceptedResponse: HttpResponse = {
  status: 200,
  body: JSON.stringify({
    request_id: "req_abc123",
    status_url: "https://queue.fal.test/status/req_abc123",
    gateway_request_id: "gw_should_not_be_used",
  }),
};

describe("fal H3 Max submission — accepted", () => {
  it("returns ACCEPTED with the queue request_id as the prediction id", async () => {
    const { http, calls } = respondWith(acceptedResponse);

    const outcome = await provider(http).createGeneration(input);

    expect(outcome.kind).toBe("ACCEPTED");
    if (outcome.kind !== "ACCEPTED") throw new Error("expected ACCEPTED");
    // `request_id` and nothing else: it is the identifier fal documents for
    // later status and result retrieval. `gateway_request_id` and `status_url`
    // are present in the fixture precisely so a wrong choice would show up.
    expect(outcome.ref.predictionId).toBe("req_abc123");
    expect(outcome.ref.provider).toBe("fal");
    expect(outcome.ref.modelId).toBe(FAL_H3_MAX_ENDPOINT_ID);
    expect(outcome.ref.submittedAt).toBe("2026-09-02T00:00:00.000Z");
    expect(calls).toHaveLength(1);
  });

  it("POSTs to the queue endpoint with Key auth, manual redirect and a timeout", async () => {
    const { http, calls } = respondWith(acceptedResponse);

    await provider(http).createGeneration(input);

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`${BASE_URL}/minimax/h3-max/image-to-video`);
    expect(calls[0]?.headers.Authorization).toBe(`Key ${CREDENTIAL}`);
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]?.redirect).toBe("manual");
    expect(calls[0]?.timeoutMs).toBe(FAL_SUBMISSION_TIMEOUT_MS);
  });
});

describe("fal H3 Max submission — request mapping", () => {
  it("sends exactly the documented fields, with the frozen constants", async () => {
    const { http, calls } = respondWith(acceptedResponse);

    await provider(http).createGeneration(input);
    const body = bodyOf(calls);

    expect(body).toEqual({
      image_url: input.sourceImageUrl,
      prompt: input.prompt,
      duration: 6,
      resolution: "768P",
      prompt_expansion_mode: "balanced",
      enable_safety_checker: true,
    });
  });

  it("includes seed only when the caller supplies one", async () => {
    const withoutSeed = respondWith(acceptedResponse);
    await provider(withoutSeed.http).createGeneration(input);
    expect(bodyOf(withoutSeed.calls)).not.toHaveProperty("seed");

    const withSeed = respondWith(acceptedResponse);
    await provider(withSeed.http).createGeneration({ ...input, seed: 42 });
    expect(bodyOf(withSeed.calls).seed).toBe(42);
  });

  it("sends a 1080p target as the frozen native 768P, never as 1080p", async () => {
    // The regression this whole two-resolution architecture exists for. The
    // provider input already carries the native token; the adapter must pass it
    // through untouched, so an upscaled deliverable is never requested as a
    // native 1080p render (ADR-0034).
    const { http, calls } = respondWith(acceptedResponse);

    await provider(http).createGeneration(input);
    const body = bodyOf(calls);

    expect(body.resolution).toBe("768P");
    expect(body.resolution).not.toBe("1080p");
    expect(calls[0]?.body).not.toContain("1080p");
  });

  it("transmits no internal identity, idempotency or product-delivery fields", async () => {
    const { http, calls } = respondWith(acceptedResponse);

    await provider(http).createGeneration(input);
    const body = bodyOf(calls);
    const sent = JSON.stringify({ headers: calls[0]?.headers, body: calls[0]?.body });

    // The hash is this application's coordination key; fal documents no
    // idempotency contract that would make sending it meaningful.
    expect(sent).not.toContain("sha256:v2:internal-only");
    expect(Object.keys(calls[0]?.headers ?? {})).not.toContain("Idempotency-Key");
    // Product facts about what was promised. A provider has no use for them.
    for (const forbidden of [
      "requestHash",
      "targetOutputResolution",
      "resolutionNormalization",
      "nativeMeetsTarget",
      "aspect_ratio",
      "aspectRatio",
      "webhook",
      "end_image_url",
      "sync_mode",
    ]) {
      expect(body).not.toHaveProperty(forbidden);
      expect(sent).not.toContain(forbidden);
    }
  });
});

describe("fal H3 Max submission — everything remote is UNKNOWN", () => {
  it.each([301, 302, 400, 401, 403, 422, 429, 500, 503])(
    "treats %i as SUBMISSION_UNKNOWN, after one POST",
    async (status) => {
      const { http, calls } = respondWith({ status, body: "refused" });

      const outcome = await provider(http).createGeneration(input);

      expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
      expect(calls).toHaveLength(1);
    },
  );

  it("does not copy WaveSpeed's definitive 400/401/403 rule", async () => {
    // Stated as its own case because the temptation is real: the two adapters
    // sit side by side, and fal's queue simply has not published evidence that
    // any status proves non-acceptance.
    for (const status of [400, 401, 403]) {
      const { http } = respondWith({ status, body: "refused" });
      const outcome = await provider(http).createGeneration(input);
      expect(outcome.kind).not.toBe("DEFINITIVELY_REJECTED");
    }
  });

  it("treats a 422 as UNKNOWN because it may already have consumed work", async () => {
    const { http } = respondWith({ status: 422, body: JSON.stringify({ detail: "bad input" }) });

    const outcome = await provider(http).createGeneration(input);

    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
  });

  it("keeps a 429 UNKNOWN even though its error is retryable", async () => {
    const { http } = respondWith({ status: 429, body: "slow down" });

    const outcome = await provider(http).createGeneration(input);

    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    if (outcome.kind === "ACCEPTED") throw new Error("expected a failure outcome");
    expect(outcome.error.retryable).toBe(true);
  });

  it.each([
    ["unparseable JSON", "<html>gateway</html>"],
    ["an empty body", ""],
    ["a 2xx with no request_id", JSON.stringify({ status_url: "https://queue.fal.test/s/1" })],
    ["a blank request_id", JSON.stringify({ request_id: "   " })],
    ["a non-string request_id", JSON.stringify({ request_id: 12345 })],
  ])("treats %s as UNKNOWN, never as rejection", async (_label, body) => {
    const { http, calls } = respondWith({ status: 200, body });

    const outcome = await provider(http).createGeneration(input);

    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    expect(calls).toHaveLength(1);
  });

  it("treats a transport failure as UNKNOWN and does not retry", async () => {
    const request = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    const outcome = await provider({ request }).createGeneration(input);

    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("treats a timeout as UNKNOWN and does not retry", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const request = vi.fn().mockRejectedValue(abort);

    const outcome = await provider({ request }).createGeneration(input);

    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    if (outcome.kind === "ACCEPTED") throw new Error("expected a failure outcome");
    expect(outcome.error.kind).toBe("TIMEOUT");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not follow a redirect or re-POST to its target", async () => {
    const { http, calls } = respondWith({ status: 307, body: "" });

    const outcome = await provider(http).createGeneration(input);

    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.redirect).toBe("manual");
  });
});

describe("fal H3 Max submission — local refusals happen before any POST", () => {
  it("refuses an unsupported model id definitively, with zero HTTP calls", async () => {
    const request = vi.fn();

    const outcome = await provider({ request }).createGeneration({
      ...input,
      modelId: "minimax/h3/image-to-video",
    });

    expect(outcome.kind).toBe("DEFINITIVELY_REJECTED");
    // The whole basis for calling it definitive: nothing was sent.
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses a missing credential definitively, with zero HTTP calls", async () => {
    const request = vi.fn();
    const adapter = new FalH3MaxSubmissionProvider(
      { credential: "   ", baseUrl: BASE_URL },
      { http: { request }, now },
    );

    const outcome = await adapter.createGeneration(input);

    expect(outcome.kind).toBe("DEFINITIVELY_REJECTED");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("fal H3 Max submission — nothing sensitive escapes", () => {
  it.each([400, 422, 500])("keeps provider bytes out of a %i outcome", async (status) => {
    const { http } = respondWith({
      status,
      body: JSON.stringify({
        detail: "image_url=https://storage.internal/o/org/img?token=SIGNED",
        credential: CREDENTIAL,
        prompt: input.prompt,
      }),
    });

    const outcome = await provider(http).createGeneration(input);
    const serialized = JSON.stringify(outcome);

    expect(serialized).not.toContain(CREDENTIAL);
    expect(serialized).not.toContain("SIGNED");
    expect(serialized).not.toContain("storage.internal");
    expect(serialized).not.toContain(input.prompt);
    expect(serialized).not.toContain("queue.fal.test");
  });

  it("does not put an arbitrary thrown message into the error", async () => {
    const hostile = new Error("Key fal-secret-credential leaked via https://storage/x?token=SIGNED");
    const request = vi.fn().mockRejectedValue(hostile);

    const outcome = await provider({ request }).createGeneration(input);
    const serialized = JSON.stringify(outcome);

    expect(serialized).not.toContain(CREDENTIAL);
    expect(serialized).not.toContain("SIGNED");
    expect(serialized).not.toContain("leaked");
  });

  it("never carries a cause or raw body on the error object", async () => {
    const { http } = respondWith({ status: 500, body: "raw provider bytes" });

    const outcome = await provider(http).createGeneration(input);

    if (outcome.kind === "ACCEPTED") throw new Error("expected a failure outcome");
    expect(Object.keys(outcome.error).sort()).toEqual(
      ["code", "kind", "messageSanitized", "providerStatus", "retryable"].sort(),
    );
    expect(JSON.stringify(outcome.error)).not.toContain("raw provider bytes");
  });

  /**
   * The local refusal path, which the cases above never reach.
   *
   * Every other secrecy test here runs *after* a POST, so all of them would pass
   * while a local refusal quoted the credential straight back — and a local
   * refusal is the one message most likely to be written as a helpful
   * diagnostic, because the fault is on this side. §16 is unconditional: the
   * credential is never returned in any error.
   */
  it("keeps the credential out of a local refusal, where it is in scope", async () => {
    const request = vi.fn();

    const outcome = await provider({ request }).createGeneration({
      ...input,
      modelId: "minimax/h3/image-to-video",
    });

    expect(outcome.kind).toBe("DEFINITIVELY_REJECTED");
    expect(request).not.toHaveBeenCalled();
    // The adapter holds the real credential on this path, so its absence here
    // is evidence rather than an accident of the fixture.
    expect(JSON.stringify(outcome)).not.toContain(CREDENTIAL);
  });
});

describe("fal trusts a thrown value by provenance, never by shape", () => {
  /**
   * The nominal boundary, tested where fal actually applies it.
   *
   * `normalizeError` recognises this application's own errors with
   * `instanceof ProviderErrorException` (ADR-0031 §4). The alternative — a shape
   * check on `kind` and `retryable` — looks equivalent and is not: the value
   * below has exactly the right field types, so a structural test accepts it,
   * and the thrower has then chosen both public diagnostic strings outright.
   *
   * WaveSpeed has this regression already. fal did not, and until it did, that
   * boundary could be swapped for a duck test with nothing failing.
   */
  it("refuses a structurally valid look-alike thrown by the transport", async () => {
    const lookAlike = {
      kind: "AUTH",
      retryable: false,
      code: CREDENTIAL,
      messageSanitized: "https://storage.internal/o/org/img?token=SIGNED",
      providerStatus: 401,
    };
    const request = vi.fn().mockRejectedValue(lookAlike);

    const outcome = await provider({ request }).createGeneration(input);

    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    if (outcome.kind === "ACCEPTED") throw new Error("expected a failure outcome");
    expect(outcome.error.kind).toBe("NETWORK");
    expect(outcome.error.code).toBe("FAL_SUBMISSION_NETWORK_ERROR");
    expect(outcome.error.messageSanitized).toBe("Network error contacting fal");
    expect(outcome.error.providerStatus).toBeUndefined();

    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(CREDENTIAL);
    expect(serialized).not.toContain("SIGNED");
  });

  it("preserves an error this application constructed, via instanceof", () => {
    const original = falHttpError(503);
    const adapter = provider({ request: vi.fn() });

    expect(adapter.normalizeError(new ProviderErrorException(original))).toEqual(original);
  });
});
