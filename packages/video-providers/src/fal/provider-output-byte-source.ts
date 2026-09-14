import {
  type ProviderOutputByteSource,
  type ProviderOutputByteSourceOpenResult,
  type ProviderOutputByteStream,
  type TransientProviderOutputLocator,
} from "@app/domain";
import { withTransientProviderOutputLocatorForByteSource } from "@app/domain/provider-output-byte-source-access";
import { isAuthorizedFalOutputUrl } from "./output-url-policy";

/**
 * The fal streaming output byte source — the data-plane counterpart of the
 * queue status source, and **dormant**.
 *
 * This is the first *concrete* production implementation of
 * `ProviderOutputByteSource`, and it really would GET an already-issued fal
 * output URL and stream the bytes back. What keeps it dormant is unchanged from
 * every other piece of this pipeline: nothing in production constructs it, no
 * production composition joins it to the streaming transfer core and a durable
 * sink, and no `FAL_KEY` or scheduler exists to drive it. It is tested
 * production code no configuration can reach.
 *
 * ## Why not the existing string-body `HttpClient`
 *
 * The control-plane `HttpClient` reads a whole response into a `string`: right
 * for a status poll, catastrophic for a video. This source never materializes
 * the body. It pulls one chunk at a time through a narrow fetch seam and hands
 * the transfer core a pull-based `AsyncIterable<Uint8Array>`, so the 512 MiB
 * ceiling and the actual-byte count stay the core's job and no full response is
 * ever held in memory.
 *
 * ## The output URL is the only authorization
 *
 * A signed fal media URL is a bearer credential in its query string. So the GET
 * carries **no `Authorization` header, no `FAL_KEY`, no cookies** — adding one
 * would send our submission credential to a media host that does not need it.
 * The URL itself is validated against {@link isAuthorizedFalOutputUrl}
 * immediately before *every* request, including the first and every redirect
 * target: a locator constructed earlier is never assumed to be safe network
 * authority now.
 *
 * ## Redirects are manual and re-validated
 *
 * At most three redirects are followed, each `Location` resolved against the
 * current URL and re-checked against the same fal output policy *before* the
 * next request is sent. A redirect to any other host is refused before a byte
 * leaves. A missing, malformed, unauthorized or over-budget redirect is a
 * transient acquisition problem, not a provider failure.
 *
 * ## Every failure here is `RETRYABLE_FAILURE`
 *
 * A non-200 final response, a network rejection, a body that cannot be read —
 * each returns `{ kind: "RETRYABLE_FAILURE" }`. This source has no evidence that
 * a fetch failure is permanent, and provider execution success is a separate,
 * already-recorded fact. No URL, query string or network error text ever
 * appears in the returned value.
 */

/** At most three redirects, so at most four requests for one open. */
const MAX_FAL_OUTPUT_REDIRECTS = 3;

/** The redirect statuses this source will consider following. */
const FAL_OUTPUT_REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

const RETRYABLE_FAILURE: ProviderOutputByteSourceOpenResult = { kind: "RETRYABLE_FAILURE" };

/**
 * One lazily-pulled response body.
 *
 * `read` returns the next chunk or `null` at end of stream, one pull per chunk,
 * so the consumer's iteration is what advances the transfer — backpressure is a
 * property of asking, never a queue this seam fills ahead. `cancel` releases the
 * underlying network response and is best-effort and idempotent-friendly.
 */
export interface FalOutputResponseBody {
  read(): Promise<Uint8Array | null>;
  cancel(): Promise<void>;
}

/** One non-following HTTP response, reduced to exactly what this source reads. */
export interface FalOutputFetchResponse {
  readonly status: number;
  /** The `Location` header, consulted only for redirect routing. */
  readonly location: string | null;
  /** The `Content-Length` header verbatim, a preflight hint only. */
  readonly contentLength: string | null;
  /** A pull-based body, or `null` when the response has none. */
  readonly body: FalOutputResponseBody | null;
}

export interface FalOutputFetchRequest {
  readonly url: string;
}

/**
 * The data-plane fetch seam.
 *
 * Injected so unit tests drive the whole redirect and streaming machinery
 * without a network. It performs one GET with manual redirect handling and no
 * credentials; it must not follow redirects itself.
 */
export interface FalOutputFetch {
  (request: FalOutputFetchRequest): Promise<FalOutputFetchResponse>;
}

export interface FalProviderOutputByteSourceDeps {
  readonly fetch: FalOutputFetch;
}

/**
 * Read `Content-Length` as a preflight hint, or refuse it.
 *
 * A positive safe integer, or `null` for anything else — absent, zero,
 * negative, fractional, unsafe, non-numeric, or an ambiguous duplicated header
 * (which arrives joined by a comma and fails the digit test). The declared size
 * is never authoritative: the transfer core counts the bytes that actually
 * arrive.
 */
export function parseFalOutputContentLength(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

/** Resolve a redirect target against the current URL, or `null` if unusable. */
function resolveRedirectTarget(location: string | null, currentUrl: string): string | null {
  if (location === null || location.trim().length === 0) return null;
  try {
    return new URL(location, currentUrl).href;
  } catch {
    return null;
  }
}

/** Best-effort release of a response body, swallowing whatever cancel throws. */
async function releaseQuietly(body: FalOutputResponseBody | null): Promise<void> {
  if (body === null) return;
  try {
    await body.cancel();
  } catch {
    // Best-effort. There is nothing to report and nothing in scope to leak.
  }
}

/**
 * Wrap a pulled body as a bounded, backpressured stream with an idempotent
 * close.
 *
 * The generator pulls exactly one chunk each time the consumer asks for the
 * next, so nothing is read ahead and the whole body is never held. `close`
 * cancels the underlying response and is safe to call more than once — the
 * transfer core calls it once, and the generator's own `finally` calls it on
 * early termination or exhaustion.
 */
function buildFalOutputStream(
  body: FalOutputResponseBody,
  declaredSizeBytes: number | null,
): ProviderOutputByteStream {
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await releaseQuietly(body);
  };

  async function* iterate(): AsyncGenerator<Uint8Array, void, undefined> {
    try {
      for (;;) {
        const chunk = await body.read();
        if (chunk === null) return;
        yield chunk;
      }
    } finally {
      // Early close (the consumer stopped iterating) or exhaustion both release
      // the underlying response exactly once through the idempotent close.
      await close();
    }
  }

  return {
    body: { [Symbol.asyncIterator]: (): AsyncIterator<Uint8Array> => iterate() },
    declaredSizeBytes,
    close,
  };
}

export class FalProviderOutputByteSource implements ProviderOutputByteSource {
  readonly #fetch: FalOutputFetch;

  constructor(deps: FalProviderOutputByteSourceDeps) {
    this.#fetch = deps.fetch;
  }

  /**
   * Open one provider output for streaming, or report a transient failure.
   *
   * The raw location is read only through the narrow byte-source access
   * capability and only for the length of the request pipeline; it never
   * reaches the returned value. Any rejection — from the seam or anywhere below
   * — is caught and mapped to `RETRYABLE_FAILURE`, and the thrown value (which
   * can carry the URL, a host or an address) is never read.
   */
  async open(source: TransientProviderOutputLocator): Promise<ProviderOutputByteSourceOpenResult> {
    try {
      return await withTransientProviderOutputLocatorForByteSource(source, (rawLocation) =>
        this.#fetchOutput(rawLocation),
      );
    } catch {
      return RETRYABLE_FAILURE;
    }
  }

  async #fetchOutput(rawLocation: string): Promise<ProviderOutputByteSourceOpenResult> {
    let currentUrl = rawLocation;

    for (let redirectsFollowed = 0; redirectsFollowed <= MAX_FAL_OUTPUT_REDIRECTS; redirectsFollowed += 1) {
      // Defense in depth: validate immediately before every request, the first
      // included. A locator that was authorized when constructed is not assumed
      // to be authorized network authority now.
      if (!isAuthorizedFalOutputUrl(currentUrl)) return RETRYABLE_FAILURE;

      const response = await this.#fetch({ url: currentUrl });

      if (FAL_OUTPUT_REDIRECT_STATUSES.has(response.status)) {
        // Release this redirect's body before the next GET, always.
        await releaseQuietly(response.body);
        if (redirectsFollowed === MAX_FAL_OUTPUT_REDIRECTS) return RETRYABLE_FAILURE;
        const next = resolveRedirectTarget(response.location, currentUrl);
        if (next === null) return RETRYABLE_FAILURE;
        // Refuse an out-of-policy target *before* dialing it.
        if (!isAuthorizedFalOutputUrl(next)) return RETRYABLE_FAILURE;
        currentUrl = next;
        continue;
      }

      if (response.status === 200 && response.body !== null) {
        return {
          kind: "OPEN",
          stream: buildFalOutputStream(
            response.body,
            parseFalOutputContentLength(response.contentLength),
          ),
        };
      }

      // Any other final response: an ordinary 4xx/5xx, or a 200 with no usable
      // body. Release anything the response held and report a transient failure.
      await releaseQuietly(response.body);
      return RETRYABLE_FAILURE;
    }

    // The redirect budget was exhausted without a final response.
    return RETRYABLE_FAILURE;
  }
}

/**
 * The default fetch seam, backed by the runtime's global `fetch`.
 *
 * Provided so a future production wiring has a real implementation to inject,
 * but never constructed in production in this phase. It issues a GET with
 * `redirect: "manual"` and no credentials, and streams the body through a
 * reader — it never calls `.text()`, `.json()` or `.arrayBuffer()`.
 *
 * Note: WHATWG `fetch` with `redirect: "manual"` yields an opaque-redirect
 * response whose status is `0` and whose headers are not readable, so this
 * default cannot itself follow a redirect — it surfaces one as a non-final,
 * non-200 response, which the source maps to `RETRYABLE_FAILURE`. The redirect
 * routing above is exercised through an injected seam that exposes the real
 * status and `Location`.
 */
export function createDefaultFalOutputFetch(): FalOutputFetch {
  return async ({ url }): Promise<FalOutputFetchResponse> => {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
    });

    const stream = response.body;
    const reader = stream === null ? null : stream.getReader();
    const body: FalOutputResponseBody | null =
      reader === null
        ? null
        : {
            async read(): Promise<Uint8Array | null> {
              const { value, done } = await reader.read();
              if (done || value === undefined) return null;
              return value instanceof Uint8Array ? value : new Uint8Array(value);
            },
            async cancel(): Promise<void> {
              try {
                await reader.cancel();
              } catch {
                // Best-effort release.
              }
            },
          };

    return {
      status: response.status,
      location: response.headers.get("location"),
      contentLength: response.headers.get("content-length"),
      body,
    };
  };
}
