import { hasExactlyOwnKeys, isPlainRecord } from "../submission/untrusted";
import type { TransientProviderOutputLocator } from "./locator";

/**
 * Where a provider's finished bytes come from, as a contract with no
 * implementation.
 *
 * This is the data-plane counterpart of `ProviderCompletionStatusSource`. That
 * port asks a vendor's control plane a small question and gets a small JSON
 * answer; this one opens a stream that may be half a gigabyte, and the two must
 * not share a transport. The provider `HttpClient` reads bodies into a string,
 * which is exactly right for a status poll and exactly wrong for a video.
 *
 * **There is no concrete implementation in this phase.** The real fal source —
 * the thing that actually dereferences a `TransientProviderOutputLocator` and
 * makes an HTTP request against `fal.media` — belongs to a later phase, and is
 * the phase in which the locator finally gains a way to be read. Until then the
 * locator passes through this port unread, and the transfer core that consumes
 * this port cannot inspect it either.
 */

/**
 * One open provider output, ready to be consumed once.
 *
 * `body` is pulled, never pushed: the consumer iterates, and the source produces
 * a chunk only when asked for one. That is what makes backpressure a property of
 * the loop that reads it rather than a feature the source has to implement.
 *
 * `declaredSizeBytes` is what the source *claims* — a `Content-Length`, a
 * metadata field, a guess. It is a preflight optimization and nothing more: a
 * declared size over the limit lets the transfer refuse before staging anything,
 * but the actual streamed bytes decide the count and the limit either way.
 * `null` means the source declined to claim anything, which is always allowed.
 *
 * `close` releases whatever the source holds — a response body, a socket, a file
 * handle. It is called exactly once by the consumer after a successful open, on
 * every path, and its failure never changes the transfer's answer.
 */
export interface ProviderOutputByteStream {
  readonly body: AsyncIterable<Uint8Array>;
  readonly declaredSizeBytes: number | null;
  close(): Promise<void>;
}

/**
 * What opening a locator can conclude.
 *
 * Two arms, mirroring the transfer outcome. `RETRYABLE_FAILURE` is the source
 * saying "not now": a transient network fault, an expired signed URL another
 * poll may reacquire, a CDN hiccup. It carries nothing else — no status, no
 * message, no URL — because every one of those is a channel through which a
 * bearer credential reaches a log.
 *
 * There is deliberately no `TERMINAL_FAILURE`. A source has no evidence that any
 * fetch failure is permanent, and an arm that let it claim one would invite a
 * transient outage to abandon a render the platform has already paid for.
 *
 * A *throw* from `open` means something different again: the adapter itself
 * failed unexpectedly. The transfer core lets it propagate, and the Phase 2H-2
 * runner records `TRANSFER_SOURCE_FAILED` with the attempt left ingesting.
 */
export type ProviderOutputByteSourceOpenResult =
  | { readonly kind: "OPEN"; readonly stream: ProviderOutputByteStream }
  | { readonly kind: "RETRYABLE_FAILURE" };

/**
 * The source port.
 *
 * Takes the opaque locator and nothing else. There is no organization, attempt,
 * destination key or receipt here: a byte source has no use for any of them,
 * and a field that travels is a field the far side can log.
 */
export interface ProviderOutputByteSource {
  open(source: TransientProviderOutputLocator): Promise<ProviderOutputByteSourceOpenResult>;
}

/** The complete own-property set of each arm. Exhaustive, not a minimum. */
export const OPEN_BYTE_SOURCE_KEYS: readonly string[] = ["kind", "stream"];
export const RETRYABLE_FAILURE_BYTE_SOURCE_KEYS: readonly string[] = ["kind"];

/**
 * Whether a value is a usable byte stream handle.
 *
 * Three facts are proved: the body can be iterated asynchronously, the declared
 * size is `null` or a positive safe integer, and `close` is callable. A stream
 * whose body is a string, whose declared size is `"1024"`, `0`, `-1`, `NaN` or
 * `Infinity`, or whose `close` is missing is a defect in the adapter that
 * produced it — and a defect is thrown, never treated as a transient failure.
 *
 * The handle is *not* held to exact own keys, unlike every other contract at
 * these boundaries. A real adapter will hand back a class instance whose
 * `close` lives on a prototype and whose private state lives wherever the
 * runtime puts it; demanding an exact own-property set would refuse every
 * legitimate implementation and admit only object literals. The chunks the body
 * emits are checked one by one by the consumer instead, which is where the
 * untrusted data actually arrives.
 */
export function isWellFormedByteStream(value: unknown): value is ProviderOutputByteStream {
  if (!isPlainRecord(value)) return false;
  // Total over hostile objects. Reading `body`, `declaredSizeBytes` or `close`
  // may invoke a getter, and a getter that throws is not "a callable close" —
  // it is a handle outside the contract, and the answer is `false`, never the
  // getter's own error escaping from a predicate.
  try {
    const body: unknown = value.body;
    if (typeof body !== "object" || body === null) return false;
    if (
      typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function"
    ) {
      return false;
    }
    const declared: unknown = value.declaredSizeBytes;
    if (declared !== null && !(Number.isSafeInteger(declared) && (declared as number) > 0)) {
      return false;
    }
    return typeof value.close === "function";
  } catch {
    return false;
  }
}

/**
 * Whether a value is a usable open result.
 *
 * Exact own keys on the result itself, for the reason every 2H contract settled:
 * `{ kind: "OPEN", stream, url }` is not an open result, it is a provider payload
 * with a discriminant in it. The stream inside is checked by
 * {@link isWellFormedByteStream}, which has its own, looser rule.
 */
export function isWellFormedByteSourceOpenResult(
  value: unknown,
): value is ProviderOutputByteSourceOpenResult {
  if (!isPlainRecord(value)) return false;
  // Total, like the stream predicate: reading `kind` or `stream` may invoke a
  // getter on a hostile object, and a getter that throws makes the value
  // malformed rather than making this predicate throw.
  try {
    switch (value.kind) {
      case "OPEN":
        return (
          hasExactlyOwnKeys(value, OPEN_BYTE_SOURCE_KEYS) && isWellFormedByteStream(value.stream)
        );
      case "RETRYABLE_FAILURE":
        return hasExactlyOwnKeys(value, RETRYABLE_FAILURE_BYTE_SOURCE_KEYS);
      default:
        return false;
    }
  } catch {
    return false;
  }
}
