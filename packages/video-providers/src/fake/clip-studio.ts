import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { link, mkdtemp, open, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  ProviderOutputByteStreamRetryableFailure,
  TransientProviderOutputLocator,
  resolveCompositionProfile,
  type ProviderOutputByteSource,
  type ProviderOutputByteSourceOpenResult,
  type ProviderOutputByteStream,
  type ProviderPollObservation,
  type ProviderStatusLookupRef,
} from "@app/domain";
import { AppError, type ServerEnv } from "@app/shared";
import { ProviderErrorException, providerError } from "../errors";
import type { ProviderGenerationInput } from "../types";
import { fakePredictionIdFor } from "./fake-provider";
import { FAKE_VIDEO_MODEL_ID } from "./route-kit";

/**
 * The test provider's back end (GS-6, ADR-0092): it makes a real clip from the
 * scene's photo, keeps it, and hands it over the way a provider does, for
 * development and CI only.
 *
 * ```text
 * make         reads the photo through its signed URL, renders the clip, keeps it
 * statusSource answers SUCCEEDED, with a locator, for a clip it keeps
 * byteSource   streams the clip behind a locator it issued
 * ```
 *
 * The clip is made **before** the fake provider accepts the request, so an
 * accepted request always has its clip, and one it could not make is refused:
 * the fake then holds nothing, which is exactly what a definitive refusal says.
 *
 * The clip is made at the frame of the request's aspect ratio and **native**
 * size (720p is 1280×720 at 16:9), the size the test route's catalog entry
 * records it as generated at (ADR-0090 Decision 4), and lasts the requested
 * whole seconds.
 *
 * Clips are kept as files in the studio's own folder, named by a hash of the
 * prediction id, so a prediction id never becomes a path. A locator names no
 * file either: the studio remembers which clip each locator it issued stands
 * for, so its byte source never reads a locator's raw value, and opens nothing
 * for a locator it did not issue.
 *
 * Refused in production, given or ambient, with no override, and unless
 * `VIDEO_PROVIDER` is `fake`.
 */

/** The longest clip it makes, which the renderer also refuses past. */
const MAX_CLIP_SECONDS = 60;
/** The most one read of a clip hands over: 1 MiB. */
const CHUNK_BYTES = 1024 * 1024;

/** Turns one photo into one clip. `@app/storage` has the FFmpeg one. */
export interface FakeClipRenderer {
  render(input: {
    readonly photoPath: string;
    readonly outputPath: string;
    readonly widthPx: number;
    readonly heightPx: number;
    readonly durationSeconds: number;
  }): Promise<{ readonly kind: "RENDERED" } | { readonly kind: "FAILED" }>;
}

/** Reads a photo the way a provider does: through the signed URL it was given. */
export interface FakeSourcePhotoReader {
  /** The bytes behind the URL, or `null` when it names nothing readable. */
  read(signedUrl: string): Promise<Uint8Array | null>;
}

export interface FakeClipStudioOptions {
  /** The studio's own folder. Absolute, so every process names the same one. */
  readonly root: string;
}

export interface FakeClipStudioDeps {
  readonly renderer: FakeClipRenderer;
  readonly photos: FakeSourcePhotoReader;
}

export type FakeClipMakeOutcome = "MADE" | "NOT_MADE";

export interface FakeClipStudio {
  /** Makes and keeps the clip for one request, once; `NOT_MADE` keeps nothing. */
  make(input: ProviderGenerationInput): Promise<FakeClipMakeOutcome>;
  /** A `ProviderCompletionStatusSource` that answers only with a well-formed observation. */
  readonly statusSource: { poll(ref: ProviderStatusLookupRef): Promise<ProviderPollObservation> };
  readonly byteSource: ProviderOutputByteSource;
}

/** One fixed answer for every prediction this studio cannot answer for. */
const NO_SUCH_CLIP = providerError({
  kind: "PROVIDER",
  code: "FAKE_CLIP_UNKNOWN",
  messageSanitized: "Fake provider holds no clip for this prediction",
  retryable: false,
});

const RETRYABLE_FAILURE: ProviderOutputByteSourceOpenResult = Object.freeze({ kind: "RETRYABLE_FAILURE" });

function clipFileName(predictionId: string): string {
  return `${createHash("sha256").update(predictionId).digest("hex")}.mp4`;
}

async function isClip(path: string): Promise<boolean> {
  try {
    const found = await stat(path);
    return found.isFile() && found.size > 0;
  } catch {
    return false;
  }
}

/** The frame and length the request asks for, or `null` when the studio does not make it. */
function clipShape(
  input: ProviderGenerationInput,
): { readonly widthPx: number; readonly heightPx: number; readonly durationSeconds: number } | null {
  if (input.modelId !== FAKE_VIDEO_MODEL_ID) return null;
  const { durationSeconds } = input;
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > MAX_CLIP_SECONDS) {
    return null;
  }
  const frame = resolveCompositionProfile({
    targetAspectRatio: input.aspectRatio,
    targetOutputResolution: input.nativeGenerationResolution,
  });
  if (frame.kind !== "RESOLVED") return null;
  return { widthPx: frame.profile.targetWidthPx, heightPx: frame.profile.targetHeightPx, durationSeconds };
}

/** Pulled in chunks of at most 1 MiB; a failed read is a retryable interruption. */
function clipStream(handle: FileHandle, sizeBytes: number): ProviderOutputByteStream {
  let closed = false;
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for (;;) {
      const buffer = new Uint8Array(CHUNK_BYTES);
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null));
      } catch {
        throw new ProviderOutputByteStreamRetryableFailure();
      }
      if (bytesRead === 0) return;
      yield buffer.subarray(0, bytesRead);
    }
  }
  return {
    body: { [Symbol.asyncIterator]: chunks },
    declaredSizeBytes: sizeBytes,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await handle.close().catch(() => undefined);
    },
  };
}

class FakeClipByteSource implements ProviderOutputByteSource {
  readonly #clips: string;
  readonly #issued: WeakMap<TransientProviderOutputLocator, string>;

  constructor(clips: string, issued: WeakMap<TransientProviderOutputLocator, string>) {
    this.#clips = clips;
    this.#issued = issued;
  }

  async open(source: TransientProviderOutputLocator): Promise<ProviderOutputByteSourceOpenResult> {
    const fileName = this.#issued.get(source);
    if (fileName === undefined) return RETRYABLE_FAILURE;
    let handle: FileHandle;
    try {
      handle = await open(join(this.#clips, fileName), "r");
    } catch {
      return RETRYABLE_FAILURE;
    }
    try {
      const found = await handle.stat();
      if (found.isFile() && found.size > 0) return { kind: "OPEN", stream: clipStream(handle, found.size) };
    } catch {
      // Answered below, with the handle released.
    }
    await handle.close().catch(() => undefined);
    return RETRYABLE_FAILURE;
  }
}

export function createFakeClipStudio(
  env: Pick<ServerEnv, "NODE_ENV" | "VIDEO_PROVIDER">,
  options: FakeClipStudioOptions,
  deps: FakeClipStudioDeps,
): FakeClipStudio {
  if (env.NODE_ENV === "production" || process.env.NODE_ENV === "production") {
    throw new AppError("CONFIGURATION_ERROR", "The test provider's studio is refused in production");
  }
  if (env.VIDEO_PROVIDER !== "fake") {
    throw new AppError("CONFIGURATION_ERROR", "The test provider's studio needs VIDEO_PROVIDER=fake");
  }
  if (typeof options.root !== "string" || !isAbsolute(options.root)) {
    throw new AppError("CONFIGURATION_ERROR", "The test provider's folder must be an absolute path");
  }
  let root: string;
  try {
    mkdirSync(join(options.root, "clips"), { recursive: true, mode: 0o700 });
    root = realpathSync(options.root);
  } catch {
    throw new AppError("CONFIGURATION_ERROR", "The test provider's folder could not be opened");
  }
  const clips = join(root, "clips");
  const issued = new WeakMap<TransientProviderOutputLocator, string>();

  async function render(
    input: ProviderGenerationInput,
    shape: NonNullable<ReturnType<typeof clipShape>>,
    clipPath: string,
  ): Promise<FakeClipMakeOutcome> {
    const photo = await deps.photos.read(input.sourceImageUrl);
    if (photo === null || photo.byteLength === 0) return "NOT_MADE";
    // A private folder per clip, inside the studio's, so the finished clip is
    // linked into place on the same file system: nothing ever sees half of one.
    const work = await mkdtemp(join(root, "work-"));
    try {
      const photoPath = join(work, "photo.jpg");
      const outputPath = join(work, "clip.mp4");
      await writeFile(photoPath, photo, { flag: "wx", mode: 0o600 });
      const rendered = await deps.renderer.render({ photoPath, outputPath, ...shape });
      if (rendered.kind !== "RENDERED" || !(await isClip(outputPath))) return "NOT_MADE";
      try {
        await link(outputPath, clipPath);
      } catch (error) {
        // Another make of the same request linked its clip first: that one stands.
        if ((error as { code?: unknown } | null)?.code !== "EEXIST") throw error;
      }
      return "MADE";
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return Object.freeze({
    async make(input: ProviderGenerationInput): Promise<FakeClipMakeOutcome> {
      const shape = clipShape(input);
      if (shape === null) return "NOT_MADE";
      const clipPath = join(clips, clipFileName(fakePredictionIdFor(input.requestHash)));
      if (await isClip(clipPath)) return "MADE";
      try {
        return await render(input, shape, clipPath);
      } catch {
        // Whatever stopped it, the clip was not made and nothing is kept.
        return "NOT_MADE";
      }
    },

    statusSource: Object.freeze({
      async poll(ref: ProviderStatusLookupRef): Promise<ProviderPollObservation> {
        // The persisted identity decides, and only this provider's own. A
        // prediction id is hashed into a file name, never used as a path.
        if (
          ref.providerName !== "fake" ||
          ref.providerModelId !== FAKE_VIDEO_MODEL_ID ||
          !ref.providerPredictionId.startsWith("fake_")
        ) {
          throw new ProviderErrorException(NO_SUCH_CLIP);
        }
        const fileName = clipFileName(ref.providerPredictionId);
        if (!(await isClip(join(clips, fileName)))) throw new ProviderErrorException(NO_SUCH_CLIP);
        const built = TransientProviderOutputLocator.fromUnknown(`fake-clip:${fileName}`);
        if (!built.ok) throw new ProviderErrorException(NO_SUCH_CLIP);
        issued.set(built.value, fileName);
        return { kind: "SUCCEEDED", outputLocator: built.value };
      },
    }),

    byteSource: new FakeClipByteSource(clips, issued),
  });
}
