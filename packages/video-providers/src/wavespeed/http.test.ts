import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WAVESPEED_OPEN_VIDEO_MODEL_ID } from "@app/shared";
import { FetchHttpClient } from "./http";
import { WaveSpeedVideoProvider } from "./wavespeed-provider";
import type { WaveSpeedConfig } from "./config";
import type { ProviderGenerationInput } from "../types";

/**
 * These tests drive the **real** `FetchHttpClient` against a mocked global
 * `fetch`. No network I/O occurs, and no WaveSpeedAI call is made — but unlike
 * the injected-client tests, this is the seam that actually decides what the
 * runtime does with a redirect and a timeout.
 */

type FetchInit = { redirect?: string; signal?: AbortSignal; method?: string };

let fetchMock: ReturnType<typeof vi.fn>;
const originalFetch = globalThis.fetch;

/** Resolves only when the test says so, so the abort timer can be observed. */
function deferredResponse() {
  let release: (body: string) => void = () => {};
  const gate = new Promise<string>((resolve) => {
    release = resolve;
  });
  const respond = async () => {
    const body = await gate;
    return { status: 200, text: () => Promise.resolve(body) } as unknown as Response;
  };
  return { respond, release: () => release("{}") };
}

function okResponse(body = "{}") {
  return { status: 200, text: () => Promise.resolve(body) } as unknown as Response;
}

function lastInit(): FetchInit {
  return fetchMock.mock.calls.at(-1)?.[1] as FetchInit;
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

describe("FetchHttpClient timeouts", () => {
  it("uses the request-specific override instead of the 30 second default", async () => {
    const deferred = deferredResponse();
    fetchMock.mockImplementation(deferred.respond);
    const client = new FetchHttpClient();
    const inFlight = client.request({
      method: "POST",
      url: "https://api.wavespeed.ai/api/v3/m",
      headers: {},
      timeoutMs: 60_000,
    });

    // The default would have aborted long before this point.
    await vi.advanceTimersByTimeAsync(59_999);
    expect(lastInit().signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(lastInit().signal?.aborted).toBe(true);

    deferred.release();
    await inFlight;
  });

  it("keeps the configured default when no override is given", async () => {
    const deferred = deferredResponse();
    fetchMock.mockImplementation(deferred.respond);
    const client = new FetchHttpClient();
    const inFlight = client.request({ method: "GET", url: "https://x/y", headers: {} });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(lastInit().signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(lastInit().signal?.aborted).toBe(true);

    deferred.release();
    await inFlight;
  });

  it("honours a non-default constructor timeout", async () => {
    const deferred = deferredResponse();
    fetchMock.mockImplementation(deferred.respond);
    const inFlight = new FetchHttpClient(5_000).request({
      method: "GET",
      url: "https://x/y",
      headers: {},
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(lastInit().signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(lastInit().signal?.aborted).toBe(true);

    deferred.release();
    await inFlight;
  });

  /**
   * Timer cleanup, proven by behaviour rather than by spying on `clearTimeout`:
   * if the timer survived, advancing past the deadline would abort a signal
   * belonging to a finished request, and in a long-lived worker that leak is
   * what eventually aborts an unrelated call.
   */
  it("clears the abort timer after a successful response", async () => {
    fetchMock.mockResolvedValue(okResponse());
    const client = new FetchHttpClient();
    const res = await client.request({ method: "GET", url: "https://x/y", headers: {} });
    expect(res.status).toBe(200);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(lastInit().signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the abort timer after a rejection", async () => {
    fetchMock.mockRejectedValue(new Error("econn"));
    const client = new FetchHttpClient();
    await expect(
      client.request({ method: "POST", url: "https://x/y", headers: {}, timeoutMs: 60_000 }),
    ).rejects.toThrow("econn");

    await vi.advanceTimersByTimeAsync(120_000);
    expect(lastInit().signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("FetchHttpClient redirects", () => {
  it("forwards an explicit manual redirect policy", async () => {
    fetchMock.mockResolvedValue(okResponse());
    await new FetchHttpClient().request({
      method: "POST",
      url: "https://x/y",
      headers: {},
      redirect: "manual",
    });
    expect(lastInit().redirect).toBe("manual");
  });

  /**
   * No override means the key is not passed at all, so the platform default —
   * `follow` — is what applies. Asserting the *absence* rather than the string
   * "follow" is the honest form: the client does not set it.
   */
  it("passes no redirect option when a request does not ask for one", async () => {
    fetchMock.mockResolvedValue(okResponse());
    await new FetchHttpClient().request({ method: "GET", url: "https://x/y", headers: {} });
    expect(lastInit().redirect).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(lastInit(), "redirect")).toBe(false);
  });

  it("forwards an explicit follow policy unchanged", async () => {
    fetchMock.mockResolvedValue(okResponse());
    await new FetchHttpClient().request({
      method: "GET",
      url: "https://x/y",
      headers: {},
      redirect: "follow",
    });
    expect(lastInit().redirect).toBe("follow");
  });
});

describe("the paid submission at the real fetch seam", () => {
  const config: WaveSpeedConfig = {
    apiKey: "sk-live-key",
    baseUrl: "https://api.wavespeed.ai/api/v3",
    poll: { initialMs: 1000, maxMs: 10000, timeoutMs: 60000 },
    pricing: { currency: "USD", costPerSecondMinor: 10 },
  };
  const input: ProviderGenerationInput = {
    modelId: WAVESPEED_OPEN_VIDEO_MODEL_ID,
    sourceImageUrl: "https://storage.internal/o/org/img?token=x",
    prompt: "bright natural interior",
    durationSeconds: 5,
    aspectRatio: "16:9",
    resolution: "1080p",
    requestHash: "hash1",
  };

  it("issues exactly one fetch, with manual redirects and a 60 second deadline", async () => {
    const deferred = deferredResponse();
    fetchMock.mockImplementation(deferred.respond);
    const provider = new WaveSpeedVideoProvider(config, { http: new FetchHttpClient() });
    const inFlight = provider.createGeneration(input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastInit().method).toBe("POST");
    expect(lastInit().redirect).toBe("manual");

    // The create-only deadline, not the client's 30 second default.
    await vi.advanceTimersByTimeAsync(59_999);
    expect(lastInit().signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(lastInit().signal?.aborted).toBe(true);

    deferred.release();
    await inFlight;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not re-issue the POST when the runtime reports a redirect", async () => {
    fetchMock.mockResolvedValue({
      status: 307,
      text: () => Promise.resolve(""),
    } as unknown as Response);
    const provider = new WaveSpeedVideoProvider(config, { http: new FetchHttpClient() });
    const outcome = await provider.createGeneration(input);

    expect(outcome.kind).toBe("SUBMISSION_UNKNOWN");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
