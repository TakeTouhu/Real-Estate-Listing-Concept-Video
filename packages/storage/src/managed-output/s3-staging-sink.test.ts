import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import {
  managedGenerationOutputKey,
  safePositiveByteCount,
  sha256Digest,
  type ManagedOutputVerificationReceipt,
} from "@app/domain";
import {
  createFakeS3World,
  FakeS3MultipartClient,
  fakeS3Error,
  type FakeS3ReadBackOptions,
} from "../testing/s3-fakes";
import {
  ManagedOutputStagingRetryableFailure,
  type ManagedOutputStagingCommitOutcome,
} from "./staging";
import {
  DEFAULT_S3_PART_SIZE_BYTES,
  S3_MIN_PART_SIZE_BYTES,
  S3ManagedOutputStagingDefect,
  S3ManagedOutputStagingSink,
  validateS3PartSize,
} from "./s3-staging-sink";
import { MAX_MANAGED_PROVIDER_OUTPUT_BYTES } from "./streaming-transfer";

/**
 * The durable S3 sink, against a deterministic fake S3 client — no network, no
 * AWS. The fake models the one thing that makes the sink correct: conditional
 * completion. It also validates each part's SHA-256 the way S3 would, so a wrong
 * or missing per-part checksum is a real failure, not a silent pass.
 */

const KEY = managedGenerationOutputKey({ organizationId: "org_s3", attemptId: "sgen_s3" });
const BUCKET = "managed-output-bucket";
const SECRET_KEY = managedGenerationOutputKey({ organizationId: "org_s3", attemptId: "sgen_s3" });

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/** A deterministic filled buffer of a given size. */
function filled(size: number, value: number): Uint8Array {
  return new Uint8Array(size).fill(value);
}

function digestHex(...chunks: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const c of chunks) hash.update(c);
  return hash.digest("hex");
}

function receiptFor(...chunks: readonly Uint8Array[]): ManagedOutputVerificationReceipt {
  return {
    sha256: sha256Digest(digestHex(...chunks)),
    sizeBytes: safePositiveByteCount(chunks.reduce((n, c) => n + c.byteLength, 0)),
  };
}

function sink(client: FakeS3MultipartClient, config: Partial<{ partSizeBytes: number; verificationMaxBytes: number; bucket: string; expectedBucketOwner: string }> = {}) {
  return new S3ManagedOutputStagingSink(
    {
      bucket: config.bucket ?? BUCKET,
      partSizeBytes: config.partSizeBytes,
      verificationMaxBytes: config.verificationMaxBytes,
      expectedBucketOwner: config.expectedBucketOwner,
    },
    { client },
  );
}

/** Stream chunks through a fresh session and commit, returning the outcome. */
async function stage(
  client: FakeS3MultipartClient,
  chunks: readonly Uint8Array[],
  config?: Parameters<typeof sink>[1],
  receipt?: ManagedOutputVerificationReceipt,
): Promise<ManagedOutputStagingCommitOutcome> {
  const session = await sink(client, config).begin({ destinationKey: KEY });
  for (const c of chunks) await session.write(c);
  return (await session.commit({ receipt: receipt ?? receiptFor(...chunks) })) as ManagedOutputStagingCommitOutcome;
}

// ---------------------------------------------------------------------------

describe("configuration", () => {
  it("names the S3 part-size floor and default", () => {
    expect(S3_MIN_PART_SIZE_BYTES).toBe(5 * 1024 * 1024);
    expect(DEFAULT_S3_PART_SIZE_BYTES).toBe(8 * 1024 * 1024);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 5 * 1024 * 1024 + 0.5],
    ["below the 5 MiB floor", 5 * 1024 * 1024 - 1],
    ["above the managed-output ceiling", MAX_MANAGED_PROVIDER_OUTPUT_BYTES + 1],
    ["a numeric string", "8388608"],
    ["NaN", Number.NaN],
  ])("refuses a part size that is %s", (_label, value) => {
    expect(() => validateS3PartSize(value)).toThrow(AppError);
    expect(
      () => new S3ManagedOutputStagingSink({ bucket: BUCKET, partSizeBytes: value as number }, { client: new FakeS3MultipartClient() }),
    ).toThrow(AppError);
  });

  it("accepts the floor, the default, and the ceiling", () => {
    expect(validateS3PartSize(S3_MIN_PART_SIZE_BYTES)).toBe(S3_MIN_PART_SIZE_BYTES);
    expect(validateS3PartSize(DEFAULT_S3_PART_SIZE_BYTES)).toBe(DEFAULT_S3_PART_SIZE_BYTES);
    expect(validateS3PartSize(MAX_MANAGED_PROVIDER_OUTPUT_BYTES)).toBe(MAX_MANAGED_PROVIDER_OUTPUT_BYTES);
  });

  it("refuses a blank bucket", () => {
    expect(() => new S3ManagedOutputStagingSink({ bucket: "  " }, { client: new FakeS3MultipartClient() })).toThrow(AppError);
  });

  it("refuses a verification limit above the managed-output ceiling", () => {
    expect(
      () => new S3ManagedOutputStagingSink({ bucket: BUCKET, verificationMaxBytes: MAX_MANAGED_PROVIDER_OUTPUT_BYTES + 1 }, { client: new FakeS3MultipartClient() }),
    ).toThrow(AppError);
  });
});

// ---------------------------------------------------------------------------

describe("a single small output publishes through one conditional completion", () => {
  it("uploads one final part with its SHA-256 and completes with If-None-Match *", async () => {
    const client = new FakeS3MultipartClient();
    const chunks = [bytes(1, 2, 3), bytes(4, 5), bytes(6, 7, 8, 9)];
    const outcome = await stage(client, chunks);

    expect(outcome).toEqual({ kind: "PUBLISHED" });
    // Exactly the streamed bytes are canonical at the exact extensionless key.
    expect(client.world.canonical.get(KEY)).toEqual(bytes(1, 2, 3, 4, 5, 6, 7, 8, 9));
    expect(KEY).toBe("org/org_s3/generations/sgen_s3/output");

    // One multipart upload, one part (all bytes fit under the part size).
    expect(client.createCalls).toHaveLength(1);
    expect(client.uploadedParts).toHaveLength(1);
    expect(client.uploadedParts[0]!.partNumber).toBe(1);
    // The part carried the correct SHA-256, Base64.
    expect(client.uploadedParts[0]!.checksumSha256Base64).toBe(
      createHash("sha256").update(bytes(1, 2, 3, 4, 5, 6, 7, 8, 9)).digest("base64"),
    );

    // Completion carried the precondition and the exact ordered parts.
    expect(client.completeCalls).toHaveLength(1);
    expect(client.completeCalls[0]!.ifNoneMatch).toBe("*");
    expect(client.completeCalls[0]!.parts.map((p) => p.partNumber)).toEqual([1]);
    // Nothing aborted on a successful publish.
    expect(client.abortCalls).toHaveLength(0);
  });

  it("refuses to publish when the receipt byte count disagrees with the staged bytes", async () => {
    const client = new FakeS3MultipartClient();
    const session = await sink(client).begin({ destinationKey: KEY });
    await session.write(bytes(1, 2, 3));
    // Receipt claims 99 bytes; 3 were staged.
    const wrong: ManagedOutputVerificationReceipt = {
      sha256: sha256Digest("a".repeat(64)),
      sizeBytes: safePositiveByteCount(99),
    };
    let caught: unknown;
    try {
      await session.commit({ receipt: wrong });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(S3ManagedOutputStagingDefect);
    expect((caught as S3ManagedOutputStagingDefect).code).toBe("STAGED_BYTES_RECEIPT_MISMATCH");
    // Nothing published, and the losing upload was aborted.
    expect(client.world.canonical.size).toBe(0);
    expect(client.completeCalls).toHaveLength(0);
    // The receipt content never entered the error.
    expect((caught as Error).message).not.toContain("99");
    expect((caught as Error).cause).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("multipart correctness", () => {
  const PART = S3_MIN_PART_SIZE_BYTES; // 5 MiB

  it("splits into non-final parts at or above the minimum, a smaller final part, consecutive numbers", async () => {
    const client = new FakeS3MultipartClient();
    // 5 MiB + 5 MiB + 2 MiB => parts [5MiB, 5MiB, 2MiB]
    const chunks = [filled(PART, 1), filled(PART, 2), filled(2 * 1024 * 1024, 3)];
    const outcome = await stage(client, chunks, { partSizeBytes: PART });
    expect(outcome).toEqual({ kind: "PUBLISHED" });

    expect(client.uploadedParts).toHaveLength(3);
    // Part numbers start at 1 and are consecutive.
    expect(client.uploadedParts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    // Non-final parts satisfy the minimum; the final part may be smaller.
    expect(client.uploadedParts[0]!.bytes.byteLength).toBeGreaterThanOrEqual(PART);
    expect(client.uploadedParts[1]!.bytes.byteLength).toBeGreaterThanOrEqual(PART);
    expect(client.uploadedParts[2]!.bytes.byteLength).toBe(2 * 1024 * 1024);
    // No zero-size part.
    for (const p of client.uploadedParts) expect(p.bytes.byteLength).toBeGreaterThan(0);
    // Each part carries its own SHA-256.
    for (const p of client.uploadedParts) {
      expect(p.checksumSha256Base64).toBe(createHash("sha256").update(p.bytes).digest("base64"));
    }
    // Completion part order is exactly ascending.
    expect(client.completeCalls[0]!.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    expect(client.completeCalls[0]!.ifNoneMatch).toBe("*");
  });

  it("does not create an empty final part when the bytes divide evenly into full parts", async () => {
    const client = new FakeS3MultipartClient();
    const chunks = [filled(PART, 1), filled(PART, 2)]; // exactly two full parts
    await stage(client, chunks, { partSizeBytes: PART });
    expect(client.uploadedParts).toHaveLength(2);
    expect(client.completeCalls[0]!.parts.map((p) => p.partNumber)).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------

describe("first publish wins at the canonical key", () => {
  it("gives the loser the winner's streamed receipt, never overwriting the winner", async () => {
    const world = createFakeS3World();
    const winnerBytes = bytes(10, 20, 30, 40, 50);
    const loserBytes = bytes(99, 98, 97);

    // Winner publishes first.
    const clientA = new FakeS3MultipartClient({ world });
    expect(await stage(clientA, [winnerBytes])).toEqual({ kind: "PUBLISHED" });
    expect(world.canonical.get(KEY)).toEqual(winnerBytes);

    // Loser stages different bytes and loses the conditional completion.
    const clientB = new FakeS3MultipartClient({ world });
    const outcome = await stage(clientB, [loserBytes]);

    expect(outcome).toEqual({
      kind: "EXISTING",
      receipt: { sha256: sha256Digest(digestHex(winnerBytes)), sizeBytes: safePositiveByteCount(5) },
    });
    // The winner's bytes are still canonical; the loser overwrote nothing.
    expect(world.canonical.get(KEY)).toEqual(winnerBytes);
    // The loser aborted its own upload and read the winner back.
    expect(clientB.abortCalls).toHaveLength(1);
    expect(clientB.getObjectCalls).toHaveLength(1);
    // The reported receipt is the winner's, not the loser's.
    const existing = outcome as { receipt: ManagedOutputVerificationReceipt };
    expect(existing.receipt.sha256).not.toBe(sha256Digest(digestHex(loserBytes)));
  });

  it("both racing sessions converge on the same canonical receipt", async () => {
    const world = createFakeS3World();
    const winner = bytes(1, 1, 1, 1);
    const a = new FakeS3MultipartClient({ world });
    const b = new FakeS3MultipartClient({ world });
    const first = await stage(a, [winner]);
    const second = await stage(b, [bytes(2, 2)]);
    const winnerReceipt = { sha256: sha256Digest(digestHex(winner)), sizeBytes: safePositiveByteCount(4) };
    expect(first).toEqual({ kind: "PUBLISHED" });
    expect(second).toEqual({ kind: "EXISTING", receipt: winnerReceipt });
  });
});

// ---------------------------------------------------------------------------

describe("crash recovery: a resumed session reads the already-published winner", () => {
  it("returns EXISTING with the verified canonical receipt when a prior run published", async () => {
    const world = createFakeS3World();
    const published = filled(1024, 7);
    // Run A publishes, then "the process crashes" before the DB is finalized.
    const a = new FakeS3MultipartClient({ world });
    expect(await stage(a, [published])).toEqual({ kind: "PUBLISHED" });

    // Run B resumes, re-downloads (bytes may differ), stages, and loses.
    const b = new FakeS3MultipartClient({ world });
    const outcome = await stage(b, [filled(2048, 3)]);
    expect(outcome).toEqual({
      kind: "EXISTING",
      receipt: { sha256: sha256Digest(digestHex(published)), sizeBytes: safePositiveByteCount(1024) },
    });
    expect(world.canonical.get(KEY)).toEqual(published);
  });
});

// ---------------------------------------------------------------------------

describe("existing-winner read-back is streamed and hashed, never trusting ETag or Content-Length", () => {
  function withWinner(winner: Uint8Array, readBack: FakeS3ReadBackOptions): FakeS3MultipartClient {
    const world = createFakeS3World();
    world.canonical.set(KEY, winner);
    return new FakeS3MultipartClient({ world, readBack });
  }

  it("computes the digest incrementally across many small chunks", async () => {
    const winner = filled(40, 5);
    const client = withWinner(winner, { chunkSize: 4 });
    const outcome = await stage(client, [bytes(1)]);
    expect(outcome).toEqual({
      kind: "EXISTING",
      receipt: { sha256: sha256Digest(digestHex(winner)), sizeBytes: safePositiveByteCount(40) },
    });
    // The receipt digest is a real 64-hex SHA-256 of the bytes — never an ETag.
    const existing = outcome as { receipt: ManagedOutputVerificationReceipt };
    expect(existing.receipt.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(String(existing.receipt.sha256)).not.toContain("etag");
  });

  it.each([
    ["a Content-Length smaller than the actual object", 3],
    ["a Content-Length larger than the actual object", 9999],
    ["an absent Content-Length", null],
  ])("lets the actual streamed count win over %s", async (_label, override) => {
    const winner = bytes(1, 2, 3, 4, 5, 6);
    const client = withWinner(winner, { contentLengthOverride: override, chunkSize: 2 });
    const outcome = await stage(client, [bytes(7)]);
    expect((outcome as { receipt: ManagedOutputVerificationReceipt }).receipt.sizeBytes).toBe(6);
  });

  it.each([
    ["the GET rejects", { getRejects: true }],
    ["the body is absent", { noBody: true }],
    ["the body stream rejects mid-read", { rejectReadAfter: 1, chunkSize: 2 }],
  ])("returns RETRYABLE_FAILURE when %s", async (_label, readBack) => {
    const client = withWinner(bytes(1, 2, 3, 4, 5, 6), readBack);
    expect(await stage(client, [bytes(9)])).toEqual({ kind: "RETRYABLE_FAILURE" });
  });

  it("returns RETRYABLE_FAILURE for a zero-byte canonical object", async () => {
    const world = createFakeS3World();
    world.canonical.set(KEY, new Uint8Array(0));
    const client = new FakeS3MultipartClient({ world });
    expect(await stage(client, [bytes(9)])).toEqual({ kind: "RETRYABLE_FAILURE" });
  });

  it("returns RETRYABLE_FAILURE when the existing object exceeds the verification ceiling", async () => {
    const client = withWinner(filled(100, 4), {});
    expect(await stage(client, [bytes(9)], { verificationMaxBytes: 16 })).toEqual({
      kind: "RETRYABLE_FAILURE",
    });
  });

  it("refuses before reading when the declared Content-Length is over the ceiling", async () => {
    const client = withWinner(filled(10, 4), { contentLengthOverride: 1_000_000 });
    expect(await stage(client, [bytes(9)], { verificationMaxBytes: 16 })).toEqual({
      kind: "RETRYABLE_FAILURE",
    });
  });

  it("never lets a raw AWS rejection escape into the outcome", async () => {
    const world = createFakeS3World();
    world.canonical.set(KEY, bytes(1, 2, 3));
    const client = new FakeS3MultipartClient({ world, readBack: { getRejects: true } });
    const outcome = await stage(client, [bytes(9)]);
    expect(outcome).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(Object.getOwnPropertyNames(outcome)).toEqual(["kind"]);
    expect(JSON.stringify(outcome)).not.toContain("secret");
    expect(JSON.stringify(outcome)).not.toContain("GetFailed");
  });
});

// ---------------------------------------------------------------------------

describe("completion conflicts", () => {
  it("maps a 409 ConditionalRequestConflict to RETRYABLE_FAILURE and aborts", async () => {
    const client = new FakeS3MultipartClient({ completeOverride: "409" });
    const outcome = await stage(client, [bytes(1, 2, 3)]);
    expect(outcome).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(client.abortCalls).toHaveLength(1);
    expect(client.world.canonical.size).toBe(0);
    // Never reconstructs the session: no second completion attempt.
    expect(client.completeCalls).toHaveLength(1);
  });

  it("maps an unexpected completion error to RETRYABLE_FAILURE without leaking it", async () => {
    const client = new FakeS3MultipartClient({
      completeOverride: { throw: fakeS3Error(500, "InternalError", "s3://secret/leak") },
    });
    const outcome = await stage(client, [bytes(1, 2, 3)]);
    expect(outcome).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(JSON.stringify(outcome)).not.toContain("secret");
    expect(client.abortCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("storage write interruptions are the retryable staging signal", () => {
  const PART = S3_MIN_PART_SIZE_BYTES;

  it("throws the application-owned signal, carrying no SDK detail, when a part upload rejects before any part", async () => {
    const client = new FakeS3MultipartClient({
      failUploadPartOnCall: 1,
      failUploadPartWith: fakeS3Error(503, "SlowDown", "s3://secret/req-id"),
    });
    const session = await sink(client, { partSizeBytes: PART }).begin({ destinationKey: KEY });
    let thrown: unknown;
    try {
      await session.write(filled(PART, 1)); // triggers the first part upload
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ManagedOutputStagingRetryableFailure);
    expect(ManagedOutputStagingRetryableFailure.is(thrown)).toBe(true);
    expect(thrown).not.toBeInstanceOf(Error);
    // None of the SDK error survives on the signal.
    expect(String(thrown)).not.toContain("secret");
    expect(JSON.stringify(thrown) ?? "").not.toContain("secret");
    // Nothing published.
    expect(client.completeCalls).toHaveLength(0);
    expect(client.world.canonical.size).toBe(0);
  });

  it("throws the signal when a part upload rejects after at least one successful part", async () => {
    const client = new FakeS3MultipartClient({
      failUploadPartOnCall: 2,
      failUploadPartWith: fakeS3Error(500, "InternalError"),
    });
    const session = await sink(client, { partSizeBytes: PART }).begin({ destinationKey: KEY });
    await session.write(filled(PART, 1)); // part 1 uploaded
    let thrown: unknown;
    try {
      await session.write(filled(PART, 2)); // part 2 rejects
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ManagedOutputStagingRetryableFailure);
    expect(client.uploadedParts).toHaveLength(1);
  });

  it("converts a CreateMultipartUpload rejection on the first write to the signal", async () => {
    const client = new FakeS3MultipartClient({ failCreateWith: fakeS3Error(503, "SlowDown") });
    const session = await sink(client, { partSizeBytes: PART }).begin({ destinationKey: KEY });
    let thrown: unknown;
    try {
      await session.write(filled(PART, 1));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ManagedOutputStagingRetryableFailure);
  });

  it("returns RETRYABLE_FAILURE when the final part upload at commit is interrupted", async () => {
    // A single sub-part output: the only part upload happens at commit's flush.
    const client = new FakeS3MultipartClient({
      failUploadPartOnCall: 1,
      failUploadPartWith: fakeS3Error(500, "InternalError"),
    });
    const outcome = await stage(client, [bytes(1, 2, 3)]);
    expect(outcome).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(client.completeCalls).toHaveLength(0);
    expect(client.world.canonical.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("abort is idempotent and safe", () => {
  it("aborts at most once, even called repeatedly", async () => {
    const client = new FakeS3MultipartClient({ completeOverride: "409" });
    const session = await sink(client).begin({ destinationKey: KEY });
    await session.write(bytes(1, 2, 3));
    await session.commit({ receipt: receiptFor(bytes(1, 2, 3)) }); // 409 -> abort once
    await session.abort();
    await session.abort();
    expect(client.abortCalls).toHaveLength(1);
  });

  it("never aborts after a successful publish", async () => {
    const client = new FakeS3MultipartClient();
    const session = await sink(client).begin({ destinationKey: KEY });
    await session.write(bytes(1, 2, 3));
    expect(await session.commit({ receipt: receiptFor(bytes(1, 2, 3)) })).toEqual({ kind: "PUBLISHED" });
    await session.abort();
    expect(client.abortCalls).toHaveLength(0);
  });

  it("is a no-op when nothing was ever uploaded", async () => {
    const client = new FakeS3MultipartClient();
    const session = await sink(client).begin({ destinationKey: KEY });
    await session.abort();
    expect(client.abortCalls).toHaveLength(0);
    expect(client.createCalls).toHaveLength(0);
  });

  it("lets a failing abort leave the primary outcome untouched", async () => {
    const client = new FakeS3MultipartClient({ completeOverride: "409", abortRejects: true });
    const outcome = await stage(client, [bytes(1, 2, 3)]);
    expect(outcome).toEqual({ kind: "RETRYABLE_FAILURE" });
  });
});

// ---------------------------------------------------------------------------

describe("the sink receives only the managed key and bytes, never a provider secret", () => {
  it("sends only the bucket and the exact canonical key on every request", async () => {
    const world = createFakeS3World();
    world.canonical.set(SECRET_KEY, bytes(1, 2, 3)); // pre-existing winner to force read-back
    const client = new FakeS3MultipartClient({ world });
    await stage(client, [bytes(9, 9, 9)]);
    for (const b of client.requestBuckets) expect(b).toBe(BUCKET);
    for (const k of client.requestKeys) expect(k).toBe("org/org_s3/generations/sgen_s3/output");
    // No provider URL, signature, key, model id, or download URL anywhere.
    const seen = JSON.stringify({ b: client.requestBuckets, k: client.requestKeys });
    for (const banned of ["fal.media", "X-Fal-Signature", "FAL_KEY", "http", ".mp4"]) {
      expect(seen).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------

describe("the sink never buffers the whole object", () => {
  // Prose in the doc comments describes these prohibitions; prose naming a method
  // is not the code calling it, so strip comments before scanning.
  const src = readFileSync(join(__dirname, "s3-staging-sink.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");

  it("never calls whole-object transforms or concatenates the whole output", () => {
    for (const banned of [
      "transformToByteArray",
      "transformToString",
      ".arrayBuffer(",
      ".text(",
      ".json(",
      "Buffer.concat",
    ]) {
      expect(`${banned}: ${src.includes(banned)}`).toBe(`${banned}: false`);
    }
  });
});
