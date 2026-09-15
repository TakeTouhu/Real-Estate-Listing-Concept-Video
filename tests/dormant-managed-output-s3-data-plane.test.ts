import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { managedGenerationOutputKey, TransientProviderOutputLocator } from "@app/domain";
import { S3ManagedOutputStagingSink, StreamingManagedOutputTransfer } from "@app/storage";
import { createFakeS3World, FakeS3MultipartClient } from "@app/storage/testing";
import {
  FalProviderOutputByteSource,
  type FalOutputFetch,
  type FalOutputResponseBody,
} from "@app/video-providers";

/**
 * The complete dormant provider-output data plane, end to end, with no network:
 *
 *   signed opaque fal locator
 *     → FalProviderOutputByteSource (authorized, streaming)
 *     → StreamingManagedOutputTransfer (incremental hash + count)
 *     → S3ManagedOutputStagingSink (multipart parts, per-part SHA-256)
 *     → conditional CompleteMultipartUpload (If-None-Match "*")
 *     → PUBLISHED → transfer VERIFIED
 *
 * A fake fetch seam and a fake S3 client join the three real pieces. No fal, no
 * AWS, no Internet. Nothing here is production wiring: the fal source, the
 * transfer core and the S3 sink all exist, but only tests construct them.
 */

const RAW = "https://v3.fal.media/files/panda/out.mp4?X-Fal-Signature=SECRETSIGNATURE";
const KEY = managedGenerationOutputKey({ organizationId: "org_e2e_s3", attemptId: "sgen_e2e_s3" });
const BUCKET = "managed-output-e2e";

function locator(): TransientProviderOutputLocator {
  const built = TransientProviderOutputLocator.fromUnknown(RAW);
  if (!built.ok) throw new Error("fixture locator");
  return built.value;
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function digestHex(chunks: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const c of chunks) hash.update(c);
  return hash.digest("hex");
}

function streamingFetch(chunks: readonly Uint8Array[]): { fetch: FalOutputFetch; reads: () => number } {
  let readCount = 0;
  const fetch: FalOutputFetch = async ({ url }) => {
    void url;
    let position = 0;
    const body: FalOutputResponseBody = {
      async read(): Promise<Uint8Array | null> {
        readCount += 1;
        if (position >= chunks.length) return null;
        const chunk = chunks[position];
        position += 1;
        return chunk ?? null;
      },
      async cancel(): Promise<void> {},
    };
    return { status: 200, location: null, contentLength: null, body };
  };
  return { fetch, reads: () => readCount };
}

function pipeline(
  fetch: FalOutputFetch,
  client: FakeS3MultipartClient,
  options: { readonly maxBytes?: number; readonly partSizeBytes?: number } = {},
): StreamingManagedOutputTransfer {
  return new StreamingManagedOutputTransfer(
    { maxBytes: options.maxBytes ?? 1_048_576 },
    {
      source: new FalProviderOutputByteSource({ fetch }),
      staging: new S3ManagedOutputStagingSink(
        { bucket: BUCKET, partSizeBytes: options.partSizeBytes },
        { client },
      ),
    },
  );
}

describe("the fal source, the transfer core and the S3 sink publish end to end", () => {
  it("streams, hashes, uploads parts with SHA-256, and publishes through a conditional completion", async () => {
    const chunks = [bytes(1, 2, 3), bytes(4, 5), bytes(6, 7, 8, 9)];
    const client = new FakeS3MultipartClient();
    const outcome = await pipeline(streamingFetch(chunks).fetch, client).transferAndVerify({
      source: locator(),
      destinationKey: KEY,
    });

    expect(outcome.kind).toBe("VERIFIED");
    if (outcome.kind !== "VERIFIED") throw new Error("expected VERIFIED");
    const receipt = outcome.receipt as { sha256: string; sizeBytes: number };
    // The core's receipt is computed over the exact ordered bytes.
    expect(receipt.sha256).toBe(digestHex(chunks));
    expect(receipt.sizeBytes).toBe(9);

    // The canonical object holds exactly the streamed bytes at the exact,
    // extensionless key.
    expect(KEY).toBe("org/org_e2e_s3/generations/sgen_e2e_s3/output");
    expect(client.world.canonical.get(KEY)).toEqual(bytes(1, 2, 3, 4, 5, 6, 7, 8, 9));

    // A part was uploaded, carrying the correct per-part SHA-256, and completion
    // used the precondition.
    expect(client.uploadedParts.length).toBeGreaterThanOrEqual(1);
    for (const p of client.uploadedParts) {
      expect(p.checksumSha256Base64).toBe(createHash("sha256").update(p.bytes).digest("base64"));
    }
    expect(client.completeCalls).toHaveLength(1);
    expect(client.completeCalls[0]!.ifNoneMatch).toBe("*");
    expect(client.abortCalls).toHaveLength(0);
  });

  it("lets none of the locator, its signature, or a provider URL reach S3", async () => {
    const client = new FakeS3MultipartClient();
    const outcome = await pipeline(streamingFetch([bytes(1)]).fetch, client).transferAndVerify({
      source: locator(),
      destinationKey: KEY,
    });
    expect(outcome.kind).toBe("VERIFIED");
    // Every field S3 ever saw is the bucket and the managed key — nothing else.
    const seen = JSON.stringify({
      buckets: client.requestBuckets,
      keys: client.requestKeys,
      complete: client.completeCalls,
    });
    for (const banned of ["SECRETSIGNATURE", "fal.media", "X-Fal-Signature", "FAL_KEY", ".mp4", "http"]) {
      expect(seen).not.toContain(banned);
    }
    // The transfer outcome carries no locator either.
    expect(JSON.stringify(outcome)).not.toContain("SECRETSIGNATURE");
  });

  it("pulls the source lazily rather than draining it before staging", async () => {
    // The source is pulled chunk by chunk (plus the terminating null read); an
    // implementation that drained the whole body into memory would read all at
    // once and a whole-object buffer would show up in the sink.
    const chunks = [bytes(1), bytes(2), bytes(3)];
    const { fetch, reads } = streamingFetch(chunks);
    const client = new FakeS3MultipartClient();
    await pipeline(fetch, client).transferAndVerify({ source: locator(), destinationKey: KEY });
    expect(reads()).toBe(chunks.length + 1);
  });

  it("gives a resuming session EXISTING with the winner's receipt when the key is already published", async () => {
    const world = createFakeS3World();
    const winner = bytes(9, 8, 7, 6, 5);
    // A first run publishes.
    const first = new FakeS3MultipartClient({ world });
    expect(
      (
        await pipeline(streamingFetch([winner]).fetch, first).transferAndVerify({
          source: locator(),
          destinationKey: KEY,
        })
      ).kind,
    ).toBe("VERIFIED");

    // A second run re-downloads different bytes, loses the race, and verifies
    // the canonical winner by streaming it back.
    const second = new FakeS3MultipartClient({ world });
    const outcome = await pipeline(streamingFetch([bytes(1, 1)]).fetch, second).transferAndVerify({
      source: locator(),
      destinationKey: KEY,
    });
    expect(outcome.kind).toBe("VERIFIED");
    const receipt = (outcome as { receipt: { sha256: string; sizeBytes: number } }).receipt;
    expect(receipt.sha256).toBe(digestHex([winner]));
    expect(receipt.sizeBytes).toBe(5);
    expect(world.canonical.get(KEY)).toEqual(winner);
  });

  it("reports RETRYABLE_FAILURE through the whole stack when a part upload is interrupted", async () => {
    // Force the first part upload (at commit's flush for this small output) to
    // reject: the sink converts it to the staging retry signal, the core returns
    // RETRYABLE_FAILURE, nothing is published.
    const client = new FakeS3MultipartClient({
      failUploadPartOnCall: 1,
      failUploadPartWith: { name: "SlowDown", $metadata: { httpStatusCode: 503 }, message: "SECRETSIGNATURE" },
    });
    const outcome = await pipeline(streamingFetch([bytes(1, 2, 3)]).fetch, client).transferAndVerify({
      source: locator(),
      destinationKey: KEY,
    });
    expect(outcome).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(client.world.canonical.size).toBe(0);
    expect(client.completeCalls).toHaveLength(0);
    expect(JSON.stringify(outcome)).not.toContain("SECRETSIGNATURE");
  });

  it("aborts once and returns RETRYABLE_FAILURE when the second part of one large streamed chunk fails", async () => {
    // One large streamed body carrying three full parts; the second UploadPart
    // rejects. The whole stack must abort the multipart upload exactly once,
    // publish nothing, and report a retry — no later slice uploaded, no leak.
    const PART = 5 * 1024 * 1024;
    const big = new Uint8Array(3 * PART).fill(9);
    const client = new FakeS3MultipartClient({
      failUploadPartOnCall: 2,
      failUploadPartWith: { name: "SlowDown", $metadata: { httpStatusCode: 503 }, message: "SECRETSIGNATURE" },
    });
    const outcome = await pipeline(streamingFetch([big]).fetch, client, {
      maxBytes: 536_870_912,
      partSizeBytes: PART,
    }).transferAndVerify({ source: locator(), destinationKey: KEY });

    expect(outcome).toEqual({ kind: "RETRYABLE_FAILURE" });
    // Only the first part was uploaded; the third was never attempted.
    expect(client.uploadedParts.map((p) => p.partNumber)).toEqual([1]);
    // The core aborted the multipart upload exactly once.
    expect(client.abortCalls).toHaveLength(1);
    expect(client.completeCalls).toHaveLength(0);
    expect(client.world.canonical.size).toBe(0);
    expect(JSON.stringify(outcome)).not.toContain("SECRETSIGNATURE");
  });
});
