/**
 * The composer's Clean Master encode and the disclosure laid over it
 * (ADR-0075): their exact argument vectors, the disclosure image's check, and
 * the outcomes a run maps to.
 *
 * No subprocess is launched here; `tests/media/` runs both encodes on real
 * FFmpeg.
 */

import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import type { ProcessRunOutcome } from "./process-runner";
import {
  createFfmpegDeliverableComposer,
  ffmpegCleanMasterArgsFor,
  ffmpegComposeArgsFor,
  ffmpegDisclosureArgsFor,
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
    expect(CLEAN_MASTER_CRF).toBe(14);
    // A lower Constant Rate Factor is a higher quality.
    expect(CLEAN_MASTER_CRF).toBeLessThan(COMPOSITION_CRF);
  });

  it("is the composition graph with only its quality changed", () => {
    const composed = ffmpegComposeArgsFor(composeInput());
    const master = ffmpegCleanMasterArgsFor(composeInput());
    const crfAt = composed.indexOf("-crf") + 1;
    expect(composed[crfAt]).toBe("18");
    expect(master[crfAt]).toBe("14");
    expect(master.filter((_, index) => index !== crfAt)).toEqual(composed.filter((_, index) => index !== crfAt));
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
    expect(ffmpegDisclosureArgsFor(disclosureInput(), "/opt/vta/disclosure/layer-v1-1920x1080.png")).toEqual([
      "-nostdin",
      "-y",
      "-v",
      "error",
      "-i",
      "/tmp/vta-compose-x/stored-clean-master.mp4",
      "-loop",
      "1",
      "-i",
      "/opt/vta/disclosure/layer-v1-1920x1080.png",
      "-filter_complex",
      "[0:v][1:v]overlay=0:0:format=auto:shortest=1,format=yuv420p[out]",
      "-map",
      "[out]",
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

  it("encodes with the settings of whichever profile it is handed", () => {
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

describe("the disclosure image is the reviewed one, or nothing runs", () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "composer-layers-"));
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it.each(COMPOSABLE_TARGETS.map((target) => [`${target.targetAspectRatio} ${target.targetOutputResolution}`, target] as const))(
    "lays the committed image for %s",
    async (_name, target) => {
      const profile = profileOf(target.targetAspectRatio, target.targetOutputResolution);
      const asset = DISCLOSURE_LAYER_ASSETS.find(
        (one) => one.widthPx === profile.targetWidthPx && one.heightPx === profile.targetHeightPx,
      )!;
      const runner = new FakeProcessRunner({ outcome: exitedCleanly });
      const composer = createFfmpegDeliverableComposer({ runner }, { disclosureLayerDirectory: LAYER_DIRECTORY });
      await expect(composer.applyDisclosure(disclosureInput({ profile }))).resolves.toEqual({ kind: "SUCCESS" });
      expect(runner.runs).toHaveLength(1);
      expect(runner.lastRun.args).toEqual(
        ffmpegDisclosureArgsFor(disclosureInput({ profile }), join(LAYER_DIRECTORY, asset.fileName)),
      );
    },
  );

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

  it("refuses an image that is not the reviewed one, however close", async () => {
    const runner = new FakeProcessRunner({ outcome: exitedCleanly });
    const composer = createFfmpegDeliverableComposer({ runner }, { disclosureLayerDirectory: scratch });
    // Another frame size's committed image under this size's name, and this
    // size's image with one byte appended.
    await copyFile(join(LAYER_DIRECTORY, "layer-v1-1280x720.png"), join(scratch, "layer-v1-1920x1080.png"));
    expect(await refusal(composer.applyDisclosure(disclosureInput()))).toBe("CONFIGURATION_ERROR");
    const reviewed = await readFile(join(LAYER_DIRECTORY, "layer-v1-1920x1080.png"));
    await writeFile(join(scratch, "layer-v1-1920x1080.png"), Buffer.concat([reviewed, Buffer.from([0])]));
    expect(await refusal(composer.applyDisclosure(disclosureInput()))).toBe("CONFIGURATION_ERROR");
    expect(runner.runs).toHaveLength(0);
    // The reviewed bytes themselves are accepted from any directory.
    await writeFile(join(scratch, "layer-v1-1920x1080.png"), reviewed);
    await expect(composer.applyDisclosure(disclosureInput())).resolves.toEqual({ kind: "SUCCESS" });
    expect(runner.lastRun.args).toContain(join(scratch, "layer-v1-1920x1080.png"));
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
});

describe("both encodes map a run as compose does", () => {
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
    ]) {
      expect(await refusal(composer.composeCleanMaster({ ...composeInput(), profile }))).toBe("INTERNAL_ERROR");
      expect(await refusal(composer.applyDisclosure(disclosureInput({ profile })))).toBe("INTERNAL_ERROR");
    }
    expect(runner.runs).toHaveLength(0);
  });
});
