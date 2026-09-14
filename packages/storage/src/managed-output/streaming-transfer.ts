import { createHash } from "node:crypto";
import { AppError } from "@app/shared";
import {
  inspectProviderOutputByteSourceOpenResult,
  ProviderOutputByteStreamRetryableFailure,
  safePositiveByteCount,
  sha256Digest,
  type CapturedProviderOutputByteStream,
  type CapturedProviderOutputCleanup,
  type ManagedGenerationOutputKey,
  type ManagedOutputTransferInput,
  type ManagedOutputTransferOutcome,
  type ManagedOutputTransferPort,
  type ManagedOutputVerificationReceipt,
  type ProviderOutputByteSource,
} from "@app/domain";
import { ManagedOutputTransferDefect } from "./defect";
import {
  parseStagingCommitOutcome,
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
async function closeQuietly(stream: CapturedProviderOutputByteStream): Promise<void> {
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
 * source stream interrupted        abort → RETRYABLE_FAILURE (partial bytes discarded)
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
 * here — source unavailable, too large, empty, sink busy, and a source stream
 * interrupted after a good open — returns `RETRYABLE_FAILURE`, and Phase 2H-2
 * leaves the attempt `OUTPUT_INGESTING`. The render is still there; the key is
 * deterministic; a later run picks it up. A good HTTP status is not the end of
 * acquisition: an output body can fail mid-stream, and the adapter reports that
 * with {@link ProviderOutputByteStreamRetryableFailure}, which this core
 * recognizes on the iteration path and converts to `RETRYABLE_FAILURE` after
 * discarding the partial staged bytes. Only an adapter-contract defect — or any
 * unexpected throw that is *not* that signal — propagates, and the runner
 * records that as `TRANSFER_SOURCE_FAILED` with the same non-mutation.
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

    // Inspect the raw open result exactly once, into a materialized inspection.
    // From here the core acts only on that inspection and never returns to the
    // raw `opened` object: `kind` and `stream` were each read once inside the
    // inspection, so a stateful top-level getter cannot pass inspection and then
    // throw or change on a second read (the deferred Phase 3B-1 defect). On the
    // success path the captured stream's `body`, `declaredSizeBytes` and `close`
    // were likewise each read once, so no getter is consulted twice during use.
    const inspection = inspectProviderOutputByteSourceOpenResult(opened);
    if (inspection.kind === "MALFORMED") {
      // The malformed arm carries a cleanup capability captured during the same
      // inspection whenever the OPEN wrapper held a closable stream — a valid
      // stream inside a bad wrapper, or a malformed-but-closable stream both own
      // a live response body or socket, and the wrapper being defective does not
      // make the handle less worth releasing. Closing uses that captured
      // capability, never a re-read of `opened`. A throwing `close` getter
      // yielded no capability and is simply not called; its error never escaped.
      if (inspection.cleanup !== null) {
        await closeCleanupQuietly(inspection.cleanup);
      }
      throw new ManagedOutputTransferDefect(
        inspection.reason === "OPEN_RESULT_MALFORMED"
          ? "BYTE_SOURCE_OPEN_RESULT_MALFORMED"
          : "BYTE_SOURCE_STREAM_MALFORMED",
      );
    }
    if (inspection.result.kind === "RETRYABLE_FAILURE") return RETRYABLE;

    const stream = inspection.result.stream;
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
    stream: CapturedProviderOutputByteStream,
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
      // write. Staging state exists and is discarded first, on every path.
      await abortQuietly(session);
      // The one recognized case: the source stream was interrupted mid-transfer
      // — a `read()` that rejected after a good HTTP status, the bytes only
      // partly delivered. The fal adapter converts that to this application-owned
      // signal and nothing else, so recognition is nominal and narrow: this is an
      // acquisition failure, not a defect, and it is retryable. The staged
      // partial bytes were just aborted and are never committed, hashed into a
      // receipt, or published as a short output; the signal itself carries no
      // provider or network detail to inspect, and is *not* rethrown. Every other
      // error — a malformed chunk, a sink write refusal, an adapter-contract
      // defect, any unexpected throw without this brand — keeps its existing
      // meaning and propagates unread.
      if (ProviderOutputByteStreamRetryableFailure.is(error)) {
        return RETRYABLE;
      }
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

    // Read once, under a guard, into a plain object. The raw value is never
    // consulted again after this line — a sink result whose `kind` getter
    // throws, or answers once and then throws, is `null` here rather than an
    // adapter-controlled exception surfacing anywhere below.
    const outcome = parseStagingCommitOutcome(committed);
    if (outcome === null) {
      // The sink answered outside its contract. Nothing more may be published
      // or finalized on the strength of a value nobody defined; the staging
      // state is discarded and the defect is raised without the value in it.
      await abortQuietly(session);
      throw new ManagedOutputTransferDefect("STAGING_COMMIT_RESULT_MALFORMED");
    }

    switch (outcome.kind) {
      case "PUBLISHED":
        // The staged bytes are canonical. The sink owns whatever cleanup its
        // temporary state needs; abort is not called on a success.
        return { kind: "VERIFIED", receipt: pumped.receipt };
      case "EXISTING":
        // Something else published first. What is at the key is *its* object,
        // and the database must be finalized against that — so its receipt is
        // reported, not the one computed for the bytes just abandoned. It
        // travels as `unknown`; Phase 2H-1 decides whether it is real.
        return { kind: "VERIFIED", receipt: outcome.receipt };
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
 * Best-effort release of a cleanup capability captured during inspection.
 *
 * The capability was obtained from the single guarded inspection of the open
 * result — `close` was located there, once, and bound to its original receiver
 * — so this neither re-reads the raw handle nor looks up `close` a second time.
 * Its failure is swallowed: the fixed defect that follows is the answer, and a
 * cleanup error must not replace it, appear in its message or `cause`, or reach
 * a log, a result, an event or a row.
 */
async function closeCleanupQuietly(cleanup: CapturedProviderOutputCleanup): Promise<void> {
  try {
    await cleanup.close();
  } catch {
    // Cleanup only. The defect that follows is the answer.
  }
}
