import { AppError } from "@app/shared";

/**
 * What a configured provider **model** can actually do.
 *
 * Provider-neutral by construction: no vendor names, no request-field names, no
 * environment variables. The adapter/config layer owns the *values*; this module
 * owns only their shape and the rule applied to them (ADR-0016 keeps provider
 * specifics out of the domain).
 *
 * **Phase 4B-1a deliberately ships no real values.** The configured WaveSpeed
 * model's capabilities are not yet verified against an authoritative source, and
 * inventing them would defeat the purpose of validating at all. Phase 4B-2 owns
 * the descriptor; everything here is exercised with clearly-marked test
 * fixtures.
 */

/**
 * How a model expresses the durations it accepts.
 *
 * Both forms exist because real models differ: some document a continuous
 * integer range, others a fixed set of clip lengths. Collapsing them into one
 * would force a lie about whichever model does not fit.
 */
export type DurationPolicy =
  | { readonly kind: "RANGE"; readonly minSeconds: number; readonly maxSeconds: number }
  | { readonly kind: "ENUMERATED"; readonly seconds: readonly number[] };

/**
 * Whether the model can honour the product's **aspect-ratio contract**.
 *
 * This is a statement about the delivered video, not about request fields, and
 * the distinction is the whole reason this type exists. "The endpoint documents
 * no `aspect_ratio` parameter" is **not** evidence that a requested ratio is
 * satisfied — it is evidence that we do not know how to ask for one. Treating
 * absence as support would silently ship videos in whatever shape the model
 * happens to produce while the customer believes they chose.
 *
 * So `UNSUPPORTED` means: this model cannot be relied on to deliver a requested
 * ratio, and a project that asks for one must be refused rather than quietly
 * served. It never means "ignore the request".
 */
export type AspectRatioSupport =
  | { readonly kind: "SUPPORTED"; readonly ratios: readonly string[] }
  | { readonly kind: "UNSUPPORTED" };

/** Whether an optional customer-authored input reaches the model meaningfully. */
export type FeatureSupport = "SUPPORTED" | "UNSUPPORTED";

export interface VideoModelCapability {
  readonly providerName: string;
  readonly providerModelId: string;
  readonly durationSeconds: DurationPolicy;
  readonly resolutions: readonly string[];
  readonly aspectRatios: AspectRatioSupport;
  /**
   * Whether the model honours a negative prompt. `UNSUPPORTED` means a project
   * carrying one must be refused — ADR-0014 keeps system and user negative
   * constraints structurally distinct, and dropping the user's half silently
   * would discard a stated customer requirement.
   */
  readonly negativePrompt: FeatureSupport;
  readonly cameraMotion: FeatureSupport;
}

/** The port through which orchestration learns what the configured model can do. */
export interface VideoModelCapabilityProvider {
  /** The capability of the currently configured provider and model. */
  current(): VideoModelCapability;
}

/**
 * The settings one generation request would need the model to honour.
 *
 * Assembled by the caller from the project and the scene. Deliberately **not**
 * the compiled prompt: capability validation asks "can this model produce what
 * was asked for", never "what should we send", so nothing here flattens
 * `CompiledPrompt` (ADR-0014).
 */
export interface GenerationRequestSettings {
  readonly durationSeconds: number;
  readonly resolution: string;
  readonly aspectRatio: string;
  readonly cameraMotion: string | null;
  readonly negativePrompt: string | null;
}

/**
 * Whether a customer-authored optional field carries anything real.
 *
 * Blank and whitespace-only text is **absent**, not empty — the same meaning
 * `compileScenePrompt`'s `normalize` already applies, which is what makes this
 * correct rather than merely convenient. A project whose negative prompt is
 * `"   "` compiles to `userNegative: null`, so the model never sees it; refusing
 * such a request for lacking negative-prompt support would block work over a
 * field that was never going to be sent.
 *
 * Reads the string, never rewrites it. The stored project value is untouched —
 * this is capability *interpretation*, not normalization.
 */
function isProvided(text: string | null): boolean {
  return text !== null && text.trim().length > 0;
}

function durationAccepted(seconds: number, policy: DurationPolicy): boolean {
  if (!Number.isInteger(seconds) || seconds <= 0) return false;
  return policy.kind === "RANGE"
    ? seconds >= policy.minSeconds && seconds <= policy.maxSeconds
    : policy.seconds.includes(seconds);
}

function describeDuration(policy: DurationPolicy): string {
  return policy.kind === "RANGE"
    ? `${policy.minSeconds}–${policy.maxSeconds} seconds`
    : `${policy.seconds.join(", ")} seconds`;
}

/**
 * Refuse a request the configured model cannot satisfy.
 *
 * Pure: it reads its two arguments, mutates nothing, and touches no
 * environment, clock, or network. Given the same inputs it always reaches the
 * same verdict.
 *
 * It exists to run **before** anything billable can happen. Every check here is
 * a fact the provider would otherwise discover after being paid — or worse, not
 * discover at all, delivering something the customer did not ask for.
 *
 * Throws `VALIDATION_FAILED`, the same code every other domain rule uses for a
 * refusal a human can act on. Messages describe the model's limits, which are
 * configuration rather than secrets.
 */
export function assertSettingsSupported(
  settings: GenerationRequestSettings,
  capability: VideoModelCapability,
): void {
  if (!durationAccepted(settings.durationSeconds, capability.durationSeconds)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `This model supports ${describeDuration(capability.durationSeconds)}; the scene asks for ${settings.durationSeconds}`,
    );
  }

  if (!capability.resolutions.includes(settings.resolution)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `This model supports the resolutions ${capability.resolutions.join(", ")}; the project asks for ${settings.resolution}`,
    );
  }

  // Absence of a request parameter is not support. A project that asked for a
  // ratio is refused rather than served an unknown shape.
  if (capability.aspectRatios.kind === "UNSUPPORTED") {
    throw new AppError(
      "VALIDATION_FAILED",
      "This model cannot be relied on to deliver a chosen aspect ratio; the project requests one",
    );
  }
  if (!capability.aspectRatios.ratios.includes(settings.aspectRatio)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `This model supports the aspect ratios ${capability.aspectRatios.ratios.join(", ")}; the project asks for ${settings.aspectRatio}`,
    );
  }

  // The optional customer-authored inputs. Each is refused only when actually
  // requested: a project that never set one is unaffected by the model lacking
  // it, and refusing then would block work for no benefit.
  //
  // "Requested" follows prompt compilation's own meaning — blank and
  // whitespace-only text is absent. `cameraMotion` deliberately uses a plain
  // null check instead: `createProject` stores it as given without trimming,
  // nothing normalizes it downstream, and it reaches the provider as stored.
  // Treating a blank one as absent here would make this rule disagree with what
  // the request actually is, including the request hash.
  if (isProvided(settings.negativePrompt) && capability.negativePrompt === "UNSUPPORTED") {
    throw new AppError(
      "VALIDATION_FAILED",
      "This model does not honour a negative prompt; remove it or choose another model",
    );
  }
  if (settings.cameraMotion !== null && capability.cameraMotion === "UNSUPPORTED") {
    throw new AppError(
      "VALIDATION_FAILED",
      "This model does not honour a camera motion; remove it or choose another model",
    );
  }
}
