import { describe, expect, it } from "vitest";
import { WAVESPEED_OPEN_VIDEO_MODEL_ID } from "@app/shared";
import { WaveSpeedVideoProvider } from "./wavespeed-provider";
import { FakeVideoProvider } from "../fake/fake-provider";
import { isDefinitiveRejectionStatus } from "./mapping";
import type { WaveSpeedConfig } from "./config";
import type { HttpClient, HttpRequest, HttpResponse } from "./http";
import type {
  ProviderGenerationInput,
  ProviderSubmissionOutcome,
} from "../types";

const API_KEY = "sk-live-SUBMITKEYSENTINEL";
const SIGNED_URL = "https://storage.internal/o/org-9/normalized.jpg?X-Signature=SUBMITURLSENTINEL";
const PROMPT = "SUBMITPROMPTSENTINEL sunlit living room";
const HOSTILE_BODY = JSON.stringify({
  error: "SUBMITBODYSENTINEL: rejected parameter",
  echoed: { image: SIGNED_URL, prompt: PROMPT, token: API_KEY },
});
const SENTINELS = [API_KEY, SIGNED_URL, PROMPT, "SUBMITBODYSENTINEL"] as const;

const config: WaveSpeedConfig = {
  apiKey: API_KEY,
  baseUrl: "https://api.wavespeed.ai/api/v3",
  poll: { initialMs: 1000, maxMs: 10000, timeoutMs: 60000 },
  pricing: { currency: "USD", costPerSecondMinor: 10 },
};

const input: ProviderGenerationInput = {
  modelId: WAVESPEED_OPEN_VIDEO_MODEL_ID,
  sourceImageUrl: SIGNED_URL,
  prompt: PROMPT,
  durationSeconds: 5,
  aspectRatio: "16:9",
  resolution: "1080p",
  requestHash: "hash1",
};

const now = () => new Date("2026-01-01T00:00:00.000Z");

/** A client that counts attempts, so "exactly one POST" is asserted, not assumed. */
function countingClient(behaviour: () => Promise<HttpResponse>): {
  http: HttpClient;
  calls: HttpRequest[];
} {
  const calls: HttpRequest[] = [];
  return {
    calls,
    http: {
      request(req: HttpRequest): Promise<HttpResponse> {
        calls.push(req);
        return behaviour();
      },
    },
  };
}

function responding(res: HttpResponse) {
  return countingClient(() => Promise.resolve(res));
}

function rejecting(value: unknown) {
  return countingClient(() => Promise.reject(value));
}

async function submit(client: { http: HttpClient }): Promise<ProviderSubmissionOutcome> {
  return new WaveSpeedVideoProvider(config, { http: client.http, now }).createGeneration(input);
}

function expectNoSentinels(outcome: ProviderSubmissionOutcome): void {
  const text = JSON.stringify(outcome);
  for (const sentinel of SENTINELS) {
    expect(`${sentinel.slice(0, 24)}:${text.includes(sentinel)}`).toBe(
      `${sentinel.slice(0, 24)}:false`,
    );
  }
}

describe("ACCEPTED requires a usable prediction id", () => {
  it.each([
    ["data.id, the documented location", { data: { id: "pred_9" } }, "pred_9"],
    ["a top-level id, the legacy compatibility path", { id: "pred_legacy" }, "pred_legacy"],
    ["data.id winning over a top-level id", { data: { id: "pred_9" }, id: "other" }, "pred_9"],
  ])("accepts %s", async (_label, body, expectedId) => {
    const client = responding({ status: 200, body: JSON.stringify(body) });
    const outcome = await submit(client);

    expect(outcome.kind).toBe("ACCEPTED");
    if (outcome.kind !== "ACCEPTED") throw new Error("unreachable");
    expect(outcome.ref.predictionId).toBe(expectedId);
    expect(outcome.ref.modelId).toBe(WAVESPEED_OPEN_VIDEO_MODEL_ID);
    expect(outcome.ref.provider).toBe("wavespeed");
    expect(outcome.ref.submittedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(client.calls).toHaveLength(1);
  });

  it.each([201, 202])("accepts any 2xx carrying a usable id (%i)", async (status) => {
    const client = responding({ status, body: JSON.stringify({ data: { id: "pred_2xx" } }) });
    const outcome = await submit(client);
    expect(outcome.kind).toBe("ACCEPTED");
    expect(client.calls).toHaveLength(1);
  });

  /**
   * Acceptance must not depend on optional response metadata. The prediction id
   * is the token; a missing `status`, absent `urls`, or an unrecognised `code`
   * says nothing about whether the provider took the job.
   */
  it("accepts despite missing or malformed unrelated fields", async () => {
    const client = responding({
      status: 200,
      body: JSON.stringify({ data: { id: "pred_9", status: 12345, urls: "nonsense" }, code: 999 }),
    });
    const outcome = await submit(client);
    expect(outcome.kind).toBe("ACCEPTED");
  });
});

describe("DEFINITIVELY_REJECTED is exactly 400, 401 and 403", () => {
  it.each([
    [400, "INVALID_INPUT", "WAVESPEED_INVALID_INPUT"],
    [401, "AUTH", "WAVESPEED_AUTH_FAILED"],
    [403, "AUTH", "WAVESPEED_AUTH_FAILED"],
  ])("rejects %i definitively with a safe diagnostic", async (status, kind, code) => {
    const client = responding({ status, body: HOSTILE_BODY });
    const outcome = await submit(client);

    expect(outcome.kind).toBe("DEFINITIVELY_REJECTED");
    if (outcome.kind === "ACCEPTED") throw new Error("unreachable");
    expect(outcome.error.kind).toBe(kind);
    expect(outcome.error.code).toBe(code);
    expect(outcome.error.providerStatus).toBe(status);
    expectNoSentinels(outcome);
    expect(client.calls).toHaveLength(1);
  });
});

describe("everything else is SUBMISSION_UNKNOWN", () => {
  const AMBIGUOUS_STATUSES = [
    301, 302, 307, 308, 402, 404, 405, 406, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417,
    418, 421, 422, 423, 424, 425, 426, 428, 429, 431, 451, 500, 502, 503, 504, 599,
  ];

  it.each(AMBIGUOUS_STATUSES)("status %i is ambiguous, not a rejection", async (status) => {
    const client = responding({ status, body: HOSTILE_BODY });
    const outcome = await submit(client);

    expect(`${status}:${outcome.kind}`).toBe(`${status}:SUBMISSION_UNKNOWN`);
    expectNoSentinels(outcome);
    expect(client.calls).toHaveLength(1);
  });

  /**
   * The two that would be most tempting to call definitive, called out
   * separately because their *diagnostics* still say `retryable: true`. That is
   * the separation ADR-0032 exists for: retryability describes the request,
   * certainty describes the charge, and a caller must read the discriminant.
   */
  it.each([429, 500])("keeps %i retryable as a diagnostic while ambiguous as a submission", async (status) => {
    const outcome = await submit(responding({ status, body: "{}" }));
    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    if (outcome.kind === "ACCEPTED") throw new Error("unreachable");
    expect(outcome.error.retryable).toBe(true);
  });

  it.each([
    ["a network rejection", new Error("ECONNREFUSED 10.0.0.1:443")],
    ["a connection reset", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
    ["a non-Error throw", { body: HOSTILE_BODY }],
  ])("treats %s as ambiguous", async (_label, thrown) => {
    const client = rejecting(thrown);
    const outcome = await submit(client);

    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    if (outcome.kind === "ACCEPTED") throw new Error("unreachable");
    expect(outcome.error.kind).toBe("NETWORK");
    expectNoSentinels(outcome);
    expect(client.calls).toHaveLength(1);
  });

  it("treats an abort/timeout as ambiguous, keeping the TIMEOUT diagnostic", async () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    const client = rejecting(abort);
    const outcome = await submit(client);

    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    if (outcome.kind === "ACCEPTED") throw new Error("unreachable");
    expect(outcome.error.kind).toBe("TIMEOUT");
    expect(outcome.error.code).toBe("WAVESPEED_TIMEOUT");
    expect(client.calls).toHaveLength(1);
  });

  /**
   * A 2xx alone proves nothing. Each of these is a response the provider may
   * well have honoured — we simply cannot name the prediction, which is exactly
   * what "unknown" means.
   */
  it.each([
    ["unparseable JSON", "{not json"],
    ["an empty body", ""],
    ["an empty object", "{}"],
    ["no data key", JSON.stringify({ code: 200, message: "success" })],
    ["a missing id", JSON.stringify({ data: { status: "created" } })],
    ["an empty-string id", JSON.stringify({ data: { id: "" } })],
    ["a whitespace-only id", JSON.stringify({ data: { id: "   " } })],
    ["a leading-whitespace id", JSON.stringify({ data: { id: " pred_9" } })],
    ["a trailing-whitespace id", JSON.stringify({ data: { id: "pred_9 " } })],
    ["a non-string id", JSON.stringify({ data: { id: 12345 } })],
    ["a null id", JSON.stringify({ data: { id: null } })],
    ["a truncated response", '{"data":{"id":"pred_'],
  ])("treats a 2xx with %s as ambiguous", async (_label, body) => {
    const client = responding({ status: 200, body });
    const outcome = await submit(client);

    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    if (outcome.kind === "ACCEPTED") throw new Error("unreachable");
    expect(outcome.error.code).toBe("WAVESPEED_MISSING_PREDICTION_ID");
    expect(outcome.error.providerStatus).toBe(200);
    expect(client.calls).toHaveLength(1);
  });

  it("keeps a hostile 2xx body out of the ambiguous diagnostic", async () => {
    const outcome = await submit(responding({ status: 200, body: HOSTILE_BODY }));
    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    expectNoSentinels(outcome);
  });
});

/**
 * The regression barrier. Representative cases prove the wiring; this proves
 * the *boundary*, so nobody can quietly add a fourth status later — 422 and 429
 * being the two that will feel reasonable at the time.
 */
describe("the definitive allowlist over every HTTP status 100–599", () => {
  it("admits exactly 400, 401 and 403", () => {
    const definitive: number[] = [];
    for (let status = 100; status <= 599; status += 1) {
      if (isDefinitiveRejectionStatus(status)) definitive.push(status);
    }
    expect(definitive).toEqual([400, 401, 403]);
  });

  it("names no fourth status, checked end to end on the tempting ones", async () => {
    for (const status of [402, 404, 409, 422, 429, 500, 503]) {
      const outcome = await submit(responding({ status, body: "{}" }));
      expect(`${status}:${outcome.kind}`).toBe(`${status}:SUBMISSION_UNKNOWN`);
    }
  });
});

describe("exactly one POST, on every path", () => {
  const PATHS: readonly { name: string; client: () => { http: HttpClient; calls: HttpRequest[] } }[] =
    [
      { name: "accepted", client: () => responding({ status: 200, body: '{"data":{"id":"p"}}' }) },
      { name: "400", client: () => responding({ status: 400, body: HOSTILE_BODY }) },
      { name: "401", client: () => responding({ status: 401, body: HOSTILE_BODY }) },
      { name: "403", client: () => responding({ status: 403, body: HOSTILE_BODY }) },
      { name: "422", client: () => responding({ status: 422, body: HOSTILE_BODY }) },
      { name: "429", client: () => responding({ status: 429, body: HOSTILE_BODY }) },
      { name: "500", client: () => responding({ status: 500, body: HOSTILE_BODY }) },
      { name: "307", client: () => responding({ status: 307, body: "" }) },
      { name: "308", client: () => responding({ status: 308, body: "" }) },
      { name: "malformed 2xx", client: () => responding({ status: 200, body: "{}" }) },
      { name: "network rejection", client: () => rejecting(new Error("econn")) },
      {
        name: "timeout",
        client: () => {
          const abort = new Error("aborted");
          abort.name = "AbortError";
          return rejecting(abort);
        },
      },
    ];

  it.each(PATHS)("issues one request for $name", async ({ client }) => {
    const c = client();
    await submit(c);
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]?.method).toBe("POST");
  });
});

describe("the submission request carries the create-only transport policy", () => {
  it("asks for manual redirects and a 60 second timeout", async () => {
    const client = responding({ status: 200, body: '{"data":{"id":"p"}}' });
    await submit(client);
    expect(client.calls[0]?.redirect).toBe("manual");
    expect(client.calls[0]?.timeoutMs).toBe(60_000);
  });

  /**
   * Scope preservation. Following a redirect on an idempotent read is harmless
   * and a shorter budget is right there; the create-only policy must not leak
   * into either, or the milestone has quietly changed unrelated transport.
   */
  it("leaves getStatus and cancelGeneration on ordinary transport", async () => {
    const client = responding({ status: 200, body: '{"data":{"status":"completed"}}' });
    const provider = new WaveSpeedVideoProvider(config, { http: client.http, now });
    const ref = {
      provider: "wavespeed" as const,
      modelId: WAVESPEED_OPEN_VIDEO_MODEL_ID,
      predictionId: "pred_9",
      submittedAt: now().toISOString(),
    };
    await provider.getStatus(ref);
    await provider.cancelGeneration(ref);

    for (const call of client.calls) {
      expect(`${call.method}:${String(call.redirect)}`).toBe(`${call.method}:undefined`);
      expect(`${call.method}:${String(call.timeoutMs)}`).toBe(`${call.method}:undefined`);
    }
  });
});

describe("pre-invocation failures still throw, and never reach the network", () => {
  /**
   * The boundary in the other direction. A local failure before the call is
   * provably not a charge, so it may throw — and must not be dressed up as an
   * ambiguous submission, which would strand a generation for a human to
   * reconcile over a bug that never contacted anyone.
   */
  it("does not call the client when request construction fails", async () => {
    const client = responding({ status: 200, body: '{"data":{"id":"p"}}' });
    const provider = new WaveSpeedVideoProvider(config, { http: client.http, now });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(
      provider.createGeneration({ ...input, seed: circular as unknown as number }),
    ).rejects.toThrow();
    expect(client.calls).toHaveLength(0);
  });
});

describe("the fake provider implements the same three outcomes", () => {
  it("accepts by default", async () => {
    const outcome = await new FakeVideoProvider({ now }).createGeneration(input);
    expect(outcome.kind).toBe("ACCEPTED");
  });

  it.each(["DEFINITIVELY_REJECTED", "SUBMISSION_UNKNOWN"] as const)(
    "can be configured to produce %s with a fixed safe diagnostic",
    async (kind) => {
        const outcome = await new FakeVideoProvider({
        now,
        submissionOutcome: kind,
      }).createGeneration(input);

      expect(outcome.kind).toBe(kind);
      if (outcome.kind === "ACCEPTED") throw new Error("unreachable");
      expect(outcome.error.code).toBe(
        kind === "DEFINITIVELY_REJECTED" ? "FAKE_SUBMISSION_REJECTED" : "FAKE_SUBMISSION_UNKNOWN",
      );
      expectNoSentinels(outcome);
      expect(Object.prototype.hasOwnProperty.call(outcome.error, "cause")).toBe(false);
    },
  );

  /**
   * The configuration selects a discriminant and nothing else. Compile-time,
   * because the risk is a future option widening it into a message bag.
   */
  it("accepts no caller-supplied diagnostic content (compile-time)", () => {
    type Options = NonNullable<ConstructorParameters<typeof FakeVideoProvider>[0]>;
    type Forbidden = Extract<keyof Options, "error" | "code" | "message" | "cause" | "body">;
    const none: Forbidden[] = [];
    expect(none).toEqual([]);
  });
});
