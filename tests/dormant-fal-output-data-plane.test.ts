import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { managedGenerationOutputKey, TransientProviderOutputLocator } from "@app/domain";
import { StreamingManagedOutputTransfer } from "@app/storage";
import { createTransferBarrier, FakeManagedOutputStagingSink } from "@app/storage/testing";
import {
  FalProviderOutputByteSource,
  type FalOutputFetch,
  type FalOutputResponseBody,
} from "@app/video-providers";

/**
 * The primary dormant proof that the concrete fal byte source drops into the
 * existing streaming transfer core with no production wiring and no buffering:
 *
 *   opaque locator → controlled byte-source access → authorized fal URL →
 *   streaming fake HTTP body → StreamingManagedOutputTransfer → incremental
 *   hash and count → staging publish → VERIFIED receipt
 *
 * No network, no fal, no object store — a fake fetch seam and the in-memory
 * staging fake, joined by the real core.
 */

const RAW = "https://v3.fal.media/files/panda/out.mp4?X-Fal-Signature=SECRETSIGNATURE";
const KEY = managedGenerationOutputKey({ organizationId: "org_e2e", attemptId: "sgen_e2e" });

function locator(): TransientProviderOutputLocator {
  const built = TransientProviderOutputLocator.fromUnknown(RAW);
  if (!built.ok) throw new Error("fixture locator");
  return built.value;
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function digestOf(chunks: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
}

/** A fetch seam that streams the given chunks from one 200 response. */
function streamingFetch(
  chunks: readonly Uint8Array[],
  options: {
    readonly contentLength?: string | null;
    readonly beforeRead?: (index: number) => Promise<void>;
    /**
     * When set, `read()` rejects after this many chunks have been delivered —
     * modelling a body that fails mid-stream after a good HTTP status (a CDN
     * drop, a socket reset). The rejection value carries the signed URL, so the
     * test can prove none of it survives.
     */
    readonly rejectReadAfter?: number;
  } = {},
): { fetch: FalOutputFetch; reads: () => number; cancels: () => number; requests: () => number } {
  let readCount = 0;
  let cancelCount = 0;
  let requestCount = 0;
  const fetch: FalOutputFetch = async ({ url }) => {
    // The seam only ever receives a URL — no headers, no method, no credential.
    void url;
    requestCount += 1;
    let position = 0;
    const body: FalOutputResponseBody = {
      async read(): Promise<Uint8Array | null> {
        if (options.beforeRead !== undefined) await options.beforeRead(position);
        readCount += 1;
        if (options.rejectReadAfter !== undefined && position >= options.rejectReadAfter) {
          throw new Error(`fake CDN reset mid-stream reaching ${RAW}`);
        }
        if (position >= chunks.length) return null;
        const chunk = chunks[position];
        position += 1;
        return chunk ?? null;
      },
      async cancel(): Promise<void> {
        cancelCount += 1;
      },
    };
    return { status: 200, location: null, contentLength: options.contentLength ?? null, body };
  };
  return {
    fetch,
    reads: () => readCount,
    cancels: () => cancelCount,
    requests: () => requestCount,
  };
}

function transfer(fetch: FalOutputFetch, sink: FakeManagedOutputStagingSink): StreamingManagedOutputTransfer {
  return new StreamingManagedOutputTransfer(
    { maxBytes: 1_048_576 },
    { source: new FalProviderOutputByteSource({ fetch }), staging: sink },
  );
}

describe("the fal byte source drives the streaming transfer core end to end", () => {
  it("verifies the streamed bytes and publishes exactly them to the canonical key", async () => {
    const chunks = [bytes(1, 2, 3), bytes(4, 5), bytes(6, 7, 8, 9)];
    const { fetch } = streamingFetch(chunks, { contentLength: "9" });
    const sink = new FakeManagedOutputStagingSink();

    const outcome = await transfer(fetch, sink).transferAndVerify({
      source: locator(),
      destinationKey: KEY,
    });

    expect(outcome.kind).toBe("VERIFIED");
    if (outcome.kind !== "VERIFIED") throw new Error("expected VERIFIED");
    const receipt = outcome.receipt as { sha256: string; sizeBytes: number };
    // The digest and count are the core's, computed over the actual bytes.
    expect(receipt.sha256).toBe(digestOf(chunks));
    expect(receipt.sizeBytes).toBe(9);

    // The canonical object holds exactly the streamed bytes, in order.
    const canonical = sink.canonical.get(KEY);
    expect(canonical).toBeDefined();
    expect(canonical!.bytes).toEqual(bytes(1, 2, 3, 4, 5, 6, 7, 8, 9));
  });

  it("lets the actual streamed count override a smaller declared Content-Length", async () => {
    const chunks = [bytes(1, 2, 3), bytes(4, 5, 6)];
    // The source declares a smaller size; the core counts what actually arrives.
    const { fetch } = streamingFetch(chunks, { contentLength: "2" });
    const sink = new FakeManagedOutputStagingSink();
    const outcome = await transfer(fetch, sink).transferAndVerify({
      source: locator(),
      destinationKey: KEY,
    });
    if (outcome.kind !== "VERIFIED") throw new Error("expected VERIFIED");
    expect((outcome.receipt as { sizeBytes: number }).sizeBytes).toBe(6);
  });

  it("never lets the locator or its signature reach the outcome", async () => {
    const { fetch } = streamingFetch([bytes(1)]);
    const sink = new FakeManagedOutputStagingSink();
    const outcome = await transfer(fetch, sink).transferAndVerify({
      source: locator(),
      destinationKey: KEY,
    });
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain("SECRETSIGNATURE");
    expect(serialized).not.toContain("fal.media");
  });

  it("treats a body that fails mid-stream as a retryable acquisition failure, publishing nothing", async () => {
    // The whole dormant data plane, interrupted: the locator opens, the fal
    // source authorizes the URL and begins streaming, the first chunk reaches the
    // core and is staged — and then the body's read rejects. The rejection is
    // discarded at the fal boundary, converted to the application-owned signal,
    // recognized by the core, and reported as a retry. The partial bytes are
    // aborted and never published.
    const { fetch, reads, cancels, requests } = streamingFetch(
      [bytes(1, 2, 3), bytes(4, 5, 6)],
      { rejectReadAfter: 1 },
    );
    const sink = new FakeManagedOutputStagingSink();

    const outcome = await transfer(fetch, sink).transferAndVerify({
      source: locator(),
      destinationKey: KEY,
    });

    expect(outcome).toEqual({ kind: "RETRYABLE_FAILURE" });

    // Nothing was committed or made canonical: no truncated, corrupt output.
    expect(sink.canonical.size).toBe(0);
    expect(sink.lastSession.commitCalls).toBe(0);
    expect(sink.lastSession.abortCalls).toBe(1);
    // Exactly one chunk was staged before the interruption — and it went nowhere.
    expect(sink.lastSession.writes).toBe(1);

    // The signal and outcome carry none of the URL, signature, or network text.
    const serialized = `${JSON.stringify(outcome)} ${String(outcome)}`;
    expect(serialized).not.toContain("SECRETSIGNATURE");
    expect(serialized).not.toContain("fal.media");
    expect(serialized).not.toContain("CDN reset");

    // No auto-retry at the HTTP layer: a single request was made, and the body
    // was cancelled exactly once through the idempotent close.
    expect(requests()).toBe(1);
    expect(cancels()).toBe(1);
    // read#1 delivered the chunk; read#2 rejected.
    expect(reads()).toBe(2);
  });

  it("does not eagerly drain the source: with the sink blocked on its first write, exactly one chunk has been pulled", async () => {
    const barrier = createTransferBarrier();
    const { fetch, reads } = streamingFetch([bytes(1), bytes(2), bytes(3)], { contentLength: null });
    const sink = new FakeManagedOutputStagingSink({
      async beforeWrite(_session, index) {
        if (index === 0) {
          barrier.signalEntered();
          await barrier.waitForRelease();
        }
      },
    });

    const running = transfer(fetch, sink).transferAndVerify({ source: locator(), destinationKey: KEY });
    await barrier.entered;
    // The core pulled the first chunk, tried to write it, and is now blocked on
    // the sink. Backpressure means it has not read ahead: exactly one real chunk
    // has been pulled (plus no more — the second read has not happened).
    expect(reads()).toBe(1);
    barrier.release();

    const outcome = await running;
    expect(outcome.kind).toBe("VERIFIED");
  });
});
