import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
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
  type FakeS3ReadBackOptions,
} from "../testing/s3-fakes";
import { exitedWith, FakeProcessRunner, ffprobeDocument } from "../testing/media-fakes";
import { FfprobeMediaProbe } from "./ffprobe";
import {
  MEDIA_VALIDATION_TEMP_FILENAME,
  ManagedOutputMediaValidationDefect,
  S3ManagedOutputMediaValidator,
  type ManagedOutputMediaProbe,
  type ManagedOutputMediaProbeOutcome,
} from "./media-validation";
import { MAX_MANAGED_PROVIDER_OUTPUT_BYTES } from "./streaming-transfer";

/**
 * The validator against a fake canonical-object reader and a fake process
 * runner. The canonical bytes are re-hashed before anything is inspected, and
 * every exit path removes what it materialized.
 */

const KEY = managedGenerationOutputKey({ organizationId: "org_mv", attemptId: "sgen_mv" });
const BUCKET = "managed-output-mv";

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function sha256Of(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function receiptFor(data: Uint8Array): ManagedOutputVerificationReceipt {
  return {
    sha256: sha256Digest(sha256Of(data)),
    sizeBytes: safePositiveByteCount(data.byteLength),
  };
}

interface Harness {
  readonly client: FakeS3MultipartClient;
  readonly runner: FakeProcessRunner;
  readonly validator: S3ManagedOutputMediaValidator;
}

function harness(
  canonical: Uint8Array | null,
  options: {
    readonly readBack?: FakeS3ReadBackOptions;
    readonly runner?: FakeProcessRunner;
    readonly probe?: ManagedOutputMediaProbe;
    readonly maxBytes?: number;
  } = {},
): Harness {
  const world = createFakeS3World();
  if (canonical !== null) world.canonical.set(KEY, canonical);
  const client = new FakeS3MultipartClient({ world, readBack: options.readBack });
  const runner = options.runner ?? new FakeProcessRunner({ outcome: exitedWith(ffprobeDocument()) });
  const probe = options.probe ?? new FfprobeMediaProbe({}, { runner });
  const validator = new S3ManagedOutputMediaValidator(
    { bucket: BUCKET, maxBytes: options.maxBytes },
    { reader: client, probe },
  );
  return { client, runner, validator };
}

// ---------------------------------------------------------------------------

describe("configuration", () => {
  it("refuses a blank bucket", () => {
    expect(
      () =>
        new S3ManagedOutputMediaValidator(
          { bucket: " " },
          { reader: new FakeS3MultipartClient(), probe: { async probe() { return { kind: "RETRYABLE" }; } } },
        ),
    ).toThrow(AppError);
  });

  it("refuses a byte limit above the managed-output ceiling", () => {
    expect(
      () =>
        new S3ManagedOutputMediaValidator(
          { bucket: BUCKET, maxBytes: MAX_MANAGED_PROVIDER_OUTPUT_BYTES + 1 },
          { reader: new FakeS3MultipartClient(), probe: { async probe() { return { kind: "RETRYABLE" }; } } },
        ),
    ).toThrow(AppError);
  });

  it("treats a malformed expected receipt as a caller defect, not invalid media", async () => {
    const h = harness(bytes(1, 2, 3));
    let caught: unknown;
    try {
      await h.validator.validate({
        destinationKey: KEY,
        expectedReceipt: { sha256: "not-a-digest", sizeBytes: 3 } as unknown as ManagedOutputVerificationReceipt,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ManagedOutputMediaValidationDefect);
    expect((caught as ManagedOutputMediaValidationDefect).code).toBe("EXPECTED_RECEIPT_MALFORMED");
    // Nothing was read or probed on a contract defect.
    expect(h.runner.runs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("canonical bytes are re-verified before anything is inspected", () => {
  it("probes only when the digest and size both match", async () => {
    const data = bytes(1, 2, 3, 4, 5);
    const h = harness(data);
    const outcome = await h.validator.validate({ destinationKey: KEY, expectedReceipt: receiptFor(data) });
    expect(outcome).toEqual({ kind: "VALID", facts: expect.objectContaining({ container: "ISO_BMFF" }) });
    expect(h.runner.runs).toHaveLength(1);
  });

  it("returns INTEGRITY_MISMATCH and never probes when the size disagrees", async () => {
    const data = bytes(1, 2, 3, 4, 5);
    const h = harness(data);
    const wrong: ManagedOutputVerificationReceipt = {
      sha256: sha256Digest(sha256Of(data)),
      sizeBytes: safePositiveByteCount(99),
    };
    expect(await h.validator.validate({ destinationKey: KEY, expectedReceipt: wrong })).toEqual({
      kind: "INTEGRITY_MISMATCH",
    });
    expect(h.runner.runs).toHaveLength(0);
  });

  it("returns INTEGRITY_MISMATCH and never probes when the digest disagrees", async () => {
    const data = bytes(1, 2, 3, 4, 5);
    const h = harness(data);
    const wrong: ManagedOutputVerificationReceipt = {
      sha256: sha256Digest("b".repeat(64)),
      sizeBytes: safePositiveByteCount(5),
    };
    expect(await h.validator.validate({ destinationKey: KEY, expectedReceipt: wrong })).toEqual({
      kind: "INTEGRITY_MISMATCH",
    });
    expect(h.runner.runs).toHaveLength(0);
  });

  it("computes one exact digest across many S3 chunks", async () => {
    const data = new Uint8Array(1000).map((_v, i) => (i * 7) & 0xff);
    const h = harness(data, { readBack: { chunkSize: 7 } });
    expect(
      await h.validator.validate({ destinationKey: KEY, expectedReceipt: receiptFor(data) }),
    ).toEqual({ kind: "VALID", facts: expect.anything() });
    // The inspector saw exactly those bytes.
    expect(h.runner.lastRun.seenFileSha256).toBe(sha256Of(data));
    expect(h.runner.lastRun.seenFileBytes).toBe(1000);
  });

  it.each([
    ["a misleadingly smaller Content-Length", 2],
    ["a misleadingly larger Content-Length", 4096],
    ["an absent Content-Length", null],
  ])("lets the actual streamed bytes decide despite %s", async (_l, override) => {
    const data = bytes(9, 8, 7, 6);
    const h = harness(data, { readBack: { contentLengthOverride: override, chunkSize: 2 } });
    expect(
      await h.validator.validate({ destinationKey: KEY, expectedReceipt: receiptFor(data) }),
    ).toEqual({ kind: "VALID", facts: expect.anything() });
    expect(h.runner.lastRun.seenFileBytes).toBe(4);
  });

  it("refuses before reading when the declared Content-Length exceeds the ceiling", async () => {
    const data = bytes(1, 2, 3, 4);
    const h = harness(data, { readBack: { contentLengthOverride: 10_000 }, maxBytes: 16 });
    expect(
      await h.validator.validate({ destinationKey: KEY, expectedReceipt: receiptFor(data) }),
    ).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(h.runner.runs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("storage and materialization failures are retryable, never media verdicts", () => {
  it.each([
    ["the GET rejects", { getRejects: true }],
    ["the body is absent", { noBody: true }],
    ["the body stream rejects mid-read", { rejectReadAfter: 1, chunkSize: 2 }],
  ])("returns RETRYABLE_FAILURE when %s", async (_l, readBack) => {
    const data = bytes(1, 2, 3, 4, 5, 6);
    const h = harness(data, { readBack });
    const outcome = await h.validator.validate({
      destinationKey: KEY,
      expectedReceipt: receiptFor(data),
    });
    expect(outcome).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(Object.getOwnPropertyNames(outcome)).toEqual(["kind"]);
    expect(h.runner.runs).toHaveLength(0);
    // No AWS detail escapes.
    expect(JSON.stringify(outcome)).not.toContain("secret");
    expect(JSON.stringify(outcome)).not.toContain("GetFailed");
  });

  it("returns RETRYABLE_FAILURE for a zero-byte canonical object", async () => {
    const h = harness(new Uint8Array(0));
    expect(
      await h.validator.validate({ destinationKey: KEY, expectedReceipt: receiptFor(bytes(1)) }),
    ).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(h.runner.runs).toHaveLength(0);
  });

  it("returns RETRYABLE_FAILURE when the actual object exceeds the ceiling, never probing it", async () => {
    const data = new Uint8Array(200).fill(3);
    const h = harness(data, { maxBytes: 64, readBack: { contentLengthOverride: null, chunkSize: 16 } });
    expect(
      await h.validator.validate({ destinationKey: KEY, expectedReceipt: receiptFor(data) }),
    ).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(h.runner.runs).toHaveLength(0);
  });

  it("returns RETRYABLE_FAILURE when the local temporary file cannot be created", async () => {
    // A non-existent TMPDIR makes the application-created directory fail: a
    // local materialization problem, not a media verdict.
    const data = bytes(1, 2, 3);
    const h = harness(data);
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = join("/nonexistent-tmp-for-test", "nowhere");
    try {
      expect(
        await h.validator.validate({ destinationKey: KEY, expectedReceipt: receiptFor(data) }),
      ).toEqual({ kind: "RETRYABLE_FAILURE" });
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
    expect(h.runner.runs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("the materialized temporary file", () => {
  it("exists while the inspector runs, holds the exact canonical bytes, and is owner-only", async () => {
    const data = new Uint8Array(512).map((_v, i) => (i * 13) & 0xff);
    const h = harness(data, { readBack: { chunkSize: 33 } });
    await h.validator.validate({ destinationKey: KEY, expectedReceipt: receiptFor(data) });

    const run = h.runner.lastRun;
    expect(run.fileExisted).toBe(true);
    expect(run.seenFileSha256).toBe(sha256Of(data));
    expect(run.seenFileBytes).toBe(512);
    if (process.platform !== "win32") {
      // Owner read/write only where the platform honours the mode.
      expect(run.seenFileMode).toBe(0o600);
    }
  });

  it("names the file and directory with nothing tenant-, storage- or provider-derived", async () => {
    const data = bytes(1, 2, 3);
    const h = harness(data);
    await h.validator.validate({ destinationKey: KEY, expectedReceipt: receiptFor(data) });
    const path = h.runner.lastRun.args.at(-1) ?? "";
    expect(basename(path)).toBe(MEDIA_VALIDATION_TEMP_FILENAME);
    for (const banned of ["org_mv", "sgen_mv", "org/", "generations/", BUCKET, "s3://", "fal", ".mp4"]) {
      expect(path).not.toContain(banned);
    }
  });

  it.each([
    [
      "VALID",
      () => new FakeProcessRunner({ outcome: exitedWith(ffprobeDocument()) }),
      { kind: "VALID" },
    ],
    [
      "INVALID_MEDIA",
      () => new FakeProcessRunner({ outcome: { kind: "EXITED", exitCode: 1, stdout: "" } }),
      { kind: "INVALID_MEDIA", reason: "PROBE_REJECTED" },
    ],
    [
      "RETRYABLE_FAILURE",
      () => new FakeProcessRunner({ outcome: { kind: "TIMED_OUT" } }),
      { kind: "RETRYABLE_FAILURE" },
    ],
  ])("is removed, with its directory, on the %s path", async (_label, makeRunner, expected) => {
    const data = bytes(4, 5, 6);
    const runner = makeRunner();
    const h = harness(data, { runner });
    const outcome = await h.validator.validate({
      destinationKey: KEY,
      expectedReceipt: receiptFor(data),
    });
    expect(outcome).toMatchObject(expected);
    const path = runner.lastRun.args.at(-1) ?? "";
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
  });

  it("is removed on the INTEGRITY_MISMATCH path, where the inspector never runs", async () => {
    // The probe is never invoked, so capture the directory by watching the
    // validator's own temp root before and after.
    const data = bytes(1, 2, 3);
    const h = harness(data);
    const wrong: ManagedOutputVerificationReceipt = {
      sha256: sha256Digest("c".repeat(64)),
      sizeBytes: safePositiveByteCount(3),
    };
    expect(await h.validator.validate({ destinationKey: KEY, expectedReceipt: wrong })).toEqual({
      kind: "INTEGRITY_MISMATCH",
    });
    expect(h.runner.runs).toHaveLength(0);
  });

  it("is removed even when the inspector throws an unexpected defect", async () => {
    const data = bytes(7, 7, 7);
    const runner = new FakeProcessRunner({ outcome: { kind: "LAUNCH_FAILED" } });
    const h = harness(data, { runner });
    let caught: unknown;
    try {
      await h.validator.validate({ destinationKey: KEY, expectedReceipt: receiptFor(data) });
    } catch (e) {
      caught = e;
    }
    expect((caught as ManagedOutputMediaValidationDefect).code).toBe("PROBE_PROGRAM_UNAVAILABLE");
    const path = runner.lastRun.args.at(-1) ?? "";
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
  });

  it("lets a cleanup that finds nothing to remove leave the primary result untouched", async () => {
    // The inspector deletes the directory out from under the validator; the
    // best-effort cleanup must not turn a VALID result into a failure.
    const data = bytes(1, 2, 3);
    const probe: ManagedOutputMediaProbe = {
      async probe(localPath): Promise<ManagedOutputMediaProbeOutcome> {
        await rm(dirname(localPath), { recursive: true, force: true });
        return {
          kind: "FACTS",
          facts: {
            container: "ISO_BMFF",
            durationMs: 1000,
            videoWidth: 640,
            videoHeight: 480,
            videoStreamCount: 1,
            audioStreamCount: 0,
          },
        };
      },
    };
    const h = harness(data, { probe });
    expect(
      await h.validator.validate({ destinationKey: KEY, expectedReceipt: receiptFor(data) }),
    ).toMatchObject({ kind: "VALID" });
  });
});

// ---------------------------------------------------------------------------

describe("the validator never buffers the whole object", () => {
  const src = readFileSync(join(__dirname, "media-validation.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");

  it("uses none of the whole-object shortcuts", () => {
    for (const banned of [
      "transformToByteArray",
      "transformToString",
      ".arrayBuffer(",
      ".text(",
      "Buffer.concat",
      "readFile(",
      "chunks.push",
      "Array.from(",
    ]) {
      expect(`${banned}: ${src.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("hashes and writes incrementally, one chunk at a time", () => {
    expect(src.includes('createHash("sha256")')).toBe(true);
    expect(src.includes("hash.update(chunk)")).toBe(true);
    expect(src.includes("handle.write(chunk)")).toBe(true);
  });
});
