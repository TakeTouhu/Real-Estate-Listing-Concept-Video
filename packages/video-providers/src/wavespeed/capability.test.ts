import { describe, expect, it } from "vitest";
import { AppError, WAVESPEED_OPEN_VIDEO_MODEL_ID, serverEnvSchema } from "@app/shared";
import {
  assertSettingsSupported,
  renderPrompt,
  PRESERVATION_RULES,
  SYSTEM_NEGATIVE_CONSTRAINTS,
  type CameraMotion,
  type CompiledPrompt,
  type GenerationRequestSettings,
} from "@app/domain";
import {
  OPEN_VIDEO_CAPABILITY,
  OPEN_VIDEO_OPTIONAL_REQUEST_FIELDS,
  OPEN_VIDEO_REQUEST_FIELDS,
  createOpenVideoCapabilityProvider,
} from "./capability";
import { mapToWaveSpeedRequest } from "./mapping";

/**
 * The verified OpenVideo descriptor.
 *
 * These assertions are transcriptions of the official documentation, not
 * restatements of the implementation — if someone edits the descriptor to make
 * a failing admission pass, these fail. That is the entire point: the previous
 * adapter sent three fields this endpoint does not document, and nothing caught
 * it because no test asserted what the model actually accepts.
 */

const settings = (o: Partial<GenerationRequestSettings> = {}): GenerationRequestSettings => ({
  durationSeconds: 5,
  resolution: "1080p",
  aspectRatio: "16:9",
  cameraMotion: null,
  negativePrompt: null,
  ...o,
});

describe("OpenVideo capability descriptor", () => {
  it("names the verified provider and model", () => {
    expect(OPEN_VIDEO_CAPABILITY.providerName).toBe("wavespeed");
    expect(OPEN_VIDEO_CAPABILITY.providerModelId).toBe("wavespeed-ai/open-video/image-to-video");
  });

  it("declares the documented duration range of 3-20 integer seconds", () => {
    expect(OPEN_VIDEO_CAPABILITY.durationSeconds).toEqual({
      kind: "RANGE",
      minSeconds: 3,
      maxSeconds: 20,
    });
  });

  it("declares exactly the documented resolutions", () => {
    expect([...OPEN_VIDEO_CAPABILITY.resolutions]).toEqual(["480p", "720p", "1080p"]);
  });

  it("declares aspect ratio as composition-owned, not provider-honoured", () => {
    // The documented parameter table has no `aspect_ratio`. Claiming
    // PROVIDER_HONORED would be a lie; UNSUPPORTED would refuse every project,
    // since a VideoProject always carries a ratio.
    expect(OPEN_VIDEO_CAPABILITY.aspectRatios).toEqual({ kind: "COMPOSITION_OWNED" });
  });

  it("declares a user negative prompt unsupported", () => {
    expect(OPEN_VIDEO_CAPABILITY.negativePrompt).toEqual({ kind: "UNSUPPORTED" });
  });

  it("declares camera motion as prompt-rendered", () => {
    expect(OPEN_VIDEO_CAPABILITY.cameraMotion).toEqual({ kind: "PROMPT_RENDERED" });
  });

  it("is frozen, so a caller cannot mutate the shared descriptor", () => {
    expect(Object.isFrozen(OPEN_VIDEO_CAPABILITY)).toBe(true);
  });

  it("is what the production provider hands out", () => {
    expect(createOpenVideoCapabilityProvider().current()).toBe(OPEN_VIDEO_CAPABILITY);
  });
});

describe("admission against the real descriptor", () => {
  it("admits a typical request", () => {
    expect(() => assertSettingsSupported(settings(), OPEN_VIDEO_CAPABILITY)).not.toThrow();
  });

  it.each([3, 20])("admits the documented boundary duration %s", (durationSeconds) => {
    expect(() =>
      assertSettingsSupported(settings({ durationSeconds }), OPEN_VIDEO_CAPABILITY),
    ).not.toThrow();
  });

  it.each([2, 21, 5.5])("refuses duration %s", (durationSeconds) => {
    expect(() =>
      assertSettingsSupported(settings({ durationSeconds }), OPEN_VIDEO_CAPABILITY),
    ).toThrow();
  });

  it.each(["480p", "720p", "1080p"])("admits resolution %s", (resolution) => {
    expect(() =>
      assertSettingsSupported(settings({ resolution }), OPEN_VIDEO_CAPABILITY),
    ).not.toThrow();
  });

  it("refuses an undocumented resolution", () => {
    expect(() => assertSettingsSupported(settings({ resolution: "4k" }), OPEN_VIDEO_CAPABILITY)).toThrow();
  });

  it("admits any aspect ratio, because composition owns the guarantee", () => {
    // This is the case that makes the product work at all: every VideoProject
    // carries a ratio, so a provider-side refusal here would block 100% of
    // admissions.
    for (const aspectRatio of ["16:9", "9:16", "1:1", "4:3"]) {
      expect(() =>
        assertSettingsSupported(settings({ aspectRatio }), OPEN_VIDEO_CAPABILITY),
      ).not.toThrow();
    }
  });

  it("refuses a project carrying a real user negative prompt", () => {
    expect(() =>
      assertSettingsSupported(settings({ negativePrompt: "no people" }), OPEN_VIDEO_CAPABILITY),
    ).toThrow();
  });

  it("admits a blank negative prompt, which is absent rather than requested", () => {
    for (const negativePrompt of [null, "", "   "]) {
      expect(() =>
        assertSettingsSupported(settings({ negativePrompt }), OPEN_VIDEO_CAPABILITY),
      ).not.toThrow();
    }
  });

  it("admits a camera motion, which the prompt input carries", () => {
    expect(() =>
      assertSettingsSupported(settings({ cameraMotion: "slow push in" }), OPEN_VIDEO_CAPABILITY),
    ).not.toThrow();
  });
});

/** The three secrets that have no schema default. */
const SECRETS = {
  SESSION_SECRET: "x".repeat(16),
  HEALTHCHECK_API_TOKEN: "y".repeat(16),
  STORAGE_SIGNING_SECRET: "z".repeat(16),
};

describe("model identity is single-sourced", () => {
  it("uses the same id as the configured environment default", () => {
    // One constant feeds both. Before Phase 4B-2a the id was a bare literal in
    // the env schema *and* an unread `WaveSpeedConfig.modelId`, so the
    // descriptor and the configured default could drift apart unnoticed.
    // The schema is parsed directly rather than through `loadServerEnv`, which
    // memoizes process-wide and would leak state between test files. Only the
    // two secrets have no default, so that is all this fixture supplies; the
    // model id comes from the schema's own default.
    const env = serverEnvSchema.parse({ ...SECRETS });
    expect(env.WAVESPEED_VIDEO_MODEL_ID).toBe(WAVESPEED_OPEN_VIDEO_MODEL_ID);
    expect(OPEN_VIDEO_CAPABILITY.providerModelId).toBe(WAVESPEED_OPEN_VIDEO_MODEL_ID);
    expect(OPEN_VIDEO_CAPABILITY.providerModelId).toBe(env.WAVESPEED_VIDEO_MODEL_ID);
  });
});

describe("documented request fields", () => {
  it("lists exactly the always-sent documented parameters", () => {
    expect([...OPEN_VIDEO_REQUEST_FIELDS]).toEqual(["image", "prompt", "duration", "resolution"]);
  });

  it("lists seed as the only documented optional parameter", () => {
    expect([...OPEN_VIDEO_OPTIONAL_REQUEST_FIELDS]).toEqual(["seed"]);
  });

  it.each(["aspect_ratio", "negative_prompt", "camera_motion", "preset"])(
    "does not treat %s as a documented field",
    (field) => {
      const all: readonly string[] = [
        ...OPEN_VIDEO_REQUEST_FIELDS,
        ...OPEN_VIDEO_OPTIONAL_REQUEST_FIELDS,
      ];
      expect(all).not.toContain(field);
    },
  );
});

/**
 * The Phase 4B-2a review blocker: a conflicting model override.
 *
 * `WAVESPEED_VIDEO_MODEL_ID` accepted any non-empty string while the capability
 * descriptor hard-coded the OpenVideo constant. Setting it to another id split
 * the system in two — the self-check exercised the configured model, while
 * admission validated against OpenVideo's capabilities and froze OpenVideo's id
 * onto the row, so a later submission would have paid OpenVideo for work the
 * operator configured elsewhere.
 *
 * These cases fail against the pre-fix schema, which accepted the override.
 */
describe("a conflicting model override fails closed", () => {
  it("accepts the supported id stated explicitly", () => {
    const env = serverEnvSchema.parse({
      ...SECRETS,
      WAVESPEED_VIDEO_MODEL_ID: WAVESPEED_OPEN_VIDEO_MODEL_ID,
    });
    expect(env.WAVESPEED_VIDEO_MODEL_ID).toBe(OPEN_VIDEO_CAPABILITY.providerModelId);
  });

  it.each([
    ["another vendor's model", "vendor/other-model"],
    ["a plausible sibling", "wavespeed-ai/open-video/text-to-video"],
    ["a near miss", "wavespeed-ai/open-video/image-to-video "],
  ])("refuses %s", (_label, WAVESPEED_VIDEO_MODEL_ID) => {
    const result = serverEnvSchema.safeParse({ ...SECRETS, WAVESPEED_VIDEO_MODEL_ID });
    expect(result.success).toBe(false);
    const paths = result.success ? [] : result.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("WAVESPEED_VIDEO_MODEL_ID");
  });

  it("cannot let self-check and admission hold different model identities", () => {
    // Everything that reads the configured id — health and worker self-checks —
    // and everything that reads the descriptor — admission — now provably agree,
    // because a value that disagreed would not parse at all.
    const configured = serverEnvSchema.parse({ ...SECRETS }).WAVESPEED_VIDEO_MODEL_ID;
    expect(configured).toBe(OPEN_VIDEO_CAPABILITY.providerModelId);
    expect(serverEnvSchema.safeParse({ ...SECRETS, WAVESPEED_VIDEO_MODEL_ID: "vendor/x" }).success).toBe(
      false,
    );
  });

  it("does not turn the constraint into multi-model routing", () => {
    // Exactly one production descriptor, and no selection mechanism.
    expect(createOpenVideoCapabilityProvider().current()).toBe(OPEN_VIDEO_CAPABILITY);
    expect(OPEN_VIDEO_CAPABILITY.providerModelId).toBe(WAVESPEED_OPEN_VIDEO_MODEL_ID);
  });
});

describe("a frozen generation model id survives configuration", () => {
  it("submits to input.modelId, never to the configured default", () => {
    // The submission mapping reads the frozen id off the request, so an
    // already-admitted generation executes against the model it was admitted
    // under even if configuration later changes.
    const frozen = "some-vendor/frozen-model";
    const req = mapToWaveSpeedRequest(
      {
        modelId: frozen,
        sourceImageUrl: "https://storage.internal/o/img",
        prompt: "p",
        durationSeconds: 5,
        aspectRatio: "16:9",
        resolution: "1080p",
        requestHash: "h",
      },
      "https://api.wavespeed.ai/api/v3",
    );
    expect(req.url).toBe("https://api.wavespeed.ai/api/v3/some-vendor/frozen-model");
    expect(req.url).not.toContain(WAVESPEED_OPEN_VIDEO_MODEL_ID);
  });
});

/**
 * The declaration follows the behaviour, never the reverse.
 *
 * Phase 4B-2a declared `cameraMotion: PROMPT_RENDERED` as a promise about a
 * renderer that did not exist yet, and said so at the point of definition
 * rather than writing a test that could only restate the constant. Phase 4B-2b
 * builds the renderer, so the promise becomes checkable — and that is what
 * these assertions do. They are the completion condition of this milestone.
 */
describe("the PROMPT_RENDERED promise, now that a renderer exists", () => {
  const MOTION: CameraMotion = "SLOW_DOLLY_FORWARD";
  /** The reviewed sentence the renderer emits for that token. */
  const MOTION_TEXT = "Move the camera slowly forward into the room.";

  /** The renderer's input is the persisted column, so build that. */
  function storedWithMotion(cameraMotion: CameraMotion | null): string {
    return JSON.stringify(compiledWithMotion(cameraMotion));
  }

  function compiledWithMotion(cameraMotion: CameraMotion | null): CompiledPrompt {
    return {
      preservation: [...PRESERVATION_RULES],
      sceneFacts: {
        assetId: "ast_1",
        position: 1,
        roomType: "LIVING_ROOM",
        durationSeconds: 6,
        cameraMotion,
      },
      userCustomization: null,
      negativeConstraints: { system: [...SYSTEM_NEGATIVE_CONSTRAINTS], user: null },
    };
  }

  it("renders camera motion into the documented prompt field", () => {
    // The whole basis of the declaration: the model has no motion parameter,
    // so the only faithful delivery is through `prompt`.
    const req = mapToWaveSpeedRequest(
      {
        modelId: WAVESPEED_OPEN_VIDEO_MODEL_ID,
        sourceImageUrl: "https://storage.internal/o/img",
        prompt: renderPrompt(storedWithMotion(MOTION)),
        durationSeconds: 6,
        aspectRatio: "16:9",
        resolution: "1080p",
        requestHash: "h",
      },
      "https://api.wavespeed.ai/api/v3",
    );
    expect(req.body.prompt).toContain(MOTION_TEXT);
  });

  it("declares cameraMotion to match what the renderer actually does", () => {
    // If the renderer stops carrying motion, this does not fail loosely — it
    // demands the descriptor be corrected to UNSUPPORTED. Softening the test
    // to keep the declaration is the one repair that is not available.
    const carried =
      renderPrompt(storedWithMotion(MOTION)).includes(MOTION_TEXT) &&
      !renderPrompt(storedWithMotion(null)).includes(MOTION_TEXT);
    expect(OPEN_VIDEO_CAPABILITY.cameraMotion).toEqual({
      kind: carried ? "PROMPT_RENDERED" : "UNSUPPORTED",
    });
  });

  it("keeps negativePrompt UNSUPPORTED honest: the renderer refuses to deliver one", () => {
    // `UNSUPPORTED` means a project carrying user negative text is refused at
    // admission. It must not mean the text is folded into the positive prompt,
    // which would invert it, nor silently dropped, which would discard a stated
    // customer requirement. A stored row that carries one fails closed.
    const withUserNegative = JSON.stringify({
      ...compiledWithMotion(MOTION),
      negativeConstraints: {
        system: [...SYSTEM_NEGATIVE_CONSTRAINTS],
        user: "SENTINEL_USER_NEGATIVE_TEXT",
      },
    } satisfies CompiledPrompt);
    expect(OPEN_VIDEO_CAPABILITY.negativePrompt).toEqual({ kind: "UNSUPPORTED" });
    expect(() => renderPrompt(withUserNegative)).toThrow(AppError);
    try {
      renderPrompt(withUserNegative);
    } catch (error) {
      expect((error as AppError).message).not.toContain("SENTINEL_USER_NEGATIVE_TEXT");
    }
  });
});
