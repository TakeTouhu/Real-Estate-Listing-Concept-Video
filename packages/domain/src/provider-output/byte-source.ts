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
 * The one control signal for a mid-stream provider-output acquisition failure.
 *
 * HTTP 200 is not the end of acquisition. A byte source can open successfully —
 * the status is good, the first chunks arrive — and then the body fails: a CDN
 * drops the connection, a socket resets, `read()` rejects with the download only
 * partly delivered. That is not a defect in the adapter and not clean end of
 * stream; it is the same transient acquisition failure that `open` reports with
 * `RETRYABLE_FAILURE`, discovered later. It must be retryable, and the partial
 * bytes must be thrown away rather than hashed and published as a short output.
 *
 * This type is how the fal byte-source adapter tells the streaming transfer core
 * "the source stream was interrupted, retry the acquisition" without handing it
 * anything a log could leak. It is application-owned and it is deliberately
 * empty: it carries **no** provider or network error object, no `cause`, no raw
 * URL, no query signature, no host or IP, no runtime exception text, no
 * provider-controlled message, and no serialization of the original rejection.
 * The adapter constructs it from nothing — the caught rejection is discarded
 * unread at the adapter boundary — and the core recognizes it nominally by its
 * private brand, never by shape.
 *
 * It is **not** a general error transport. It means exactly "expected retryable
 * source-stream interruption" and nothing else: a malformed chunk, a sink
 * defect, an adapter contract violation, or any unexpected error is a different
 * class the core must keep treating as a defect, not convert to a retry.
 */
export class ProviderOutputByteStreamRetryableFailure {
  readonly #marker: true;

  constructor() {
    this.#marker = true;
  }

  static is(value: unknown): value is ProviderOutputByteStreamRetryableFailure {
    return typeof value === "object" && value !== null && #marker in value;
  }
}

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
  return parseProviderOutputByteStream(value) !== null;
}

/**
 * A byte stream whose every field has already been read and captured.
 *
 * Structurally a {@link ProviderOutputByteStream}, and deliberately so: it is
 * assignable wherever the raw contract is expected, and the consumer cannot
 * tell it apart. What differs is provenance. A raw stream's `body`,
 * `declaredSizeBytes` and `close` are getters on an object an adapter built,
 * and reading one twice can invoke a getter twice — a second read that throws,
 * or answers differently, after validation already passed. Here every one of
 * those was read exactly once, at inspection time, and this object holds the
 * captured values. Nothing on it re-touches the raw handle.
 */
export interface CapturedProviderOutputByteStream {
  readonly body: AsyncIterable<Uint8Array>;
  readonly declaredSizeBytes: number | null;
  close(): Promise<void>;
}

/**
 * A best-effort release capability captured from a stream handle during
 * inspection, carried alongside a *malformed* result so the resource the
 * handle held can still be closed exactly once.
 *
 * It exists because the malformed path is where the resource-leak class lives:
 * a handle can be malformed — a bad body, a bad declared size, a wrapper with an
 * extra key — while still owning a live response body or socket through a
 * perfectly callable `close`. The cleanup capability is obtained from the *same*
 * single inspection that decided the handle was malformed, so the consumer never
 * re-reads the raw handle to find something to close. A `close` that could not
 * be safely obtained — absent, non-callable, or a throwing getter — yields no
 * capability at all rather than a second lookup.
 */
export interface CapturedProviderOutputCleanup {
  close(): Promise<void>;
}

/**
 * What inspecting a byte stream handle concluded, in one guarded pass.
 *
 * `VALID` carries the captured stream; `MALFORMED` carries a cleanup capability
 * when one was safely obtainable and `null` when it was not. Either way, every
 * raw getter was consulted at most once.
 */
export type ProviderOutputByteStreamInspection =
  | { readonly kind: "VALID"; readonly stream: CapturedProviderOutputByteStream }
  | { readonly kind: "MALFORMED"; readonly cleanup: CapturedProviderOutputCleanup | null };

/**
 * The materialized counterpart of {@link ProviderOutputByteSourceOpenResult}:
 * an `OPEN` carrying a captured stream, or the transient arm.
 */
export type ParsedProviderOutputByteSourceOpenResult =
  | { readonly kind: "OPEN"; readonly stream: CapturedProviderOutputByteStream }
  | { readonly kind: "RETRYABLE_FAILURE" };

/**
 * What inspecting an open result concluded, in one guarded pass over the raw
 * value.
 *
 * This is the single authority the streaming core acts on. `VALID` carries the
 * materialized result; `MALFORMED` names which fixed defect the core must raise
 * and carries a cleanup capability when the OPEN wrapper held a closable stream.
 * The core never returns to the raw `opened` object after this — every
 * top-level read (`kind`, `stream`) and every stream read happened here, once.
 */
export type ProviderOutputByteSourceOpenInspection =
  | { readonly kind: "VALID"; readonly result: ParsedProviderOutputByteSourceOpenResult }
  | {
      readonly kind: "MALFORMED";
      readonly reason: "OPEN_RESULT_MALFORMED" | "STREAM_MALFORMED";
      readonly cleanup: CapturedProviderOutputCleanup | null;
    };

/**
 * Inspect a byte stream handle in one guarded pass: capture its release
 * capability first, then validate its shape, reading each raw getter at most
 * once.
 *
 * `close` is captured **before** anything else is validated, and on its own,
 * because a handle can be malformed in every other respect while still owning a
 * live resource through a callable `close`. Capturing it first means a later
 * validation failure — a bad body, a bad declared size, a throwing
 * `[Symbol.asyncIterator]` — does not lose the ability to release. A `close`
 * that is absent, non-callable, or a throwing getter yields no capability, and
 * the getter's throw never escapes.
 *
 * The **async-iterator capability** is captured too: `body[Symbol.asyncIterator]`
 * is looked up once, and a valid stream's `body` re-exposes it as an ordinary
 * method bound to the original body object, so a `for await` never re-reads a
 * hostile getter. Each of `body`, `declaredSizeBytes` and `close` is read once.
 * Class instances remain supported: exact own keys are not required of the
 * handle. No bytes are buffered; the captured body is a thin re-exposure of the
 * source's own pull-based iterator, so backpressure and streaming are unchanged.
 */
export function inspectProviderOutputByteStream(
  value: unknown,
): ProviderOutputByteStreamInspection {
  if (!isPlainRecord(value)) return { kind: "MALFORMED", cleanup: null };

  // Capture the release capability first, guarded and alone. Obtaining `close`
  // may invoke a getter; a getter that throws is not a usable capability, and
  // its error must not escape — the answer is simply "no cleanup".
  let cleanup: CapturedProviderOutputCleanup | null = null;
  try {
    const close: unknown = value.close;
    if (typeof close === "function") {
      const closeFn = close as () => unknown;
      cleanup = { close: (): Promise<void> => Promise.resolve(closeFn.call(value)).then(() => undefined) };
    }
  } catch {
    cleanup = null;
  }

  try {
    const body: unknown = value.body;
    if (typeof body !== "object" || body === null) return { kind: "MALFORMED", cleanup };
    const iteratorFactory: unknown = (body as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ];
    if (typeof iteratorFactory !== "function") return { kind: "MALFORMED", cleanup };
    const declared: unknown = value.declaredSizeBytes;
    if (declared !== null && !(Number.isSafeInteger(declared) && (declared as number) > 0)) {
      return { kind: "MALFORMED", cleanup };
    }
    // A stream with no usable `close` is malformed by contract — but it is also
    // exactly the case where there is nothing to release, so cleanup stays null.
    if (cleanup === null) return { kind: "MALFORMED", cleanup: null };

    const sourceBody = body;
    const factory = iteratorFactory as () => AsyncIterator<Uint8Array>;
    const capturedClose = cleanup.close;
    return {
      kind: "VALID",
      stream: {
        body: {
          [Symbol.asyncIterator]: (): AsyncIterator<Uint8Array> => factory.call(sourceBody),
        },
        declaredSizeBytes: declared as number | null,
        close: capturedClose,
      },
    };
  } catch {
    return { kind: "MALFORMED", cleanup };
  }
}

/**
 * Inspect an open result in one guarded pass: the single authority the storage
 * core acts on, so it never returns to the raw value.
 *
 * `kind` is read once and, for `OPEN`, `stream` is read once — into locals that
 * everything below uses. The stream is inspected once (which captures its
 * cleanup capability), and only then are the wrapper's exact own keys checked,
 * so a wrapper that is malformed by an extra key still yields the stream's
 * cleanup capability. Which fixed defect a malformed open result names follows
 * the stream's validity, exactly as Revision 2 settled: a valid stream inside a
 * bad wrapper is `OPEN_RESULT_MALFORMED`; a malformed stream is
 * `STREAM_MALFORMED`. A throwing `kind` or `stream` getter, or an `ownKeys`
 * trap, is malformed rather than an escaping exception.
 */
export function inspectProviderOutputByteSourceOpenResult(
  value: unknown,
): ProviderOutputByteSourceOpenInspection {
  if (!isPlainRecord(value)) {
    return { kind: "MALFORMED", reason: "OPEN_RESULT_MALFORMED", cleanup: null };
  }

  let discriminant: unknown;
  try {
    discriminant = value.kind;
  } catch {
    return { kind: "MALFORMED", reason: "OPEN_RESULT_MALFORMED", cleanup: null };
  }

  if (discriminant === "RETRYABLE_FAILURE") {
    let keysOk = false;
    try {
      keysOk = hasExactlyOwnKeys(value, RETRYABLE_FAILURE_BYTE_SOURCE_KEYS);
    } catch {
      keysOk = false;
    }
    return keysOk
      ? { kind: "VALID", result: { kind: "RETRYABLE_FAILURE" } }
      : { kind: "MALFORMED", reason: "OPEN_RESULT_MALFORMED", cleanup: null };
  }

  if (discriminant !== "OPEN") {
    return { kind: "MALFORMED", reason: "OPEN_RESULT_MALFORMED", cleanup: null };
  }

  // OPEN: read `stream` exactly once. A throwing `stream` getter is malformed
  // with no candidate to clean up — there is no stream object to close.
  let streamRaw: unknown;
  try {
    streamRaw = value.stream;
  } catch {
    return { kind: "MALFORMED", reason: "OPEN_RESULT_MALFORMED", cleanup: null };
  }

  const streamInspection = inspectProviderOutputByteStream(streamRaw);

  let keysOk = false;
  try {
    keysOk = hasExactlyOwnKeys(value, OPEN_BYTE_SOURCE_KEYS);
  } catch {
    keysOk = false;
  }

  if (streamInspection.kind === "VALID" && keysOk) {
    return { kind: "VALID", result: { kind: "OPEN", stream: streamInspection.stream } };
  }

  // The defect follows the stream's validity, and the cleanup capability is the
  // one the single stream inspection already captured — never a re-read.
  //
  //  - a valid stream inside a bad wrapper is the wrapper's defect,
  //    `OPEN_RESULT_MALFORMED`, and its `close` is the cleanup capability;
  //  - a stream that is an object but malformed is `STREAM_MALFORMED`, carrying
  //    whatever cleanup the stream inspection could capture;
  //  - a stream that is missing, `null` or not an object is not a malformed
  //    stream at all — there is no stream to close — it is a malformed OPEN
  //    wrapper, with no cleanup.
  if (streamInspection.kind === "VALID") {
    return {
      kind: "MALFORMED",
      reason: "OPEN_RESULT_MALFORMED",
      cleanup: { close: streamInspection.stream.close },
    };
  }
  // "Is there a stream object to be malformed?" is a bare `typeof`/`null` check,
  // never `isPlainRecord`: a revoked `Proxy` is an object that owns a resource
  // and is a malformed *stream*, even though asking whether it is an array
  // throws. `streamRaw` is the already-read value, so this reads no getter.
  if (typeof streamRaw === "object" && streamRaw !== null) {
    return { kind: "MALFORMED", reason: "STREAM_MALFORMED", cleanup: streamInspection.cleanup };
  }
  return { kind: "MALFORMED", reason: "OPEN_RESULT_MALFORMED", cleanup: streamInspection.cleanup };
}

/**
 * Read a byte stream handle once into a captured value — or `null`.
 *
 * A compatibility surface over {@link inspectProviderOutputByteStream}: it
 * returns the valid arm's captured stream and drops the cleanup capability that
 * the malformed arm carries. Callers that must release a malformed handle use
 * the inspection directly.
 */
export function parseProviderOutputByteStream(
  value: unknown,
): CapturedProviderOutputByteStream | null {
  const inspection = inspectProviderOutputByteStream(value);
  return inspection.kind === "VALID" ? inspection.stream : null;
}

/**
 * Whether a value is a usable open result.
 *
 * Implemented on {@link inspectProviderOutputByteSourceOpenResult}, so the
 * predicate, the parser and the inspection cannot disagree.
 */
export function isWellFormedByteSourceOpenResult(
  value: unknown,
): value is ProviderOutputByteSourceOpenResult {
  return inspectProviderOutputByteSourceOpenResult(value).kind === "VALID";
}

/**
 * Read an open result once into a materialized value — or `null`.
 *
 * A compatibility surface over {@link inspectProviderOutputByteSourceOpenResult}
 * that returns the valid arm and drops the malformed arm's reason and cleanup.
 * The storage core uses the inspection directly so it can both classify the
 * defect and release a captured resource without re-reading the raw value.
 */
export function parseProviderOutputByteSourceOpenResult(
  value: unknown,
): ParsedProviderOutputByteSourceOpenResult | null {
  const inspection = inspectProviderOutputByteSourceOpenResult(value);
  return inspection.kind === "VALID" ? inspection.result : null;
}
