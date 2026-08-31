export interface HttpRequest {
  readonly method: "GET" | "POST" | "DELETE";
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  /**
   * Per-request redirect policy. Omitted means the client's existing behaviour,
   * which is the platform default (`follow`).
   *
   * Only the paid create submission sets `manual`, and only to stop the runtime
   * re-sending it. `fetch` follows redirects itself: a 307 or 308 replays the
   * **method and body** against the `Location` host, which is a second POST of
   * the same paid request that no application code asked for, while a 301, 302
   * or 303 silently downgrades the submission to a GET. Neither is visible from
   * the call site. Status reads and cancellation are idempotent and free, so
   * they keep following (ADR-0032).
   */
  readonly redirect?: "follow" | "manual";
  /**
   * Per-request timeout override in milliseconds. Omitted means the client's
   * configured default.
   *
   * The submission timeout is an *ambiguity* budget, not a latency budget:
   * aborting mid-flight does not cancel whatever the provider is doing, it only
   * destroys our evidence of it, and every abort becomes a
   * `SUBMISSION_UNKNOWN` a human has to resolve. So create waits **longer**
   * than an ordinary request, not shorter.
   */
  readonly timeoutMs?: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * Minimal HTTP seam. Injected into WaveSpeedVideoProvider so that unit tests
 * never touch the network — the roadmap forbids calling the real WaveSpeedAI
 * API in Phase 0.
 */
export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

/**
 * Default client backed by the global `fetch`. Only constructed by the factory
 * when VIDEO_PROVIDER=wavespeed; it is never instantiated in Phase 0's default
 * (fake) configuration.
 */
export class FetchHttpClient implements HttpClient {
  constructor(private readonly timeoutMs = 30_000) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? this.timeoutMs);
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        ...(req.body === undefined ? {} : { body: req.body }),
        ...(req.redirect === undefined ? {} : { redirect: req.redirect }),
        signal: controller.signal,
      });
      return { status: res.status, body: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  }
}
