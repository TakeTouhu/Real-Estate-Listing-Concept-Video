import { describe, expect, it } from "vitest";
import { computeCompositionFingerprint } from "../storyboard/fingerprint";
import { computeGenerationRequestHash } from "../generation/request-identity";
import {
  COMPOSITION_PLAN_REASON_CODE,
  DELIVERABLE_PLANNED_EVENT_TYPE,
  DELIVERABLE_PLANNED_STATE,
  DeliverableCompositionDefect,
  FIRST_DELIVERABLE_ORDINAL,
  JOB_COMPOSITION_PENDING_EVENT_TYPE,
  computeDeliverableInputFingerprint,
  type DeliverableInputFingerprintScene,
  type DeliverableInputFingerprintTarget,
} from "./plan";

const TARGET: DeliverableInputFingerprintTarget = {
  targetOutputResolution: "1080p",
  targetAspectRatio: "16:9",
  requestedDurationSeconds: 60,
};

function scene(
  overrides: Partial<DeliverableInputFingerprintScene> = {},
): DeliverableInputFingerprintScene {
  return {
    position: 0,
    generationSceneId: "genscene_1",
    sceneGenerationRequestId: "genreq_1",
    sceneGenerationAttemptId: "sgen_1",
    mediaValidationId: "momv_1",
    sourceSha256: "a".repeat(64),
    sourceSizeBytes: 5_120_000n,
    ...overrides,
  };
}

const TWO: readonly DeliverableInputFingerprintScene[] = [
  scene(),
  scene({
    position: 1,
    generationSceneId: "genscene_2",
    sceneGenerationRequestId: "genreq_2",
    sceneGenerationAttemptId: "sgen_2",
    mediaValidationId: "momv_2",
    sourceSha256: "b".repeat(64),
    sourceSizeBytes: 4_096_000n,
  }),
];

describe("computeDeliverableInputFingerprint", () => {
  it("is stable for the same facts", () => {
    expect(computeDeliverableInputFingerprint(TARGET, TWO)).toBe(
      computeDeliverableInputFingerprint(TARGET, TWO),
    );
  });

  it("carries its own versioned vocabulary in the value", () => {
    expect(computeDeliverableInputFingerprint(TARGET, TWO)).toMatch(
      /^sha256:deliverable-input:v1:[0-9a-f]{64}$/,
    );
  });

  it("is not the storyboard composition fingerprint", () => {
    // Different question, different vocabulary. The prefixes make two stored
    // values distinguishable even if their hex ever collided.
    const storyboard = computeCompositionFingerprint([
      {
        assetId: "ast_1",
        analysisRevision: 1,
        roomType: "LIVING_ROOM",
        orderOverride: null,
        suggestedOrder: 1,
      },
    ]);
    expect(storyboard.startsWith("sha256:deliverable-input:")).toBe(false);
    expect(computeDeliverableInputFingerprint(TARGET, TWO)).not.toBe(storyboard);
  });

  it("is not the generation request hash", () => {
    const request = computeGenerationRequestHash({
      assetId: "ast_1",
      compiledPrompt: "a sunlit living room",
      durationSeconds: 5,
      cameraMotion: "SLOW_PAN",
      aspectRatio: "16:9",
      targetOutputResolution: "1080p",
      nativeGenerationResolution: "1080p",
      resolutionNormalization: "NONE",
      nativeMeetsTarget: true,
      modelKey: "wavespeed-open-video",
      providerName: "wavespeed",
      providerModelId: "wavespeed-ai/open-video/image-to-video",
    });
    expect(request.startsWith("sha256:deliverable-input:")).toBe(false);
    expect(computeDeliverableInputFingerprint(TARGET, TWO)).not.toBe(request);
  });

  describe("every selected tuple dimension is bound", () => {
    const base = computeDeliverableInputFingerprint(TARGET, TWO);
    const dimensions: readonly [string, Partial<DeliverableInputFingerprintScene>][] = [
      ["position", { position: 7 }],
      ["generationSceneId", { generationSceneId: "genscene_other" }],
      ["sceneGenerationRequestId", { sceneGenerationRequestId: "genreq_other" }],
      ["sceneGenerationAttemptId", { sceneGenerationAttemptId: "sgen_other" }],
      ["mediaValidationId", { mediaValidationId: "momv_other" }],
      ["sourceSha256", { sourceSha256: "c".repeat(64) }],
      ["sourceSizeBytes", { sourceSizeBytes: 5_120_001n }],
    ];
    for (const [name, override] of dimensions) {
      it(`changes when ${name} changes`, () => {
        const changed: DeliverableInputFingerprintScene[] = [
          TWO[0]!,
          { ...TWO[1]!, ...override },
        ];
        expect(computeDeliverableInputFingerprint(TARGET, changed)).not.toBe(base);
      });
    }
  });

  describe("the frozen job delivery target is bound", () => {
    const base = computeDeliverableInputFingerprint(TARGET, TWO);
    const targets: readonly [string, Partial<DeliverableInputFingerprintTarget>][] = [
      ["targetOutputResolution", { targetOutputResolution: "720p" }],
      ["targetAspectRatio", { targetAspectRatio: "9:16" }],
      ["requestedDurationSeconds", { requestedDurationSeconds: 45 }],
    ];
    for (const [name, override] of targets) {
      it(`changes when ${name} changes`, () => {
        expect(computeDeliverableInputFingerprint({ ...TARGET, ...override }, TWO)).not.toBe(base);
      });
    }
  });

  it("distinguishes a size difference beyond 2^53", () => {
    // The whole reason the payload carries a decimal string rather than a
    // Number: both of these round to the same double.
    const big = (n: bigint) => [scene({ sourceSizeBytes: n })];
    expect(computeDeliverableInputFingerprint(TARGET, big(9_007_199_254_740_993n))).not.toBe(
      computeDeliverableInputFingerprint(TARGET, big(9_007_199_254_740_992n)),
    );
  });

  it("does not collide when an id contains the structural punctuation", () => {
    // Structure, not a chosen separator. Two different selections whose ids
    // differ only by where a quote and comma fall must not hash equal.
    const a = [scene({ generationSceneId: 'x","y', sceneGenerationRequestId: "z" })];
    const b = [scene({ generationSceneId: "x", sceneGenerationRequestId: 'y","z' })];
    expect(computeDeliverableInputFingerprint(TARGET, a)).not.toBe(
      computeDeliverableInputFingerprint(TARGET, b),
    );
  });

  it("refuses a repeated scene", () => {
    expect(() =>
      computeDeliverableInputFingerprint(TARGET, [scene({ position: 0 }), scene({ position: 1 })]),
    ).toThrow(DeliverableCompositionDefect);
  });

  it("refuses a repeated position", () => {
    expect(() =>
      computeDeliverableInputFingerprint(TARGET, [
        scene(),
        scene({ generationSceneId: "genscene_2" }),
      ]),
    ).toThrow(DeliverableCompositionDefect);
  });

  it("refuses descending position order rather than sorting it", () => {
    expect(() => computeDeliverableInputFingerprint(TARGET, [TWO[1]!, TWO[0]!])).toThrow(
      DeliverableCompositionDefect,
    );
  });

  it("names the order defect by its fixed code", () => {
    try {
      computeDeliverableInputFingerprint(TARGET, [TWO[1]!, TWO[0]!]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DeliverableCompositionDefect);
      expect((error as DeliverableCompositionDefect).code).toBe("PLAN_INPUT_ORDER_INVALID");
    }
  });
});

describe("the planning vocabulary", () => {
  it("is fixed and application-owned", () => {
    expect(DELIVERABLE_PLANNED_EVENT_TYPE).toBe("deliverable.planned");
    expect(JOB_COMPOSITION_PENDING_EVENT_TYPE).toBe("job.composition_pending");
    expect(DELIVERABLE_PLANNED_STATE).toBe("PLANNED");
    expect(COMPOSITION_PLAN_REASON_CODE).toBe("DELIVERABLE_COMPOSITION_PLANNED");
    expect(FIRST_DELIVERABLE_ORDINAL).toBe(1);
  });

  it("carries no customer, provider or location text", () => {
    for (const value of [
      DELIVERABLE_PLANNED_EVENT_TYPE,
      JOB_COMPOSITION_PENDING_EVENT_TYPE,
      COMPOSITION_PLAN_REASON_CODE,
    ]) {
      expect(value).toMatch(/^[a-z_.]+$|^[A-Z_]+$/);
    }
  });
});

describe("DeliverableCompositionDefect", () => {
  it("messages name no id, prompt, key or provider detail", () => {
    const codes = [
      "PARTIAL_PLAN_STATE",
      "SOURCE_RECEIPT_BINDING_CONFLICT",
      "PLAN_INPUT_ORDER_INVALID",
      "CURRENT_DELIVERABLE_POINTER_MOVED",
    ] as const;
    for (const code of codes) {
      const defect = new DeliverableCompositionDefect(code);
      expect(defect.code).toBe(code);
      expect(defect.name).toBe("DeliverableCompositionDefect");
      expect(defect.message.length).toBeGreaterThan(0);
      expect(defect.message).not.toMatch(/genjob_|genscene_|genreq_|sgen_|momv_|http|s3:|org\//);
    }
  });
});
