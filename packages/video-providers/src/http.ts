/**
 * How a request is allowed to handle a redirect.
 *
 * `manual` is the setting the paid create POST uses, and it is not a
 * preference. A transparently-followed 3xx re-sends the request body to a new
 * URL — a second POST this application never authorized, to a host it never
 * chose, for an operation that may bill on arrival. `follow` remains available
 * for reads, where re-issuing a GET costs nothing (ADR-0035).
 */
export type HttpRedirectMode = "manual" | "follow";

export interface HttpRequest {
  readonly method: "GET" | "POST" | "DELETE";
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  /**
   * Per-request deadline. Absent means the client's own default.
   *
   * Submission uses a request-specific value rather than the client-wide one,
   * because a paid POST and a status poll have different tolerances and the
   * ambiguous window after a submission timeout is the expensive one.
   */
  readonly timeoutMs?: number;
  /** Absent means the client's default, which is `follow`. */
  readonly redirect?: HttpRedirectMode;
}

/**
 * What a transport is allowed to hand back.
 *
 * Deliberately just a status and a body string. No `Response`, no headers bag,
 * no request echo: every one of those is a channel through which raw provider
 * bytes, a signed source URL or an `Authorization` header could reach a
 * diagnostic, and ADR-0031 makes every field of a `ProviderError`
 * application-owned. Adapters read the status, and read the body only far
 * enough to extract a documented identifier.
 */
export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * Minimal HTTP seam, injected into every provider adapter so that unit tests
 * never touch the network.
 *
 * It lives here rather than under `wavespeed/` because more than one adapter
 * now needs it, and a shared seam is what makes "exactly one outbound POST" a
 * property that can be asserted the same way for all of them. It is not a
 * general-purpose HTTP framework and should not grow into one: it carries what
 * submission and polling actually require and nothing more.
 */
export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

/**
 * Default client backed by the global `fetch`.
 *
 * **Exactly one `fetch` per `request` call.** No retry, no backoff, no
 * resubmission — not even on a timeout or a connection reset. That is the whole
 * point of this class: the adapters above it promise at most one outbound paid
 * POST, and a transport that quietly retried would break that promise
 * invisibly, at the layer nobody re-reads.
 *
 * Only constructed by the factory for a configured real provider; the default
 * (fake) configuration never instantiates it.
 */
export class FetchHttpClient implements HttpClient {
  constructor(private readonly defaultTimeoutMs = 30_000) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? this.defaultTimeoutMs);
    try {
      // One fetch. If this line ever appears inside a loop or a `catch`, the
      // exactly-one-submission guarantee above it is gone.
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
