export interface HttpRequest {
  readonly method: "GET" | "POST" | "DELETE";
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
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
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        ...(req.body === undefined ? {} : { body: req.body }),
        signal: controller.signal,
      });
      return { status: res.status, body: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  }
}
