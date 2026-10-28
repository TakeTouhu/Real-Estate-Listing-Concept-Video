import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProviderOutputByteStreamRetryableFailure,
  TransientProviderOutputLocator,
  parseProviderPollObservation,
  type ProviderCompletionStatusSource,
  type ProviderOutputByteSource,
  type ProviderStatusLookupRef,
} from "@app/domain";
import { AppError } from "@app/shared";
import { ProviderErrorException } from "../errors";
import type { ProviderGenerationInput } from "../types";
import {
  createFakeClipStudio,
  type FakeClipRenderer,
  type FakeClipStudio,
  type FakeSourcePhotoReader,
} from "./clip-studio";
import { FakeVideoProvider } from "./fake-provider";
import { FAKE_VIDEO_MODEL_ID } from "./route-kit";

/**
 * How often each file the studio opened was let go of. Its handles are not
 * reachable from outside, so `open` is passed through and each handle counted.
 */
const handleCloses = vi.hoisted((): number[] => []);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const close = handle.close.bind(handle);
      const at = handleCloses.push(0) - 1;
      handle.close = () => {
        handleCloses[at] = (handleCloses[at] ?? 0) + 1;
        return close();
      };
      return handle;
    },
  };
});

const DEV = { NODE_ENV: "test", VIDEO_PROVIDER: "fake" } as const;
const URL = "/api/storage/download?token=signed";
const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
const CLIP = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 9, 8, 7]);
const HASH = `sha256:v2:${"a".repeat(64)}`;

type Behaviour = "RENDER" | "FAIL" | "THROW" | "WRITE_NOTHING" | "WRITE_EMPTY" | "FAIL_AFTER_WRITING";

class RecordingRenderer implements FakeClipRenderer {
  readonly jobs: { widthPx: number; heightPx: number; durationSeconds: number; photo: Uint8Array }[] = [];
  readonly photoModes: number[] = [];

  constructor(
    private readonly behaviour: Behaviour = "RENDER",
    private readonly clip: Uint8Array = CLIP,
    /** Waited on before the clip is written, so a test can hold two renders at once. */
    private readonly hold: () => Promise<void> = () => Promise.resolve(),
  ) {}

  async render(job: Parameters<FakeClipRenderer["render"]>[0]) {
    const { widthPx, heightPx, durationSeconds } = job;
    this.jobs.push({ widthPx, heightPx, durationSeconds, photo: new Uint8Array(await readFile(job.photoPath)) });
    this.photoModes.push((await stat(job.photoPath)).mode & 0o777);
    await this.hold();
    if (this.behaviour === "THROW") throw new Error("renderer broke");
    if (this.behaviour === "FAIL") return { kind: "FAILED" } as const;
    if (this.behaviour === "RENDER" || this.behaviour === "FAIL_AFTER_WRITING") {
      await writeFile(job.outputPath, this.clip);
    }
    if (this.behaviour === "WRITE_EMPTY") await writeFile(job.outputPath, new Uint8Array());
    return this.behaviour === "FAIL_AFTER_WRITING" ? ({ kind: "FAILED" } as const) : ({ kind: "RENDERED" } as const);
  }
}

const CLIP_NAME = `${createHash("sha256").update(`fake_${HASH}`).digest("hex")}.mp4`;

function photosAt(url: string, photo: Uint8Array | null = PHOTO): FakeSourcePhotoReader & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async read(signedUrl: string) {
      urls.push(signedUrl);
      return signedUrl === url ? photo : null;
    },
  };
}

function request(overrides: Partial<ProviderGenerationInput> = {}): ProviderGenerationInput {
  return {
    modelId: FAKE_VIDEO_MODEL_ID,
    sourceImageUrl: URL,
    prompt: "A slow push into the living room",
    durationSeconds: 5,
    aspectRatio: "16:9",
    nativeGenerationResolution: "720p",
    requestHash: HASH,
    ...overrides,
  };
}

function ref(overrides: Partial<ProviderStatusLookupRef> = {}): ProviderStatusLookupRef {
  return {
    providerName: "fake",
    providerModelId: FAKE_VIDEO_MODEL_ID,
    providerPredictionId: `fake_${HASH}`,
    ...overrides,
  };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fake-clip-studio-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function studio(
  renderer: FakeClipRenderer = new RecordingRenderer(),
  photos: FakeSourcePhotoReader = photosAt(URL),
): FakeClipStudio {
  return createFakeClipStudio(DEV, { root }, { renderer, photos });
}

/** Everything the studio keeps: its clips, and any work folder it left behind. */
async function kept(): Promise<{ clips: string[]; others: string[] }> {
  return {
    clips: await readdir(join(root, "clips")),
    others: (await readdir(root)).filter((name) => name !== "clips"),
  };
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return chunks;
}

async function locatorFor(made: FakeClipStudio, at = ref()): Promise<TransientProviderOutputLocator> {
  const observation = await made.statusSource.poll(at);
  if (observation.kind !== "SUCCEEDED" || observation.outputLocator === null) throw new Error("expected a clip");
  return observation.outputLocator;
}

function refusal(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected the studio to be refused");
}

describe("building the studio", () => {
  const deps = { renderer: new RecordingRenderer(), photos: photosAt(URL) };

  it("is refused in production, with no override", () => {
    const production = { NODE_ENV: "production", VIDEO_PROVIDER: "fake" } as const;
    expect(refusal(() => createFakeClipStudio(production, { root }, deps)).code).toBe("CONFIGURATION_ERROR");
  });

  it("is refused when the process runs in production, whatever it is told", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(refusal(() => createFakeClipStudio(DEV, { root }, deps)).code).toBe("CONFIGURATION_ERROR");
  });

  it.each(["wavespeed", "fal", ""])("is refused unless the test provider is the configured provider: %j", (name) => {
    const configured = { NODE_ENV: "test" as const, VIDEO_PROVIDER: name as "wavespeed" };
    expect(refusal(() => createFakeClipStudio(configured, { root }, deps)).code).toBe("CONFIGURATION_ERROR");
  });

  it("is refused a folder that is not absolute, or cannot be opened", async () => {
    expect(refusal(() => createFakeClipStudio(DEV, { root: "studio" }, deps)).code).toBe("CONFIGURATION_ERROR");
    await writeFile(join(root, "file"), "x");
    const error = refusal(() => createFakeClipStudio(DEV, { root: join(root, "file") }, deps));
    expect(error.message).not.toContain(root);
  });
});

describe("making a clip", () => {
  it("makes it from the photo behind the request's URL, at its native frame and length, and keeps it", async () => {
    const renderer = new RecordingRenderer();
    const photos = photosAt(URL);
    expect(await studio(renderer, photos).make(request())).toBe("MADE");
    expect(photos.urls).toEqual([URL]);
    expect(renderer.jobs).toEqual([{ widthPx: 1280, heightPx: 720, durationSeconds: 5, photo: PHOTO }]);
    // The photo is written for the renderer alone.
    expect(renderer.photoModes).toEqual([0o600]);
    expect(await kept()).toEqual({ clips: [CLIP_NAME], others: [] });
    expect(new Uint8Array(await readFile(join(root, "clips", CLIP_NAME)))).toEqual(CLIP);
  });

  it.each([
    ["9:16", "1080p", 1080, 1920],
    ["1:1", "720p", 720, 720],
    ["16:9", "1080p", 1920, 1080],
  ])("makes a %s %s clip at %i×%i", async (aspectRatio, nativeGenerationResolution, widthPx, heightPx) => {
    const renderer = new RecordingRenderer();
    await studio(renderer).make(request({ aspectRatio, nativeGenerationResolution, durationSeconds: 15 }));
    expect(renderer.jobs[0]).toMatchObject({ widthPx, heightPx, durationSeconds: 15 });
  });

  it("makes each request's clip once", async () => {
    const renderer = new RecordingRenderer();
    const made = studio(renderer);
    expect(await made.make(request())).toBe("MADE");
    expect(await made.make(request())).toBe("MADE");
    expect(renderer.jobs).toHaveLength(1);
  });

  it("lets the first of two makes of one request stand, and both say made", async () => {
    let release: () => void = () => undefined;
    const bothRendering = new Promise<void>((resolve) => {
      release = resolve;
    });
    const renderer: RecordingRenderer = new RecordingRenderer("RENDER", CLIP, async () => {
      if (renderer.jobs.length === 2) release();
      await bothRendering;
    });
    const made = studio(renderer);
    expect(await Promise.all([made.make(request()), made.make(request())])).toEqual(["MADE", "MADE"]);
    expect(renderer.jobs).toHaveLength(2);
    expect(await kept()).toEqual({ clips: [CLIP_NAME], others: [] });
  });

  it("does not count a kept file that is not a clip as made", async () => {
    const made = studio();
    await writeFile(join(root, "clips", CLIP_NAME), new Uint8Array());
    expect(await made.make(request())).toBe("NOT_MADE");
    expect(await kept()).toEqual({ clips: [CLIP_NAME], others: [] });
  });

  it("makes nothing when the clip cannot be kept", async () => {
    const made = studio();
    await rm(join(root, "clips"), { recursive: true });
    expect(await made.make(request())).toBe("NOT_MADE");
    expect(await readdir(root)).toEqual([]);
  });

  it.each<[string, Partial<ProviderGenerationInput>]>([
    ["another model", { modelId: "wavespeed-ai/open-video/image-to-video" }],
    ["no length", { durationSeconds: 0 }],
    ["more than a minute", { durationSeconds: 61 }],
    ["a fractional length", { durationSeconds: 5.5 }],
    ["a shape it has no frame for", { aspectRatio: "4:3" }],
    ["a size it has no frame for", { nativeGenerationResolution: "480p" }],
    ["a photo it cannot read", { sourceImageUrl: "/api/storage/download?token=other" }],
  ])("makes and keeps nothing for %s", async (_, change) => {
    const renderer = new RecordingRenderer();
    expect(await studio(renderer).make(request(change))).toBe("NOT_MADE");
    expect(renderer.jobs).toEqual([]);
    expect(await kept()).toEqual({ clips: [], others: [] });
  });

  it("makes nothing from an empty photo, or when reading the photo fails", async () => {
    expect(await studio(new RecordingRenderer(), photosAt(URL, new Uint8Array())).make(request())).toBe("NOT_MADE");
    const broken: FakeSourcePhotoReader = { read: () => Promise.reject(new Error("unreachable")) };
    expect(await studio(new RecordingRenderer(), broken).make(request())).toBe("NOT_MADE");
    expect(await kept()).toEqual({ clips: [], others: [] });
  });

  it.each<Behaviour>(["FAIL", "THROW", "WRITE_NOTHING", "WRITE_EMPTY", "FAIL_AFTER_WRITING"])(
    "keeps nothing when the renderer answers %s",
    async (how) => {
      const renderer = new RecordingRenderer(how);
      expect(await studio(renderer).make(request())).toBe("NOT_MADE");
      expect(renderer.jobs).toHaveLength(1);
      expect(await kept()).toEqual({ clips: [], others: [] });
    },
  );
});

describe("the status source", () => {
  it("is the runner's status source and byte source ports", () => {
    const made = studio();
    const ports: { status: ProviderCompletionStatusSource; bytes: ProviderOutputByteSource } = {
      status: made.statusSource,
      bytes: made.byteSource,
    };
    expect(typeof ports.status.poll).toBe("function");
  });

  it("answers SUCCEEDED, with a redacted locator, for a clip it keeps, in the shape the runner accepts", async () => {
    const made = studio();
    await made.make(request());
    const observation = await made.statusSource.poll(ref());
    expect(parseProviderPollObservation(observation)).toEqual({
      kind: "SUCCEEDED",
      outputLocator: expect.any(TransientProviderOutputLocator) as unknown,
    });
    expect(JSON.stringify(observation)).not.toContain("fake-clip");
  });

  it("issues a new locator each time it is asked, naming no file", async () => {
    const made = studio();
    await made.make(request());
    const first = await locatorFor(made);
    const second = await locatorFor(made);
    expect(first.equals(second)).toBe(false);
    const named = TransientProviderOutputLocator.fromUnknown(`fake-clip:${CLIP_NAME}`);
    if (!named.ok) throw new Error("fixture");
    expect(named.value.equals(first)).toBe(false);
  });

  it.each<[string, Partial<ProviderStatusLookupRef>]>([
    ["a prediction it never made", { providerPredictionId: `fake_sha256:v2:${"b".repeat(64)}` }],
    ["another provider", { providerName: "fal" }],
    ["another model", { providerModelId: "fal-ai/minimax/hailuo-03/image-to-video" }],
    ["a prediction id that is not its own", { providerPredictionId: HASH }],
  ])("answers nothing for %s", async (_, change) => {
    const made = studio();
    await made.make(request());
    const failure = await made.statusSource.poll(ref(change)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderErrorException);
    expect((failure as ProviderErrorException).error.code).toBe("FAKE_CLIP_UNKNOWN");
  });
});

describe("the byte source", () => {
  it("streams the clip behind a locator it issued, and closes once however often asked", async () => {
    const made = studio();
    await made.make(request());
    const opened = await made.byteSource.open(await locatorFor(made));
    if (opened.kind !== "OPEN") throw new Error("expected the clip to open");
    expect(opened.stream.declaredSizeBytes).toBe(CLIP.byteLength);
    expect(Buffer.concat(await collect(opened.stream.body))).toEqual(Buffer.from(CLIP));
    await opened.stream.close();
    await opened.stream.close();
  });

  it("hands a long clip over in pieces of at most 1 MiB, in order", async () => {
    const clip = new Uint8Array(3 * 1024 * 1024 + 5).map((_, index) => index % 251);
    const made = studio(new RecordingRenderer("RENDER", clip));
    await made.make(request());
    const opened = await made.byteSource.open(await locatorFor(made));
    if (opened.kind !== "OPEN") throw new Error("expected the clip to open");
    const chunks = await collect(opened.stream.body);
    await opened.stream.close();
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([1048576, 1048576, 1048576, 5]);
    // Compared by digest: a deep comparison of three million bytes takes seconds.
    const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
    expect(digest(Buffer.concat(chunks))).toBe(digest(clip));
  });

  it("opens nothing for a locator it did not issue, even one naming its clip", async () => {
    const made = studio();
    await made.make(request());
    const issued = await locatorFor(made);
    const lookalike = TransientProviderOutputLocator.fromUnknown(`fake-clip:${CLIP_NAME}`);
    if (!lookalike.ok) throw new Error("fixture");
    expect(await made.byteSource.open(lookalike.value)).toEqual({ kind: "RETRYABLE_FAILURE" });
    // Another studio over the same folder keeps the same clip, but did not issue this locator.
    expect(await studio().byteSource.open(issued)).toEqual({ kind: "RETRYABLE_FAILURE" });
  });

  it("opens nothing once the clip is gone, or empty, and lets go of the file", async () => {
    const made = studio();
    await made.make(request());
    const issued = await locatorFor(made);
    await truncate(join(root, "clips", CLIP_NAME), 0);
    const before = handleCloses.length;
    expect(await made.byteSource.open(issued)).toEqual({ kind: "RETRYABLE_FAILURE" });
    expect(handleCloses.slice(before)).toEqual([1]);
    await rm(join(root, "clips"), { recursive: true });
    expect(await made.byteSource.open(issued)).toEqual({ kind: "RETRYABLE_FAILURE" });
  });

  it("lets go of the file once, however often the stream is closed", async () => {
    const made = studio();
    await made.make(request());
    const issued = await locatorFor(made);
    const before = handleCloses.length;
    const opened = await made.byteSource.open(issued);
    if (opened.kind !== "OPEN") throw new Error("expected the clip to open");
    expect(handleCloses.slice(before)).toEqual([0]);
    await opened.stream.close();
    await opened.stream.close();
    expect(handleCloses.slice(before)).toEqual([1]);
  });

  it("interrupts, retryably, a clip that ends before its declared size, after only the bytes it has", async () => {
    const made = studio();
    await made.make(request());
    const opened = await made.byteSource.open(await locatorFor(made));
    if (opened.kind !== "OPEN") throw new Error("expected the clip to open");
    await truncate(join(root, "clips", CLIP_NAME), 3);
    const chunks = opened.stream.body[Symbol.asyncIterator]();
    expect((await chunks.next()).value).toEqual(CLIP.subarray(0, 3));
    await expect(chunks.next()).rejects.toBeInstanceOf(ProviderOutputByteStreamRetryableFailure);
    await opened.stream.close();
  });

  it("hands over no more than its declared size, even of a clip that grew", async () => {
    const made = studio();
    await made.make(request());
    const opened = await made.byteSource.open(await locatorFor(made));
    if (opened.kind !== "OPEN") throw new Error("expected the clip to open");
    await appendFile(join(root, "clips", CLIP_NAME), new Uint8Array([1, 2, 3, 4, 5]));
    expect(Buffer.concat(await collect(opened.stream.body))).toEqual(Buffer.from(CLIP));
    await opened.stream.close();
  });

  it("interrupts, retryably, a read that fails", async () => {
    const made = studio();
    await made.make(request());
    const opened = await made.byteSource.open(await locatorFor(made));
    if (opened.kind !== "OPEN") throw new Error("expected the clip to open");
    await opened.stream.close();
    await expect(collect(opened.stream.body)).rejects.toBeInstanceOf(ProviderOutputByteStreamRetryableFailure);
  });
});


describe("the fake provider with a studio", () => {
  it("accepts a request once its clip is made, under the prediction id the status source answers for", async () => {
    const made = studio();
    const outcome = await new FakeVideoProvider({ studio: made }).createGeneration(request());
    expect(outcome).toMatchObject({ kind: "ACCEPTED", ref: { provider: "fake", predictionId: `fake_${HASH}` } });
    expect((await made.statusSource.poll(ref())).kind).toBe("SUCCEEDED");
  });

  it("refuses a request whose clip it could not make, as a refusal no retry repeats", async () => {
    const outcome = await new FakeVideoProvider({ studio: studio(new RecordingRenderer("FAIL")) }).createGeneration(
      request(),
    );
    expect(outcome).toEqual({
      kind: "DEFINITIVELY_REJECTED",
      error: {
        kind: "INVALID_INPUT",
        code: "FAKE_CLIP_NOT_MADE",
        messageSanitized: "Fake provider could not make the clip",
        retryable: false,
      },
    });
  });

  it("answers a configured outcome without making anything", async () => {
    const renderer = new RecordingRenderer();
    for (const submissionOutcome of ["DEFINITIVELY_REJECTED", "SUBMISSION_UNKNOWN"] as const) {
      const provider = new FakeVideoProvider({ studio: studio(renderer), submissionOutcome });
      expect((await provider.createGeneration(request())).kind).toBe(submissionOutcome);
    }
    expect(renderer.jobs).toEqual([]);
  });
});
