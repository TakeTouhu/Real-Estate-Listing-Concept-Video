import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ISO_BMFF_CONTAINER,
  managedGenerationOutputKey,
  parseManagedOutputMediaValidationOutcome,
  safePositiveByteCount,
  sha256Digest,
  type ManagedOutputVerificationReceipt,
} from "@app/domain";
import { FfprobeMediaProbe, S3ManagedOutputMediaValidator } from "@app/storage";
import {
  createFakeS3World,
  FakeProcessRunner,
  FakeS3MultipartClient,
  ffprobeDocument,
  videoStream,
} from "@app/storage/testing";

/**
 * The dormant managed-output media-validation data plane, end to end, with no
 * network and no `ffprobe` binary:
 *
 *   canonical S3 object
 *     → streaming materialization to a private temporary file
 *     → incremental SHA-256 + byte count
 *     → expected receipt matches
 *     → the inspector is handed *those same bytes*
 *     → normalized media facts
 *     → VALID, read back through the real domain parser
 *
 * The fake process runner deliberately **reads the file it was pointed at**, so
 * this proves the inspector would receive the exact canonical bytes rather than
 * merely a path-shaped argument. Nothing here is production wiring: the
 * validator, the probe and the reader all exist, and only tests construct them.
 */

const KEY = managedGenerationOutputKey({ organizationId: "org_e2e_mv", attemptId: "sgen_e2e_mv" });
const BUCKET = "managed-output-e2e-mv";

function sha256Of(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function receiptFor(data: Uint8Array): ManagedOutputVerificationReceipt {
  return {
    sha256: sha256Digest(sha256Of(data)),
    sizeBytes: safePositiveByteCount(data.byteLength),
  };
}

/** A deterministic, position-dependent body so any reorder changes the digest. */
function canonicalBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

describe("the canonical object, the materializer and the inspector agree end to end", () => {
  it("streams, re-verifies, probes the same bytes, and reports VALID through the domain parser", async () => {
    const object = canonicalBytes(4096);
    const world = createFakeS3World();
    world.canonical.set(KEY, object);
    // Many small chunks: the object is never delivered, or held, in one piece.
    const reader = new FakeS3MultipartClient({ world, readBack: { chunkSize: 61 } });

    // The inspector derives its answer from the bytes it actually read off disk.
    const runner = new FakeProcessRunner({
      outcome: (run) => {
        expect(run.fileExisted).toBe(true);
        expect(run.seenFileSha256).toBe(sha256Of(object));
        return {
          kind: "EXITED",
          exitCode: 0,
          stdout: JSON.stringify(
            ffprobeDocument({
              formatDuration: "12.25",
              streams: [videoStream(1920, 1080)],
            }),
          ),
        };
      },
    });

    const validator = new S3ManagedOutputMediaValidator(
      { bucket: BUCKET },
      { reader, probe: new FfprobeMediaProbe({}, { runner }) },
    );

    const raw: unknown = await validator.validate({
      destinationKey: KEY,
      expectedReceipt: receiptFor(object),
    });

    // The port returns `unknown`; the domain parser is the authority.
    const outcome = parseManagedOutputMediaValidationOutcome(raw);
    expect(outcome).toEqual({
      kind: "VALID",
      facts: {
        container: ISO_BMFF_CONTAINER,
        durationMs: 12_250,
        videoWidth: 1920,
        videoHeight: 1080,
        videoStreamCount: 1,
        audioStreamCount: 0,
      },
    });

    // The inspector saw exactly the canonical bytes, whole and in order.
    expect(runner.lastRun.seenFileSha256).toBe(sha256Of(object));
    expect(runner.lastRun.seenFileBytes).toBe(4096);
  });

  it("hands the inspector a private path carrying no tenant, storage or provider data", async () => {
    const object = canonicalBytes(256);
    const world = createFakeS3World();
    world.canonical.set(KEY, object);
    const runner = new FakeProcessRunner();
    const validator = new S3ManagedOutputMediaValidator(
      { bucket: BUCKET },
      {
        reader: new FakeS3MultipartClient({ world }),
        probe: new FfprobeMediaProbe({}, { runner }),
      },
    );
    await validator.validate({ destinationKey: KEY, expectedReceipt: receiptFor(object) });

    const path = runner.lastRun.args.at(-1) ?? "";
    expect(basename(path)).toBe("input");
    for (const banned of [
      "org_e2e_mv",
      "sgen_e2e_mv",
      "generations/",
      BUCKET,
      "s3://",
      "fal.media",
      "X-Fal-Signature",
      "http",
      ".mp4",
    ]) {
      expect(path).not.toContain(banned);
    }
    // The whole argument vector is fixed flags plus that one path.
    expect(runner.lastRun.args.slice(0, -1)).toEqual([
      "-v",
      "error",
      "-of",
      "json",
      "-show_format",
      "-show_streams",
    ]);
    // Nothing is left behind.
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
  });

  it("refuses to inspect bytes that are not the ones the receipt describes", async () => {
    // The object at the key was replaced after publication: an integrity
    // problem, reported as such, and the inspector never runs.
    const published = canonicalBytes(512);
    const replaced = canonicalBytes(512).map((v) => v ^ 0xff);
    const world = createFakeS3World();
    world.canonical.set(KEY, replaced);
    const runner = new FakeProcessRunner();
    const validator = new S3ManagedOutputMediaValidator(
      { bucket: BUCKET },
      {
        reader: new FakeS3MultipartClient({ world }),
        probe: new FfprobeMediaProbe({}, { runner }),
      },
    );

    const raw: unknown = await validator.validate({
      destinationKey: KEY,
      expectedReceipt: receiptFor(published),
    });
    expect(parseManagedOutputMediaValidationOutcome(raw)).toEqual({ kind: "INTEGRITY_MISMATCH" });
    expect(runner.runs).toHaveLength(0);
  });

  it("reports INVALID_MEDIA, through the parser, for an object that is not MP4-family", async () => {
    const object = canonicalBytes(128);
    const world = createFakeS3World();
    world.canonical.set(KEY, object);
    const runner = new FakeProcessRunner({
      outcome: {
        kind: "EXITED",
        exitCode: 0,
        stdout: JSON.stringify(ffprobeDocument({ formatName: "matroska,webm" })),
      },
    });
    const validator = new S3ManagedOutputMediaValidator(
      { bucket: BUCKET },
      {
        reader: new FakeS3MultipartClient({ world }),
        probe: new FfprobeMediaProbe({}, { runner }),
      },
    );
    const raw: unknown = await validator.validate({
      destinationKey: KEY,
      expectedReceipt: receiptFor(object),
    });
    expect(parseManagedOutputMediaValidationOutcome(raw)).toEqual({
      kind: "INVALID_MEDIA",
      reason: "CONTAINER_UNSUPPORTED",
    });
  });

  it("every outcome it produces satisfies the domain contract", async () => {
    const object = canonicalBytes(64);
    const world = createFakeS3World();
    world.canonical.set(KEY, object);
    const cases: { runner: FakeProcessRunner; receipt: ManagedOutputVerificationReceipt }[] = [
      { runner: new FakeProcessRunner(), receipt: receiptFor(object) },
      {
        runner: new FakeProcessRunner({ outcome: { kind: "EXITED", exitCode: 3, stdout: "" } }),
        receipt: receiptFor(object),
      },
      {
        runner: new FakeProcessRunner({ outcome: { kind: "TIMED_OUT" } }),
        receipt: receiptFor(object),
      },
      {
        runner: new FakeProcessRunner(),
        receipt: { sha256: sha256Digest("d".repeat(64)), sizeBytes: safePositiveByteCount(64) },
      },
    ];
    for (const { runner, receipt } of cases) {
      const validator = new S3ManagedOutputMediaValidator(
        { bucket: BUCKET },
        {
          reader: new FakeS3MultipartClient({ world }),
          probe: new FfprobeMediaProbe({}, { runner }),
        },
      );
      const raw: unknown = await validator.validate({ destinationKey: KEY, expectedReceipt: receipt });
      // Never `null`: the adapter's output is always within the closed contract.
      expect(parseManagedOutputMediaValidationOutcome(raw)).not.toBeNull();
      // And nothing storage- or process-shaped is in it.
      const text = JSON.stringify(raw);
      for (const banned of ["/tmp", "input", BUCKET, "s3://", "ffprobe", "stderr"]) {
        expect(text).not.toContain(banned);
      }
    }
  });
});
