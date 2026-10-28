/**
 * The test provider makes a real clip from the scene's photo, on real FFmpeg
 * (GS-6, ADR-0092), and the clip goes through the same copy and checks as a
 * real provider's.
 *
 * The photo is one flat colour, 4:3, so where the picture is can be read from
 * single pixels: fitted whole into a 16:9 frame it leaves black at both sides,
 * and as the view zooms in and drifts right the left-hand black narrows.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildAssetStorageKey,
  managedGenerationOutputKey,
  parseManagedOutputMediaValidationOutcome,
  type ManagedOutputVerificationReceipt,
} from "@app/domain";
import {
  FfprobeMediaProbe,
  S3ManagedOutputMediaValidator,
  S3ManagedOutputStagingSink,
  SHARED_FOLDER_STORAGE_BUCKET,
  SharpImageProcessor,
  StreamingManagedOutputTransfer,
  createFfmpegFakeClipRenderer,
  createSharedFolderStorage,
  verifyStorageToken,
} from "@app/storage";
import {
  FAKE_VIDEO_MODEL_ID,
  FakeVideoProvider,
  createFakeClipStudio,
  type FakeSourcePhotoReader,
  type ProviderGenerationInput,
} from "@app/video-providers";
import { decodeFrame, ffmpeg, probeStreams, runner } from "./media-tools";

const DEV = { NODE_ENV: "test", VIDEO_PROVIDER: "fake" } as const;
const SECRET = "media-suite-signing-secret-0123456789";
const ORG = "org_media_fake_clip";

let dir: string;
let photo: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-fake-clip-"));
  photo = join(dir, "photo.jpg");
  await ffmpeg([
    "-f", "lavfi", "-i", "color=c=0xC87832:s=1024x768:d=1",
    "-frames:v", "1", "-c:v", "mjpeg", "-f", "image2", photo,
  ]);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function request(overrides: Partial<ProviderGenerationInput>): ProviderGenerationInput {
  return {
    modelId: FAKE_VIDEO_MODEL_ID,
    sourceImageUrl: "unused",
    prompt: "A slow push into the room",
    durationSeconds: 5,
    aspectRatio: "16:9",
    nativeGenerationResolution: "720p",
    requestHash: `sha256:v2:${"c".repeat(64)}`,
    ...overrides,
  };
}

/** The colour of one pixel of packed RGB. */
function pixel(frame: Buffer, width: number, x: number, y: number): readonly [number, number, number] {
  const at = (y * width + x) * 3;
  return [frame[at] ?? -1, frame[at + 1] ?? -1, frame[at + 2] ?? -1];
}

function isBlack(rgb: readonly [number, number, number]): boolean {
  return rgb.every((channel) => channel <= 24);
}

function isPhoto(rgb: readonly [number, number, number]): boolean {
  const [r, g, b] = rgb;
  return Math.abs(r - 0xc8) <= 24 && Math.abs(g - 0x78) <= 24 && Math.abs(b - 0x32) <= 24;
}

describe("the FFmpeg clip maker", () => {
  it("makes a 5-second 720p H.264 clip, with no sound, that shows the whole photo and then moves", async () => {
    const clip = join(dir, "clip.mp4");
    const renderer = createFfmpegFakeClipRenderer({ runner });
    const outcome = await renderer.render({
      photoPath: photo,
      outputPath: clip,
      widthPx: 1280,
      heightPx: 720,
      durationSeconds: 5,
    });
    expect(outcome).toEqual({ kind: "RENDERED" });

    const { video, audioCount } = await probeStreams(clip);
    expect(audioCount).toBe(0);
    expect(video).toHaveLength(1);
    expect(video[0]).toMatchObject({
      codec_name: "h264",
      pix_fmt: "yuv420p",
      avg_frame_rate: "30/1",
      nb_frames: "150",
    });

    const first = await decodeFrame(dir, clip, 0);
    const last = await decodeFrame(dir, clip, 149);
    expect(first.byteLength).toBe(1280 * 720 * 3);
    // The 4:3 photo fitted whole, not zoomed yet: 960 wide from x = 160, black
    // either side of it.
    expect(isBlack(pixel(first, 1280, 150, 360))).toBe(true);
    expect(isPhoto(pixel(first, 1280, 170, 360))).toBe(true);
    expect(isPhoto(pixel(first, 1280, 640, 360))).toBe(true);
    expect(isPhoto(pixel(first, 1280, 1110, 360))).toBe(true);
    expect(isBlack(pixel(first, 1280, 1130, 360))).toBe(true);
    // Zoomed in and drifted right: the photo now covers where the black was.
    expect(isPhoto(pixel(last, 1280, 100, 360))).toBe(true);
    expect(isBlack(pixel(last, 1280, 1200, 360))).toBe(true);
  });

  it("reports a photo it cannot read as the clip not made", async () => {
    const outcome = await createFfmpegFakeClipRenderer({ runner }).render({
      photoPath: join(dir, "missing.jpg"),
      outputPath: join(dir, "never.mp4"),
      widthPx: 1280,
      heightPx: 720,
      durationSeconds: 5,
    });
    expect(outcome).toEqual({ kind: "FAILED" });
  });
});

describe("a clip from the photo in storage to a checked copy in storage", () => {
  it("is made at the HQ portrait frame, copied, and accepted as video", async () => {
    const storage = createSharedFolderStorage({ root: join(dir, "storage"), secret: SECRET });
    const photoKey = buildAssetStorageKey({
      organizationId: ORG,
      propertyId: "prop_media",
      assetId: "asset_media",
      variant: "normalized",
      extension: "jpg",
    });
    // Stored as an upload's normalized photo is: re-encoded by the image pipeline.
    const normalized = await new SharpImageProcessor().process(new Uint8Array(await readFile(photo)));
    await storage.objectStorage.putObject(photoKey, normalized.normalized);
    const signed = await storage.objectStorage.createSignedDownloadUrl(photoKey, 300);

    // The provider reads the photo the way the download route serves it.
    const photos: FakeSourcePhotoReader = {
      async read(signedUrl) {
        const token = new URL(signedUrl, "http://localhost").searchParams.get("token");
        const verified = token === null ? null : verifyStorageToken(token, SECRET, "download");
        return verified === null ? null : storage.objectStorage.getObject(verified.key);
      },
    };
    const studio = createFakeClipStudio(
      DEV,
      { root: join(dir, "studio") },
      { renderer: createFfmpegFakeClipRenderer({ runner }), photos },
    );

    const input = request({ sourceImageUrl: signed.url, aspectRatio: "9:16", nativeGenerationResolution: "1080p" });
    const submitted = await new FakeVideoProvider({ studio }).createGeneration(input);
    if (submitted.kind !== "ACCEPTED") throw new Error(`expected ACCEPTED, got ${submitted.kind}`);

    const observation = await studio.statusSource.poll({
      providerName: submitted.ref.provider,
      providerModelId: submitted.ref.modelId,
      providerPredictionId: submitted.ref.predictionId,
    });
    if (observation.kind !== "SUCCEEDED" || observation.outputLocator === null) {
      throw new Error("expected a clip to fetch");
    }

    const destinationKey = managedGenerationOutputKey({ organizationId: ORG, attemptId: "sgen_media_fake_clip" });
    const transfer = new StreamingManagedOutputTransfer(
      { maxBytes: 64 * 1024 * 1024 },
      {
        source: studio.byteSource,
        staging: new S3ManagedOutputStagingSink(
          { bucket: SHARED_FOLDER_STORAGE_BUCKET },
          { client: storage.objectClient },
        ),
      },
    );
    const copied = await transfer.transferAndVerify({ source: observation.outputLocator, destinationKey });
    if (copied.kind !== "VERIFIED") throw new Error("expected the copy to be verified");

    const validator = new S3ManagedOutputMediaValidator(
      { bucket: SHARED_FOLDER_STORAGE_BUCKET },
      { reader: storage.objectClient, probe: new FfprobeMediaProbe({}, { runner }) },
    );
    const verdict = parseManagedOutputMediaValidationOutcome(
      await validator.validate({ destinationKey, expectedReceipt: copied.receipt as ManagedOutputVerificationReceipt }),
    );
    expect(verdict).toMatchObject({
      kind: "VALID",
      facts: { container: "ISO_BMFF", videoWidth: 1080, videoHeight: 1920, videoStreamCount: 1, audioStreamCount: 0 },
    });
    if (verdict?.kind !== "VALID") throw new Error("expected valid media");
    expect(Math.abs(verdict.facts.durationMs - 5_000)).toBeLessThanOrEqual(50);
  });
});
