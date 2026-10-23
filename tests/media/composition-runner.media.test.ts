/**
 * The composition runner end to end, on real FFmpeg (ADR-0079).
 *
 * Every other suite drives the runner through fakes, or one adapter at a time.
 * Here the runner drives the real ones together: the scene materializer, the
 * Clean Master store, the composer, the Clean Master inspector and the video's
 * publisher, against an in-memory object store and a scripted repository whose
 * claim carries composition profile v2 for 16:9 720p. What is proved is what
 * none of those suites can prove alone: the stored master carries no
 * disclosure and the stored video does; each receipt handed to Transaction J2
 * describes the bytes at its key; the video is made from the master that is
 * stored, even when another attempt stored it; a stored master is never
 * encoded again; a stored video costs no encode at all; and every attempt
 * leaves no temporary file behind.
 *
 * The temporary files are `@app/storage/testing`'s with no fault configured,
 * which open real files exclusively at 0600 as production's do.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DeliverableCompositionRunner,
  disclosureLayerFor,
  managedCleanMasterKey,
  managedDeliverableOutputKey,
  managedGenerationOutputKey,
  resolveCompositionProfile,
  safePositiveByteCount,
  sha256Digest,
  type BlockCompositionInput,
  type ClaimCompositionWorkOutcome,
  type CompositionProfile,
  type DeferCompositionInput,
  type DeliverableCompositionClaim,
  type DeliverableCompositionRepository,
  type FinalizeCompositionInput,
  type FinalizeCompositionOutcome,
} from "@app/domain";
import {
  FfprobeCleanMasterInspector,
  FfprobeMediaProbe,
  createCleanMasterStore,
  createDeliverableCompositionSourceMaterializer,
  createDeliverableOutputPublisher,
  createFfmpegDeliverableComposer,
  type DeliverableObjectClient,
  type ProcessRunner,
  type S3GetObjectInput,
  type S3GetObjectResult,
} from "@app/storage";
import { FakeManagedOutputTempFiles } from "@app/storage/testing";
import { decodeFrame, decodeRgba, ffmpeg, probeStreams, runner } from "./media-tools";

const LAYER_DIRECTORY = fileURLToPath(new URL("../../assets/disclosure", import.meta.url));

const ORG = "org_media";
const VERSION = "gdv_media";
const BUCKET = "managed-output-bucket";
const NOW = 1_700_000_000_000;

const PROFILE: CompositionProfile = (() => {
  const outcome = resolveCompositionProfile({ targetAspectRatio: "16:9", targetOutputResolution: "720p" });
  if (outcome.kind !== "RESOLVED") throw new Error("16:9 720p resolves");
  return outcome.profile;
})();
const { targetWidthPx: WIDTH, targetHeightPx: HEIGHT } = PROFILE;

const OUTPUT_KEY = managedDeliverableOutputKey({ organizationId: ORG, deliverableVersionId: VERSION });
const MASTER_KEY = managedCleanMasterKey({ organizationId: ORG, deliverableVersionId: VERSION });

// Two scenes: a blue 16:9 clip for two seconds, then a red 9:16 clip for one.
const SCENE_SECONDS = [2, 1] as const;
const FRAME_COUNT = (SCENE_SECONDS[0] + SCENE_SECONDS[1]) * 30;
/** Half a second in: the first scene, blue across the whole frame. */
const SAMPLED_FRAME = 15;

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * An object store in memory, first-wins as the real adapter's conditional
 * create is. It records what it is asked rather than asserting it: the adapters
 * turn a thrown error into a retryable answer, which would hide the reason.
 */
class MemoryObjectStore implements DeliverableObjectClient {
  readonly objects = new Map<string, Uint8Array>();
  readonly reads: string[] = [];
  readonly buckets = new Set<string>();
  readonly contentTypes = new Set<string>();
  /** Keys whose next store fails, as an unreachable bucket would. */
  readonly refuseNextPut = new Set<string>();

  async getObject(input: S3GetObjectInput): Promise<S3GetObjectResult> {
    this.buckets.add(input.bucket);
    this.reads.push(input.key);
    const bytes = this.objects.get(input.key);
    if (bytes === undefined) return { contentLength: null, body: null };
    // In 64 KiB chunks, so every reader streams rather than seeing one buffer.
    let offset = 0;
    return {
      contentLength: bytes.byteLength,
      body: {
        read: async () => {
          if (offset >= bytes.byteLength) return null;
          const chunk = bytes.subarray(offset, offset + 65_536);
          offset += chunk.byteLength;
          return chunk;
        },
        cancel: async () => undefined,
      },
    };
  }

  async putObjectIfAbsent(input: {
    readonly bucket: string;
    readonly key: string;
    readonly localPath: string;
    readonly contentType: string;
  }): Promise<{ readonly kind: "CREATED" | "ALREADY_EXISTS" }> {
    this.buckets.add(input.bucket);
    this.contentTypes.add(input.contentType);
    if (this.refuseNextPut.delete(input.key)) throw new Error("store unreachable");
    if (this.objects.has(input.key)) return { kind: "ALREADY_EXISTS" };
    this.objects.set(input.key, new Uint8Array(await readFile(input.localPath)));
    return { kind: "CREATED" };
  }

  sceneReads(): number {
    return this.reads.filter((key) => key.includes("/generations/")).length;
  }
}

/** The database's side, scripted: one candidate, always claimable, recording what it is asked. */
class ScriptedRepository implements DeliverableCompositionRepository {
  readonly finalized: FinalizeCompositionInput[] = [];
  readonly deferred: DeferCompositionInput[] = [];
  readonly blocked: BlockCompositionInput[] = [];
  /** The answers the finalizes get, in order; FINALIZED once they run out. */
  readonly finalizeAnswers: FinalizeCompositionOutcome["kind"][] = [];

  constructor(private readonly claim: DeliverableCompositionClaim) {}

  async findCompositionCandidates() {
    return [{ organizationId: ORG, generationJobId: this.claim.generationJobId, deliverableVersionId: VERSION }];
  }

  async claimCompositionWork(): Promise<ClaimCompositionWorkOutcome> {
    return { kind: "CLAIMED", claim: this.claim };
  }

  async finalizeComposition(input: FinalizeCompositionInput): Promise<FinalizeCompositionOutcome> {
    this.finalized.push(input);
    return { kind: this.finalizeAnswers.shift() ?? "FINALIZED" };
  }

  async deferComposition(input: DeferCompositionInput) {
    this.deferred.push(input);
    return { kind: "DEFERRED" as const };
  }

  async blockComposition(input: BlockCompositionInput) {
    this.blocked.push(input);
    return { kind: "BLOCKED" as const };
  }

  async findCompositionByVersionId() {
    return null;
  }
}

let dir: string;
let blueClip: Uint8Array;
let redClip: Uint8Array;
let greenMaster: Uint8Array;
let greenMaster1080p: Uint8Array;
let temp: string;
let originalTmpdir: string | undefined;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "media-runner-"));
  const blue = join(dir, "blue.mp4");
  const red = join(dir, "red.mp4");
  const green = join(dir, "green.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=640x360:r=25:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", blue]);
  await ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=360x640:r=24:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", red]);
  await ffmpeg(["-f", "lavfi", "-i", "color=c=green:s=640x360:r=30:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", green]);
  blueClip = new Uint8Array(await readFile(blue));
  redClip = new Uint8Array(await readFile(red));
  // A master another attempt could have stored: the right size, rate and
  // length, but green, so a video made from it cannot be mistaken for one
  // made from the scenes.
  // And one of another frame size, which no 720p video may be made from.
  const masterOf = async (profile: CompositionProfile, name: string): Promise<Uint8Array> => {
    const path = join(dir, name);
    const encoded = await createFfmpegDeliverableComposer({ runner }).composeCleanMaster({
      clips: [{ localPath: green, durationSeconds: 3 }],
      profile,
      outputPath: path,
    });
    expect(encoded).toEqual({ kind: "SUCCESS" });
    return new Uint8Array(await readFile(path));
  };
  greenMaster = await masterOf(PROFILE, "green-master.mp4");
  const landscape1080p = resolveCompositionProfile({ targetAspectRatio: "16:9", targetOutputResolution: "1080p" });
  if (landscape1080p.kind !== "RESOLVED") throw new Error("16:9 1080p resolves");
  greenMaster1080p = await masterOf(landscape1080p.profile, "green-master-1080p.mp4");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Each attempt's directories are made under a temporary root of the test's own,
// so whatever an attempt leaves behind is visible.
beforeEach(async () => {
  temp = await mkdtemp(join(dir, "tmp-"));
  originalTmpdir = process.env["TMPDIR"];
  process.env["TMPDIR"] = temp;
});

afterEach(() => {
  if (originalTmpdir === undefined) delete process.env["TMPDIR"];
  else process.env["TMPDIR"] = originalTmpdir;
});

function claimOf(): DeliverableCompositionClaim {
  const scenes = [blueClip, redClip].map((bytes, index) => {
    const attemptId = `sg_media_${index + 1}`;
    return {
      position: index + 1,
      generationSceneId: `gs_media_${index + 1}`,
      sceneGenerationAttemptId: attemptId,
      sourceStorageKey: managedGenerationOutputKey({ organizationId: ORG, attemptId }),
      sourceSha256: sha256Digest(sha256Of(bytes)),
      sourceSizeBytes: safePositiveByteCount(bytes.byteLength),
      durationSeconds: SCENE_SECONDS[index]!,
    };
  });
  return {
    organizationId: ORG,
    generationJobId: "job_media",
    deliverableVersionId: VERSION,
    compositionId: "gdcmp_media",
    leaseToken: "clease_media",
    version: 1,
    attemptCount: 1,
    profile: PROFILE,
    outputStorageKey: OUTPUT_KEY,
    disclosureMode: "THROUGHOUT",
    cleanMasterStorageKey: MASTER_KEY,
    requestedDurationSeconds: SCENE_SECONDS[0] + SCENE_SECONDS[1],
    scenes,
  };
}

/** The runner on the real adapters, and what it ran. */
function harness(options: { readonly withScenes: boolean }) {
  const store = new MemoryObjectStore();
  const claim = claimOf();
  if (options.withScenes) {
    store.objects.set(claim.scenes[0]!.sourceStorageKey, blueClip);
    store.objects.set(claim.scenes[1]!.sourceStorageKey, redClip);
  }
  const repository = new ScriptedRepository(claim);
  /** Every program the composer and the inspector launched, in order. */
  const launched: string[] = [];
  /** Every file those programs were given to read or write. */
  const files: string[] = [];
  const counting: ProcessRunner = {
    run: (input) => {
      launched.push(input.program);
      input.args.forEach((arg, index) => {
        if (input.args[index - 1] === "-i") files.push(arg);
      });
      files.push(input.args.at(-1)!);
      return runner.run(input);
    },
  };
  const tempFiles = new FakeManagedOutputTempFiles();
  const io = { client: store, tempFiles };
  let now = NOW;
  const composition = new DeliverableCompositionRunner({
    repository,
    materializer: createDeliverableCompositionSourceMaterializer(io, { bucket: BUCKET }),
    composer: createFfmpegDeliverableComposer({ runner: counting }, { disclosureLayerDirectory: LAYER_DIRECTORY }),
    publisher: createDeliverableOutputPublisher(io, { bucket: BUCKET }),
    cleanMasterStore: createCleanMasterStore(io, { bucket: BUCKET }),
    cleanMasterInspector: new FfprobeCleanMasterInspector({}, { runner: counting }),
    clock: () => (now += 1_000),
    context: () => ({
      eventType: "test",
      actorType: "SYSTEM",
      actorUserId: null,
      reasonCode: "TEST",
      correlationId: "corr_media",
      causationId: null,
      metadata: {},
    }),
  });
  return { store, repository, launched, files, tempFiles, run: () => composition.runOnce(1) };
}

/** The bytes at `key`, written to a file of this suite's for FFmpeg to read. */
async function storedFile(store: MemoryObjectStore, key: string, name: string): Promise<string> {
  const bytes = store.objects.get(key);
  expect(`${key}: ${bytes !== undefined}`).toBe(`${key}: true`);
  const path = join(dir, `${name}-${Math.random().toString(16).slice(2)}.mp4`);
  await writeFile(path, bytes!);
  return path;
}

type Rgb = readonly [number, number, number];
const pixelAt = (frame: Buffer, at: number): Rgb => [frame[at * 3] ?? -1, frame[at * 3 + 1] ?? -1, frame[at * 3 + 2] ?? -1];
const luma = ([r, g, b]: Rgb): number => 0.299 * r + 0.587 * g + 0.114 * b;
const isBlue = ([r, g, b]: Rgb): boolean => r <= 40 && g <= 40 && b >= 200;
const isGreen = ([r, g, b]: Rgb): boolean => r <= 40 && g >= 100 && b <= 40;

/** The frame's pixels under the disclosure's text: white in its image, at alpha 128 or more. */
async function inkPixels(): Promise<number[]> {
  const image = await decodeRgba(dir, join(LAYER_DIRECTORY, disclosureLayerFor(WIDTH, HEIGHT)!.fileName));
  const ink: number[] = [];
  for (let at = 0; at < WIDTH * HEIGHT; at += 1) {
    if ((image[at * 4 + 3] ?? 0) >= 128 && (image[at * 4] ?? 0) >= 200) ink.push(at);
  }
  expect(ink.length).toBeGreaterThan(100);
  return ink;
}

/** The mean luma of `frame` over `pixels`. */
function meanLuma(frame: Buffer, pixels: readonly number[]): number {
  let total = 0;
  for (const at of pixels) total += luma(pixelAt(frame, at));
  return total / pixels.length;
}

/**
 * What each attempt must leave behind: nothing. Only meaningful if every file
 * it made was under the test's temporary root, so that is checked first: each
 * file a program read or wrote, and each the adapters opened.
 */
async function expectNoTemporaryFiles(h: ReturnType<typeof harness>): Promise<void> {
  const made = [...h.files, ...h.tempFiles.openedPaths];
  expect(made.length).toBeGreaterThan(0);
  expect(made.filter((path) => !path.startsWith(temp + sep))).toEqual([]);
  expect(await readdir(temp)).toEqual([]);
  expect([...h.store.buckets]).toEqual([BUCKET]);
  expect([...h.store.contentTypes].filter((type) => type !== "video/mp4")).toEqual([]);
}

/** Both receipts handed to J2 describe the bytes stored at their keys. */
function expectReceiptsOfStoredBytes(store: MemoryObjectStore, finalize: FinalizeCompositionInput): void {
  const video = store.objects.get(OUTPUT_KEY)!;
  const master = store.objects.get(MASTER_KEY)!;
  expect(finalize.outputSha256).toBe(sha256Of(video));
  expect(finalize.outputSizeBytes).toBe(video.byteLength);
  expect(finalize.cleanMaster.sha256).toBe(sha256Of(master));
  expect(finalize.cleanMaster.sizeBytes).toBe(master.byteLength);
  expect(sha256Of(video)).not.toBe(sha256Of(master));
}

describe("the runner on real FFmpeg", () => {
  it("makes the master from the scenes, then the customer's video from the stored master, and hands J2 both receipts", async () => {
    // Here the stored master is this attempt's own encode, byte for byte, so
    // this test cannot tell the stored copy from the encoder's file; the next
    // two, whose master another attempt stored, are what prove the video is
    // made from the stored bytes.
    const h = harness({ withScenes: true });
    const { store, repository, launched, run } = h;

    expect(await run()).toMatchObject({ considered: 1, claimed: 1, finalized: 1, failed: 0 });
    // The master's encode, its inspection, then the disclosure's encode.
    expect(launched).toEqual(["ffmpeg", "ffprobe", "ffmpeg"]);
    expect(repository.finalized).toHaveLength(1);
    expectReceiptsOfStoredBytes(store, repository.finalized[0]!);
    expect([...store.objects.keys()].sort()).toEqual(
      [MASTER_KEY, OUTPUT_KEY, ...claimOf().scenes.map((scene) => scene.sourceStorageKey)].sort(),
    );
    await expectNoTemporaryFiles(h);

    const master = await storedFile(store, MASTER_KEY, "master");
    const video = await storedFile(store, OUTPUT_KEY, "video");
    for (const path of [master, video]) {
      expect(await new FfprobeCleanMasterInspector({}, { runner }).inspect({ localPath: path })).toEqual({
        kind: "RASTER",
        raster: { widthPx: WIDTH, heightPx: HEIGHT, frameRateNumerator: 30, frameRateDenominator: 1 },
      });
      expect(await new FfprobeMediaProbe({}, { runner }).probe(path)).toMatchObject({
        kind: "FACTS",
        facts: { durationMs: (SCENE_SECONDS[0] + SCENE_SECONDS[1]) * 1000, audioStreamCount: 0 },
      });
      expect((await probeStreams(path)).video[0]?.nb_frames).toBe(String(FRAME_COUNT));
    }

    // Where the disclosure's text is, the master shows the scene and the
    // customer's video shows the text.
    const ink = await inkPixels();
    const [masterFrame, videoFrame] = await Promise.all([
      decodeFrame(dir, master, SAMPLED_FRAME),
      decodeFrame(dir, video, SAMPLED_FRAME),
    ]);
    expect(ink.every((at) => isBlue(pixelAt(masterFrame, at)))).toBe(true);
    // About 125 apart on FFmpeg 6.1: white at 70% over blue, against blue.
    expect(meanLuma(videoFrame, ink) - meanLuma(masterFrame, ink)).toBeGreaterThan(80);
  });

  it("makes the customer's video from a master another attempt stored, reading no scene and encoding no master", async () => {
    // No scene is stored: a runner that went to the scenes would defer.
    const h = harness({ withScenes: false });
    const { store, repository, launched, run } = h;
    store.objects.set(MASTER_KEY, greenMaster);

    expect(await run()).toMatchObject({ finalized: 1, deferred: 0, failed: 0 });
    expect(launched).toEqual(["ffprobe", "ffmpeg"]);
    expect(store.sceneReads()).toBe(0);
    expect(store.objects.get(MASTER_KEY)).toBe(greenMaster);
    expect(repository.finalized[0]!.cleanMaster.sha256).toBe(sha256Of(greenMaster));
    expectReceiptsOfStoredBytes(store, repository.finalized[0]!);
    await expectNoTemporaryFiles(h);

    // The video is the stored master's picture, with the disclosure over it.
    const ink = new Set(await inkPixels());
    const frame = await decodeFrame(dir, await storedFile(store, OUTPUT_KEY, "video"), SAMPLED_FRAME);
    const centre = (HEIGHT / 2) * WIDTH + WIDTH / 2;
    expect(ink.has(centre)).toBe(false);
    expect(isGreen(pixelAt(frame, centre))).toBe(true);
  });

  it("after the video's store fails, makes the video again from the stored master without encoding it again", async () => {
    const h = harness({ withScenes: true });
    const { store, repository, launched, run } = h;
    store.refuseNextPut.add(OUTPUT_KEY);

    expect(await run()).toMatchObject({ finalized: 0, deferred: 1, failed: 0 });
    expect(repository.deferred.map((one) => one.retryCode)).toEqual(["OUTPUT_PUBLISH_RETRYABLE"]);
    expect(store.objects.has(OUTPUT_KEY)).toBe(false);
    const master = store.objects.get(MASTER_KEY)!;
    const sceneReads = store.sceneReads();
    expect(sceneReads).toBe(2);
    await expectNoTemporaryFiles(h);

    launched.length = 0;
    expect(await run()).toMatchObject({ finalized: 1, failed: 0 });
    // Only the inspection and the disclosure's encode: the scenes are not read
    // again, and the stored master is the one the video is made from.
    expect(launched).toEqual(["ffprobe", "ffmpeg"]);
    expect(store.sceneReads()).toBe(sceneReads);
    expect(store.objects.get(MASTER_KEY)).toBe(master);
    expectReceiptsOfStoredBytes(store, repository.finalized[0]!);
    await expectNoTemporaryFiles(h);
  });

  it("blocks on a stored master of another frame size, making no video", async () => {
    const h = harness({ withScenes: true });
    const { store, repository, launched, run } = h;
    store.objects.set(MASTER_KEY, greenMaster1080p);

    expect(await run()).toMatchObject({ blocked: 1, finalized: 0, deferred: 0, failed: 0 });
    expect(repository.blocked.map((one) => one.blockCode)).toEqual(["CLEAN_MASTER_UNUSABLE"]);
    // Read by the real inspector as 1920x1080, and nothing encoded after it.
    expect(launched).toEqual(["ffprobe"]);
    expect(store.sceneReads()).toBe(0);
    expect(store.objects.has(OUTPUT_KEY)).toBe(false);
    expect(store.objects.get(MASTER_KEY)).toBe(greenMaster1080p);
    await expectNoTemporaryFiles(h);
  });

  it("finalizes a stored video against both stored receipts, launching nothing", async () => {
    const h = harness({ withScenes: true });
    const { store, repository, launched, run } = h;
    // The first attempt stores both, then loses its lease before J2 commits.
    repository.finalizeAnswers.push("LEASE_LOST");
    expect(await run()).toMatchObject({ leaseLost: 1, failed: 0 });
    const first = repository.finalized[0]!;
    const sceneReads = store.sceneReads();

    launched.length = 0;
    expect(await run()).toMatchObject({ finalized: 1, failed: 0 });
    expect(launched).toEqual([]);
    expect(store.sceneReads()).toBe(sceneReads);
    const second = repository.finalized[1]!;
    expectReceiptsOfStoredBytes(store, second);
    expect([second.outputSha256, second.cleanMaster.sha256]).toEqual([first.outputSha256, first.cleanMaster.sha256]);
    await expectNoTemporaryFiles(h);
  });
});
