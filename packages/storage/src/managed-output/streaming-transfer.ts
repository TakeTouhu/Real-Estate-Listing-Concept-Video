import { createHash } from "node:crypto";
import { AppError } from "@app/shared";
import {
  isWellFormedByteSourceOpenResult,
  isWellFormedByteStream,
  safePositiveByteCount,
  sha256Digest,
  type ManagedGenerationOutputKey,
  type ManagedOutputTransferInput,
  type ManagedOutputTransferOutcome,
  type ManagedOutputTransferPort,
  type ManagedOutputVerificationReceipt,
  type ProviderOutputByteSource,
  type ProviderOutputByteStream,
} from "@app/domain";
import { ManagedOutputTransferDefect } from "./defect";
import {
  isWellFormedStagingCommitOutcome,
  type ManagedOutputStagingSession,
  type ManagedOutputStagingSink,
} from "./staging";

/**
 * The hard ceiling on a single generated output, in bytes: 512 MiB.
 *
 * An internal safety limit, not a customer contract and not a product claim
 * about video sizes. It bounds what one transfer may pull through this process
 * and stage before anyone has verified anything, and it is the value below
 * which every configured limit must sit. A deployment may choose lower; nothing
 * may choose higher without changing this constant, in a reviewed commit.
 */
export const MAX_MANAGED_PROVIDER_OUTPUT_BYTES = 536_870_912;

export interface StreamingManagedOutputTransferConfig {
  /**
   * The operational byte limit for this instance.
   *
   * A positive safe integer no greater than {@link MAX_MANAGED_PROVIDER_OUTPUT_BYTES}.
   * Refused, never clamped: a configuration that asks for more than the ceiling
   * is a mistake worth seeing, and silently lowering it would hide the mistake
   * behind a limit nobody chose.
   */
  readonly maxBytes: number;
}

export interface StreamingManagedOutputTransferDeps {
  readonly source: ProviderOutputByteSource;
  readonly staging: ManagedOutputStagingSink;
}

/** Validate a configured byte limit, or refuse it. */
export function validateManagedOutputByteLimit(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_MANAGED_PROVIDER_OUTPUT_BYTES
  ) {
    throw new AppError(
      "CONFIGURATION_ERROR",
      "Managed output byte limit must be a positive safe integer no greater than 512 MiB",
    );
  }
  return value;
}

/** What one pass over the body concluded. Internal to the core. */
type PumpResult =
  | { readonly kind: "STREAMED"; readonly receipt: ManagedOutputVerificationReceipt }
  | { readonly kind: "OVERSIZE" }
  | { readonly kind: "EMPTY" };

const RETRYABLE: ManagedOutputTransferOutcome = { kind: "RETRYABLE_FAILURE" };

/**
 * Release a source, swallowing whatever release itself throws.
 *
 * The bound `catch` deliberately binds nothing. Close is cleanup: its failure
 * must not replace the transfer's real answer, and there is no value in scope
 * to log, attach or widen a diagnostic with.
 */
async function closeQuietly(stream: ProviderOutputByteStream): Promise<void> {
  try {
    await stream.close();
  } catch {
    // Cleanup only. The primary result stands.
  }
}

/** Discard a staging session, best effort, with the same discipline. */
async function abortQuietly(session: ManagedOutputStagingSession): Promise<void> {
  try {
    await session.abort();
  } catch {
    // Cleanup only. The primary result stands.
  }
}

/**
 * The streaming managed-output transfer core — **dormant**.
 *
 * Concrete, in the sense that this class really does pull bytes from a source,
 * hash them, stage them and publish them. Dormant, in the precise sense the
 * static suite asserts: nothing in production constructs it, and the two
 * dependencies it needs — a real provider byte source and a real durable
 * staging sink — do not exist in the repository. What exists is this core,
 * proven against deterministic fakes, so that the properties that are expensive
 * to get wrong are settled before the first real byte is ever fetched.
 *
 * ## Why not the existing pieces
 *
 * The provider `HttpClient` reads a response into a string; it is the right
 * shape for a status poll and the wrong shape for a video. `LocalObjectStorage`
 * takes a complete `Uint8Array` and keeps it in process memory; it is the right
 * shape for a customer's photo and the wrong shape for a generated output that
 * may be half a gigabyte. Neither is stretched into a streaming framework here.
 * Control plane and data plane get separate, narrow contracts.
 *
 * ## What one transfer does, in order
 *
 * ```text
 * open the source                  RETRYABLE_FAILURE → return it; throw → propagate
 * check the declared size          over the limit → RETRYABLE_FAILURE, no staging
 * begin an isolated staging write
 * for each chunk, one at a time    count → limit check → hash → write (backpressure)
 * zero bytes                       abort → RETRYABLE_FAILURE
 * commit with the computed receipt
 *   PUBLISHED                      VERIFIED with the computed receipt
 *   EXISTING                       VERIFIED with the canonical object's receipt
 *   RETRYABLE_FAILURE              abort → RETRYABLE_FAILURE
 * close the source                 always, exactly once
 * ```
 *
 * ## The three rules that decide correctness
 *
 * **The actual bytes are authoritative.** A declared size may refuse a transfer
 * early; it never counts, never hashes, and never lets an over-limit stream
 * through because a header said otherwise. The count and the limit are decided
 * by what actually arrived.
 *
 * **Nothing is ever written to the canonical key by this class.** It writes to
 * a staging session and asks the sink to publish. Whether publication is a
 * rename, a multipart completion or a conditional put is the sink's business;
 * what this class relies on is that until `commit` says `PUBLISHED`, the
 * destination is untouched, and after something says `EXISTING`, the
 * destination is someone else's and stays that way.
 *
 * **A transfer failure is never a provider failure.** Every expected condition
 * here — source unavailable, too large, empty, sink busy — returns
 * `RETRYABLE_FAILURE`, and Phase 2H-2 leaves the attempt `OUTPUT_INGESTING`. The
 * render is still there; the key is deterministic; a later run picks it up.
 * Only an adapter-contract defect throws, and the runner records that as
 * `TRANSFER_SOURCE_FAILED` with the same non-mutation.
 */
export class StreamingManagedOutputTransfer implements ManagedOutputTransferPort {
  private readonly maxBytes: number;
  private readonly source: ProviderOutputByteSource;
  private readonly staging: ManagedOutputStagingSink;

  constructor(
    config: StreamingManagedOutputTransferConfig,
    deps: StreamingManagedOutputTransferDeps,
  ) {
    this.maxBytes = validateManagedOutputByteLimit(config.maxBytes);
    this.source = deps.source;
    this.staging = deps.staging;
  }

  /**
   * Copy one provider output into managed storage and report its integrity.
   *
   * The locator is handed to the source and never inspected. This class has no
   * way to read it — there is no accessor — and it does not need one: which
   * bytes the locator names is the source's problem, and which bytes arrived is
   * the only thing this class measures.
   */
  async transferAndVerify(input: ManagedOutputTransferInput): Promise<ManagedOutputTransferOutcome> {
    // A throw here is the source adapter failing unexpectedly. It propagates:
    // the runner maps it to TRANSFER_SOURCE_FAILED, and the thrown value is
    // never read, logged or persisted by this class.
    const opened: unknown = await this.source.open(input.source);

    if (!isWellFormedByteSourceOpenResult(opened)) {
      // Three questions, answered separately, because the first revision fused
      // two of them and leaked a resource doing so.
      //
      //   1. Is this OPEN-shaped, carrying an object-valued `stream`?
      //   2. Does that candidate have a callable `close`?
      //   3. Is the candidate itself a well-formed stream?
      //
      // Cleanup eligibility is (1) and (2) alone. It must *not* depend on (3):
      // a perfectly valid stream inside a wrapper that carries an extra key
      // still owns a response body or a socket, and the wrapper being the
      // defective part does not make the stream any less worth releasing.
      // (3) decides only which defect is raised — the wrapper's, or the
      // stream's.
      const candidate = openStreamCandidate(opened);
      if (candidate === null) {
        throw new ManagedOutputTransferDefect("BYTE_SOURCE_OPEN_RESULT_MALFORMED");
      }
      await closeCandidateQuietly(candidate);
      throw new ManagedOutputTransferDefect(
        isWellFormedByteStream(candidate)
          ? "BYTE_SOURCE_OPEN_RESULT_MALFORMED"
          : "BYTE_SOURCE_STREAM_MALFORMED",
      );
    }
    if (opened.kind === "RETRYABLE_FAILURE") return RETRYABLE;

    const stream = opened.stream;
    try {
      return await this.consume(stream, input.destinationKey);
    } finally {
      // Exactly once, on every path out of a successful open: success, size
      // refusal, iteration failure, sink failure, commit failure, defect.
      await closeQuietly(stream);
    }
  }

  /**
   * Everything between a successfully opened stream and its release.
   *
   * Separated from `transferAndVerify` so the `finally` that closes the stream
   * wraps exactly this and nothing else, and so every early return below is
   * visibly inside that guarantee.
   */
  private async consume(
    stream: ProviderOutputByteStream,
    destinationKey: ManagedGenerationOutputKey,
  ): Promise<ManagedOutputTransferOutcome> {
    // Preflight only. A declared size over the limit is refused before any
    // staging state exists — but a declared size *under* the limit proves
    // nothing, and the loop below still counts every byte.
    if (stream.declaredSizeBytes !== null && stream.declaredSizeBytes > this.maxBytes) {
      return RETRYABLE;
    }

    // A throw from `begin` is the sink adapter failing unexpectedly. Nothing has
    // been staged, so there is nothing to abort; it propagates.
    const session = await this.staging.begin({ destinationKey });

    let pumped: PumpResult;
    try {
      pumped = await this.pump(stream.body, session);
    } catch (error) {
      // Source iteration threw, a chunk was not bytes, or the sink refused a
      // write. Staging state exists and is discarded; the error itself is the
      // answer and is neither inspected nor replaced.
      await abortQuietly(session);
      throw error;
    }

    if (pumped.kind !== "STREAMED") {
      // Too large, or nothing at all. Both are expected conditions, both leave
      // the attempt ingesting, and neither may leave a partial object behind.
      await abortQuietly(session);
      return RETRYABLE;
    }

    let committed: unknown;
    try {
      committed = await session.commit({ receipt: pumped.receipt });
    } catch (error) {
      await abortQuietly(session);
      throw error;
    }

    if (!isWellFormedStagingCommitOutcome(committed)) {
      // The sink answered outside its contract. Nothing more may be published
      // or finalized on the strength of a value nobody defined; the staging
      // state is discarded and the defect is raised without the value in it.
      await abortQuietly(session);
      throw new ManagedOutputTransferDefect("STAGING_COMMIT_RESULT_MALFORMED");
    }

    switch (committed.kind) {
      case "PUBLISHED":
        // The staged bytes are canonical. The sink owns whatever cleanup its
        // temporary state needs; abort is not called on a success.
        return { kind: "VERIFIED", receipt: pumped.receipt };
      case "EXISTING":
        // Something else published first. What is at the key is *its* object,
        // and the database must be finalized against that — so its receipt is
        // reported, not the one computed for the bytes just abandoned. It
        // travels as `unknown`; Phase 2H-1 decides whether it is real.
        return { kind: "VERIFIED", receipt: committed.receipt };
      case "RETRYABLE_FAILURE":
        await abortQuietly(session);
        return RETRYABLE;
    }
  }

  /**
   * One pass over the body: count, bound, hash and write each chunk as it
   * arrives, and nothing is held beyond the chunk in hand.
   *
   * The loop is the backpressure mechanism. `for await` pulls the next chunk
   * only after the body of the loop has finished with the previous one, and the
   * body awaits the sink's `write` — so a sink that is slow to take a chunk is
   * a source that is not asked for the next one. There is no read-ahead, no
   * queue and no array of chunks; a mutation that introduced one would move the
   * whole output into memory and the backpressure test would catch it.
   *
   * The limit is checked *before* the chunk is hashed or written, so an
   * over-limit stream stops at the first chunk that crosses the line and never
   * stages the bytes that would have taken it over. Returning from inside the
   * loop closes the iterator, which is the source's cue to stop producing.
   */
  private async pump(
    body: AsyncIterable<Uint8Array>,
    session: ManagedOutputStagingSession,
  ): Promise<PumpResult> {
    const hash = createHash("sha256");
    let total = 0;

    for await (const chunk of body) {
      if (!(chunk instanceof Uint8Array)) {
        throw new ManagedOutputTransferDefect("BYTE_SOURCE_CHUNK_MALFORMED");
      }
      total += chunk.byteLength;
      if (total > this.maxBytes) return { kind: "OVERSIZE" };
      hash.update(chunk);
      await session.write(chunk);
    }

    if (total === 0) return { kind: "EMPTY" };

    // Both facts go through the domain's own constructors. `total` is positive
    // and a safe integer by construction here, and the digest is lowercase hex
    // from Node; the constructors are the single definition of "valid" and are
    // not bypassed for being redundant.
    return {
      kind: "STREAMED",
      receipt: {
        sha256: sha256Digest(hash.digest("hex")),
        sizeBytes: safePositiveByteCount(total),
      },
    };
  }
}

/**
 * If a malformed open result is at least `{ kind: "OPEN", stream: <object> }`,
 * return that stream object so its resource can be released; else `null`.
 *
 * Returns the candidate whether or not it is a well-formed stream. Validity
 * decides which defect is raised, never whether cleanup is attempted. The
 * reads are inside a guard because the value is whatever an adapter handed
 * back, and a throwing `stream` getter is a defect, not an answer.
 */
function openStreamCandidate(value: unknown): object | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as { kind?: unknown; stream?: unknown };
    if (record.kind !== "OPEN") return null;
    const stream = record.stream;
    return typeof stream === "object" && stream !== null ? stream : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort `close()` on a stream candidate, if it has one.
 *
 * *Obtaining* `close` is inside the guard, not just invoking it. A candidate
 * with a throwing `close` getter is exactly the kind of hostile object this
 * path exists for, and the getter's error must not replace the fixed defect
 * that is about to be raised — nor appear in its message, its `cause`, a log,
 * a result, an event or a row.
 */
async function closeCandidateQuietly(candidate: object): Promise<void> {
  try {
    const close = (candidate as { close?: unknown }).close;
    if (typeof close !== "function") return;
    await (close as () => unknown).call(candidate);
  } catch {
    // Cleanup only. The defect that follows is the answer.
  }
}
