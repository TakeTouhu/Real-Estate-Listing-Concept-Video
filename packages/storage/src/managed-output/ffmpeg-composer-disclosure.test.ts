/**
 * The composer's Clean Master encode and the disclosure laid over it
 * (ADR-0075): their exact argument vectors, the disclosure image's check, and
 * the outcomes a run maps to.
 *
 * No subprocess is launched here; `tests/media/` runs both encodes on real
 * FFmpeg.
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "@app/shared";
import {
  CLEAN_MASTER_CRF,
  COMPOSABLE_TARGETS,
  COMPOSITION_CRF,
  DISCLOSURE_LAYER_ASSETS,
  resolveCompositionProfile,
  type ApplyDisclosureInput,
  type ComposeDeliverableInput,
  type CompositionProfile,
  type DisclosureMode,
} from "@app/domain";
import { FakeProcessRunner } from "../testing/media-fakes";
import type { ProcessRunInput, ProcessRunner, ProcessRunOutcome } from "./process-runner";
import {
  createFfmpegDeliverableComposer,
  ffmpegCleanMasterArgsFor,
  ffmpegDisclosureArgsFor,
  isDeploymentReadFault,
} from "./ffmpeg-composer";

const LAYER_DIRECTORY = fileURLToPath(new URL("../../../../assets/disclosure", import.meta.url));

function profileOf(aspect = "16:9", resolution = "1080p"): CompositionProfile {
  const outcome = resolveCompositionProfile({
    targetAspectRatio: aspect,
    targetOutputResolution: resolution,
  });
  if (outcome.kind !== "RESOLVED") throw new Error("fixture profile must resolve");
  return outcome.profile;
}

function composeInput(): ComposeDeliverableInput {
  return {
    clips: [
      { localPath: "/tmp/vta-compose-x/input-0000", durationSeconds: 5 },
      { localPath: "/tmp/vta-compose-x/input-0001", durationSeconds: 7 },
    ],
    profile: profileOf(),
    outputPath: "/tmp/vta-compose-x/clean-master.mp4",
  };
}

function disclosureInput(overrides: Partial<ApplyDisclosureInput> = {}): ApplyDisclosureInput {
  return {
    cleanMasterPath: "/tmp/vta-compose-x/stored-clean-master.mp4",
    profile: profileOf(),
    disclosureMode: "THROUGHOUT",
    outputPath: "/tmp/vta-compose-x/output.mp4",
    ...overrides,
  };
}

const exitedCleanly: ProcessRunOutcome = { kind: "EXITED", exitCode: 0, stdout: "" };

/** What FFmpeg would have found at the image path while it ran. */
interface SeenLayer {
  readonly args: readonly string[];
  readonly layerPath: string;
  readonly sha256: string;
  readonly fileMode: number;
  readonly directoryMode: number;
}

/** A runner that reads the image FFmpeg is handed, during the run, as FFmpeg would. */
class LayerReadingRunner implements ProcessRunner {
  readonly seen: SeenLayer[] = [];

  async run(input: ProcessRunInput): Promise<ProcessRunOutcome> {
    const layerPath = input.args[input.args.indexOf("png_pipe") + 4]!;
    const bytes = await readFile(layerPath);
    this.seen.push({
      args: input.args,
      layerPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      fileMode: (await stat(layerPath)).mode & 0o777,
      directoryMode: (await stat(dirname(layerPath))).mode & 0o777,
    });
    return exitedCleanly;
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return (error as AppError).code;
  }
  throw new Error("expected a refusal");
}

// ---------------------------------------------------------------------------

describe("the Clean Master encode", () => {
  it("is encoded at a higher quality than the customer's video", () => {
    expect(CLEAN_MASTER_CRF).toBe(16);
    // A lower Constant Rate Factor is a higher quality.
    expect(CLEAN_MASTER_CRF).toBeLessThan(COMPOSITION_CRF);
  });

  it("lays nothing over the video", () => {
    const master = ffmpegCleanMasterArgsFor(composeInput());
    for (const banned of ["overlay", "drawtext", "-loop", ".png"]) {
      expect(`${banned}: ${master.some((arg) => arg.includes(banned))}`).toBe(`${banned}: false`);
    }
  });

  it("runs that vector", async () => {
    const runner = new FakeProcessRunner({ outcome: exitedCleanly });
    const outcome = await createFfmpegDeliverableComposer({ runner }).composeCleanMaster(composeInput());
    expect(outcome).toEqual({ kind: "SUCCESS" });
    expect(runner.runs).toHaveLength(1);
    expect(runner.lastRun.program).toBe("ffmpeg");
    expect(runner.lastRun.args).toEqual(ffmpegCleanMasterArgsFor(composeInput()));
  });
});

describe("the disclosure's argument vector", () => {
  it("is pinned element by element for Mode A", () => {
    expect(ffmpegDisclosureArgsFor(disclosureInput(), "/tmp/vta-disclosure-x/layer.png")).toEqual([
      "-nostdin",
      "-y",
      "-v",
      "error",
      "-i",
      "/tmp/vta-compose-x/stored-clean-master.mp4",
      "-f",
      "png_pipe",
      "-loop",
      "1",
      "-i",
      "/tmp/vta-disclosure-x/layer.png",
      "-filter_complex",
      "[0:v][1:v]overlay=0:0:format=auto:shortest=1,format=yuv420p[out]",
      "-map",
      "[out]",
      "-map_metadata",
      "-1",
      "-map_chapters",
      "-1",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      "/tmp/vta-compose-x/output.mp4",
    ]);
  });

  it("carries the profile's own settings rather than copies of them", () => {
    const profile = { ...profileOf("9:16", "720p"), encoderPreset: "slow", crf: 20 };
    const args = ffmpegDisclosureArgsFor(disclosureInput({ profile }), "/x/layer.png");
    expect(args[args.indexOf("-preset") + 1]).toBe("slow");
    expect(args[args.indexOf("-crf") + 1]).toBe("20");
  });

  it("neither scales, crops nor draws text: the image is already the frame's size", () => {
    const args = ffmpegDisclosureArgsFor(disclosureInput(), "/x/layer.png");
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    for (const banned of ["scale", "crop", "pad", "drawtext", "enable"]) {
      expect(`${banned}: ${graph.includes(banned)}`).toBe(`${banned}: false`);
    }
  });

  it("refuses a disclosure mode it does not implement", () => {
    // Unreachable through the types; a value from an untyped caller is refused,
    // never encoded as Mode A or without the disclosure.
    for (const mode of ["NONE", "START_AND_END", "", "throughout"]) {
      expect(() =>
        ffmpegDisclosureArgsFor(disclosureInput({ disclosureMode: mode as DisclosureMode }), "/x/layer.png"),
      ).toThrow(AppError);
    }
  });
});

describe("nothing from an input's container reaches either file", () => {
  it.each([
    ["the Clean Master", ffmpegCleanMasterArgsFor(composeInput())],
    ["the disclosure", ffmpegDisclosureArgsFor(disclosureInput(), "/x/layer.png")],
  ] as const)("%s drops every input's tags and chapters", (_name, args) => {
    // `-1` turns off FFmpeg's default of copying the first input's.
    const tagsAt = args.indexOf("-map_metadata");
    const chaptersAt = args.indexOf("-map_chapters");
    expect(args[tagsAt + 1]).toBe("-1");
    expect(args[chaptersAt + 1]).toBe("-1");
    // Output options: after the graph, before the output path.
    expect(tagsAt).toBeGreaterThan(args.indexOf("-filter_complex"));
    expect(chaptersAt).toBeGreaterThan(args.indexOf("-filter_complex"));
  });
});

describe("the disclosure image is the reviewed one, or nothing runs", () => {
  let scratch: string;

  // A fresh directory per test, so no test's files decide another's result.
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "composer-layers-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it.each(COMPOSABLE_TARGETS.map((target) => [`${target.targetAspectRatio} ${target.targetOutputResolution}`, target] as const))(
    "lays a private copy of the committed image for %s, removed after the run",
    async (_name, target) => {
      const profile = profileOf(target.targetAspectRatio, target.targetOutputResolution);
      const asset = DISCLOSURE_LAYER_ASSETS.find(
        (one) => one.widthPx === profile.targetWidthPx && one.heightPx === profile.targetHeightPx,
      )!;
      const runner = new LayerReadingRunner();
      const composer = createFfmpegDeliverableComposer({ runner }, { disclosureLayerDirectory: LAYER_DIRECTORY });
      await expect(composer.applyDisclosure(disclosureInput({ profile }))).resolves.toEqual({ kind: "SUCCESS" });
      expect(runner.seen).toHaveLength(1);
      const [seen] = runner.seen;
      expect(seen!.args).toEqual(ffmpegDisclosureArgsFor(disclosureInput({ profile }), seen!.layerPath));
      // FFmpeg read the reviewed bytes, from a file of the composer's own that
      // only this process can read or write, never the deployment's file.
      expect(seen!.sha256).toBe(asset.sha256);
      expect(seen!.layerPath.startsWith(LAYER_DIRECTORY)).toBe(false);
      expect(basename(seen!.layerPath)).toBe("layer.png");
      expect(seen!.fileMode).toBe(0o600);
      expect(seen!.directoryMode).toBe(0o700);
      expect(await exists(dirname(seen!.layerPath))).toBe(false);
    },
  );

  it("removes the private copy when the run throws", async () => {
    const runner = new LayerReadingRunner();
    runner.run = async (input) => {
      await LayerReadingRunner.prototype.run.call(runner, input);
      return { kind: "LAUNCH_FAILED" };
    };
    const composer = createFfmpegDeliverableComposer({ runner }, { disclosureLayerDirectory: LAYER_DIRECTORY });
    expect(await refusal(composer.applyDisclosure(disclosureInput()))).toBe("CONFIGURATION_ERROR");
    expect(await exists(dirname(runner.seen[0]!.layerPath))).toBe(false);
  });

  it("refuses a relative image directory when the composer is built", () => {
    const runner = new FakeProcessRunner({ outcome: exitedCleanly });
    expect(() =>
      createFfmpegDeliverableComposer({ runner }, { disclosureLayerDirectory: "assets/disclosure" }),
    ).toThrow(AppError);
  });

  it("refuses, as a deployment fault, when no directory is configured", async () => {
    const runner = new FakeProcessRunner({ outcome: exitedCleanly });
    const composer = createFfmpegDeliverableComposer({ runner });
    expect(await refusal(composer.applyDisclosure(disclosureInput()))).toBe("CONFIGURATION_ERROR");
    expect(runner.runs).toHaveLength(0);
  });

  it("refuses, as a deployment fault, when the image is missing", async () => {
    const runner = new FakeProcessRunner({ outcome: exitedCleanly });
    const composer = createFfmpegDeliverableComposer({ runner }, { disclosureLayerDirectory: scratch });
    expect(await refusal(composer.applyDisclosure(disclosureInput()))).toBe("CONFIGURATION_ERROR");
    expect(runner.runs).toHaveLength(0);
  });

  it("refuses, as a deployment fault, when a directory stands where the image should be", async () => {
    const runner = new FakeProcessRunner({ outcome: exitedCleanly });
    await mkdir(join(scratch, "layer-v1-1920x1080.png"));
    const composer = createFfmpegDeliverableComposer({ runner }, { disclosureLayerDirectory: scratch });
    expect(await refusal(composer.applyDisclosure(disclosureInput()))).toBe("CONFIGURATION_ERROR");
    expect(runner.runs).toHaveLength(0);
  });

  it("refuses an image that is not the reviewed one, however close, and checks again at every run", async () => {
    const runner = new LayerReadingRunner();
    const composer = createFfmpegDeliverableComposer({ runner }, { disclosureLayerDirectory: scratch });
    const image = join(scratch, "layer-v1-1920x1080.png");
    const otherSize = await readFile(join(LAYER_DIRECTORY, "layer-v1-1280x720.png"));
    const reviewed = await readFile(join(LAYER_DIRECTORY, "layer-v1-1920x1080.png"));
    // Another frame size's committed image under this size's name, and this
    // size's image with one byte appended.
    await writeFile(image, otherSize);
    expect(await refusal(composer.applyDisclosure(disclosureInput()))).toBe("CONFIGURATION_ERROR");
    await writeFile(image, Buffer.concat([reviewed, Buffer.from([0])]));
    expect(await refusal(composer.applyDisclosure(disclosureInput()))).toBe("CONFIGURATION_ERROR");
    expect(runner.seen).toHaveLength(0);
    // The reviewed bytes themselves are accepted from any directory...
    await copyFile(join(LAYER_DIRECTORY, "layer-v1-1920x1080.png"), image);
    await expect(composer.applyDisclosure(disclosureInput())).resolves.toEqual({ kind: "SUCCESS" });
    expect(runner.seen).toHaveLength(1);
    // ...and a success is not remembered: replaced afterwards, the image is
    // refused at the next run.
    await writeFile(image, otherSize);
    expect(await refusal(composer.applyDisclosure(disclosureInput()))).toBe("CONFIGURATION_ERROR");
    expect(runner.seen).toHaveLength(1);
  });

  it.runIf(process.platform === "linux")(
    "retries when the image cannot be read for a reason the deployment did not cause",
    async () => {
      const runner = new FakeProcessRunner({ outcome: exitedCleanly });
      // Reading this file fails with an I/O error, as a failing disk would.
      await symlink("/proc/self/mem", join(scratch, "layer-v1-1920x1080.png"));
      const composer = createFfmpegDeliverableComposer({ runner }, { disclosureLayerDirectory: scratch });
      await expect(composer.applyDisclosure(disclosureInput())).resolves.toEqual({ kind: "RETRYABLE_FAILURE" });
      expect(runner.runs).toHaveLength(0);
    },
  );

  it("retries when the private copy cannot be made", async () => {
    const runner = new FakeProcessRunner({ outcome: exitedCleanly });
    const composer = createFfmpegDeliverableComposer({ runner }, { disclosureLayerDirectory: LAYER_DIRECTORY });
    const original = process.env["TMPDIR"];
    process.env["TMPDIR"] = join(scratch, "no-such-directory");
    try {
      await expect(composer.applyDisclosure(disclosureInput())).resolves.toEqual({ kind: "RETRYABLE_FAILURE" });
    } finally {
      if (original === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = original;
    }
    expect(runner.runs).toHaveLength(0);
  });

  it("tells a deployment's read fault from a passing one", () => {
    for (const code of ["ENOENT", "ENOTDIR", "EISDIR", "EACCES", "EPERM", "ELOOP", "ENAMETOOLONG"]) {
      expect(`${code}: ${isDeploymentReadFault(Object.assign(new Error(code), { code }))}`).toBe(`${code}: true`);
    }
    for (const code of ["EMFILE", "ENFILE", "EIO", "EAGAIN", undefined]) {
      expect(`${code}: ${isDeploymentReadFault(Object.assign(new Error("x"), { code }))}`).toBe(`${code}: false`);
    }
    expect(isDeploymentReadFault(null)).toBe(false);
  });

  it("refuses a frame size with no image as a defect, never scaling another size's", async () => {
    const runner = new FakeProcessRunner({ outcome: exitedCleanly });
    const composer = createFfmpegDeliverableComposer({ runner }, { disclosureLayerDirectory: LAYER_DIRECTORY });
    for (const [targetWidthPx, targetHeightPx] of [
      [1920, 1088],
      [640, 360],
      [1080, 1920 + 2],
    ] as const) {
      const profile = { ...profileOf(), targetWidthPx, targetHeightPx };
      expect(await refusal(composer.applyDisclosure(disclosureInput({ profile })))).toBe("INTERNAL_ERROR");
    }
    expect(runner.runs).toHaveLength(0);
  });

  it("reports a defect as a defect even where the deployment has no images", async () => {
    const runner = new FakeProcessRunner({ outcome: exitedCleanly });
    const composer = createFfmpegDeliverableComposer({ runner });
    for (const input of [
      disclosureInput({ disclosureMode: "NONE" as DisclosureMode }),
      disclosureInput({ profile: { ...profileOf(), targetWidthPx: 640, targetHeightPx: 360 } }),
      disclosureInput({ outputPath: "/tmp/vta-compose-x/stored-clean-master.mp4" }),
      disclosureInput({ outputPath: "/tmp/vta-compose-x/../vta-compose-x/stored-clean-master.mp4" }),
    ]) {
      expect(await refusal(composer.applyDisclosure(input))).toBe("INTERNAL_ERROR");
    }
    expect(runner.runs).toHaveLength(0);
  });
});

describe("both encodes map a run to the composer's closed vocabulary", () => {
  const methods = [
    [
      "composeCleanMaster",
      (runner: FakeProcessRunner) => createFfmpegDeliverableComposer({ runner }).composeCleanMaster(composeInput()),
    ],
    [
      "applyDisclosure",
      (runner: FakeProcessRunner) =>
        createFfmpegDeliverableComposer({ runner }, { disclosureLayerDirectory: LAYER_DIRECTORY }).applyDisclosure(
          disclosureInput(),
        ),
    ],
  ] as const;

  it.each(methods)("%s: a clean exit succeeds, and anything else retries without a diagnostic", async (_name, call) => {
    await expect(call(new FakeProcessRunner({ outcome: exitedCleanly }))).resolves.toEqual({ kind: "SUCCESS" });
    for (const outcome of [
      { kind: "EXITED", exitCode: 1, stdout: "secret diagnostic text" },
      { kind: "TIMED_OUT" },
      { kind: "OUTPUT_TOO_LARGE" },
      { kind: "TRANSIENT_FAILURE" },
    ] as const) {
      const result = await call(new FakeProcessRunner({ outcome }));
      expect(JSON.stringify(result)).toBe(JSON.stringify({ kind: "RETRYABLE_FAILURE" }));
    }
  });

  it.each(methods)("%s: an unavailable binary is a configuration defect, not a retry", async (_name, call) => {
    expect(await refusal(call(new FakeProcessRunner({ outcome: { kind: "LAUNCH_FAILED" } })))).toBe(
      "CONFIGURATION_ERROR",
    );
  });

  it("both refuse a profile they do not implement before running anything", async () => {
    const runner = new FakeProcessRunner({ outcome: exitedCleanly });
    const composer = createFfmpegDeliverableComposer({ runner }, { disclosureLayerDirectory: LAYER_DIRECTORY });
    for (const profile of [
      { ...profileOf(), fitMode: "COVER_CROP" },
      { ...profileOf(), transitionMode: "CROSSFADE" },
      { ...profileOf(), audioMode: "KEEP_ALL" },
      { ...profileOf(), videoCodec: "hevc" },
      { ...profileOf(), encoderPreset: "slow" },
      // The pixel format is written into the filter graph, so a value that is
      // not the one implemented never reaches it.
      { ...profileOf(), pixelFormat: "yuv420p[out];movie=x" },
    ]) {
      expect(await refusal(composer.composeCleanMaster({ ...composeInput(), profile }))).toBe("INTERNAL_ERROR");
      expect(await refusal(composer.applyDisclosure(disclosureInput({ profile })))).toBe("INTERNAL_ERROR");
    }
    expect(runner.runs).toHaveLength(0);
  });
});
