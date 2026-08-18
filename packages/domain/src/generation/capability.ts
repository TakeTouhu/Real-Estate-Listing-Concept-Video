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
 * **Who guarantees the delivered aspect ratio** — not whether a request field
 * exists.
 *
 * The distinction is the whole reason this type exists, and it is deliberately
 * three-way rather than two. "The endpoint documents no `aspect_ratio`
 * parameter" is not evidence that a requested ratio is satisfied; it is only
 * evidence that the *provider* is not the one satisfying it. Collapsing that
 * into a boolean forces a false choice between claiming support the provider
 * does not offer and refusing work the system can still deliver correctly.
 *
 * - `PROVIDER_HONORED` — the model accepts a ratio and delivers it. The request
 *   is validated against the listed values.
 * - `COMPOSITION_OWNED` — the provider is never asked. The requested ratio
 *   stays a durable product fact and part of the request identity, and the
 *   **composition stage** normalizes the delivered video to it. Admission
 *   accepts without provider-value validation, because the provider's opinion
 *   is irrelevant to a guarantee it does not make. This is not "ignore the
 *   request" — it moves the obligation, and ADR-0019 records where it landed.
 * - `UNSUPPORTED` — nothing in the system can deliver a requested ratio, so a
 *   project asking for one is refused rather than quietly served an unknown
 *   shape.
 */
export type AspectRatioSupport =
  | { readonly kind: "PROVIDER_HONORED"; readonly ratios: readonly string[] }
  | { readonly kind: "COMPOSITION_OWNED" }
  | { readonly kind: "UNSUPPORTED" };

/**
 * **How** an optional customer-authored input reaches the model, if at all.
 *
 * A dedicated API parameter is not the only faithful delivery mechanism. A
 * model whose documentation states that the prompt controls a behaviour can
 * express that intent through the prompt input — but only if something actually
 * renders it, which is why the two cases are named apart rather than both
 * called "supported".
 *
 * - `PROVIDER_FIELD` — a documented, dedicated request parameter carries it.
 * - `PROMPT_RENDERED` — no dedicated parameter exists, and the approved prompt
 *   renderer expresses the intent faithfully through the documented prompt
 *   input. **Declaring this is a claim about the renderer**, which the type
 *   system cannot check, so each provider that declares it owes a test tying
 *   the declaration to what its renderer actually does — the declaration
 *   follows the behaviour, never the reverse. `renderPrompt` is that renderer
 *   (ADR-0020); `packages/video-providers` holds the pin for the OpenVideo
 *   descriptor. A provider whose renderer does not carry the intent must
 *   declare `UNSUPPORTED` instead.
 * - `UNSUPPORTED` — the intent cannot be expressed at all, so a request
 *   carrying it is refused. It is never silently dropped, and never rewritten
 *   into some other field.
 */
export type FeatureDelivery =
  | { readonly kind: "PROVIDER_FIELD" }
  | { readonly kind: "PROMPT_RENDERED" }
  | { readonly kind: "UNSUPPORTED" };

export interface VideoModelCapability {
  readonly providerName: string;
  readonly providerModelId: string;
  readonly durationSeconds: DurationPolicy;
  readonly resolutions: readonly string[];
  readonly aspectRatios: AspectRatioSupport;
  /**
   * How a **user-authored** negative prompt reaches the model.
   *
   * `UNSUPPORTED` means a project carrying one must be refused — ADR-0014 keeps
   * system and user negative constraints structurally distinct, and dropping
   * the user's half silently would discard a stated customer requirement.
   * `PROMPT_RENDERED` is deliberately **not** a licence to fold negative text
   * into the positive prompt: that inverts its meaning, and no renderer may do
   * it (ADR-0019).
   */
  readonly negativePrompt: FeatureDelivery;
  readonly cameraMotion: FeatureDelivery;
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

/**
 * `W:H`, where both sides are positive numbers.
 *
 * Integers and decimals both occur in real use — `16:9`, `9:16`, `1:1`, `4:3`,
 * and cinematic ratios like `2.39:1`. A leading sign is not matched at all, so
 * `-16:9` fails here rather than needing a separate check.
 */
const ASPECT_RATIO_SYNTAX = /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/;

/**
 * Whether a string is a usable aspect ratio at all.
 *
 * Separate from, and prior to, the question of *who* honours it. Review found
 * that `COMPOSITION_OWNED` skipped every aspect-ratio check, so `"wide"` or
 * `"banana"` could be admitted, hashed into the request identity, frozen into
 * the immutable snapshot, and left durable as billable work — leaving the
 * composition stage a value it cannot normalize to. Moving the guarantee off the
 * provider must not mean nobody checks it.
 *
 * Reads only. Nothing here trims, rounds, or rewrites: `16:9` must stay exactly
 * `16:9`, because the string is a request-hash fact and any normalization would
 * silently change request identity.
 */
function isValidAspectRatioSyntax(value: string): boolean {
  if (!ASPECT_RATIO_SYNTAX.test(value)) return false;
  // The pattern admits `0:9` and `16:0`; a zero side is not a ratio.
  const [width, height] = value.split(":").map(Number);
  return width! > 0 && height! > 0;
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

  // Syntax first, and for every ownership kind. A value nobody can interpret is
  // refused before the question of who honours it even arises — otherwise
  // `COMPOSITION_OWNED` would admit billable work with a ratio the composition
  // stage cannot normalize to.
  if (!isValidAspectRatioSyntax(settings.aspectRatio)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `"${settings.aspectRatio}" is not a valid aspect ratio; use a width:height ratio such as 16:9`,
    );
  }

  // Aspect ratio is decided by WHO guarantees it, not by whether a request
  // field exists.
  //
  // COMPOSITION_OWNED accepts without checking the value against the provider,
  // because the provider is never asked for it. The requested ratio remains a
  // durable product fact and part of the request identity; the composition
  // stage owns delivering it (ADR-0019), and Phase 5 is not complete while a
  // requested ratio can be silently ignored. UNSUPPORTED still refuses, for the
  // case where nothing in the system can deliver one.
  if (capability.aspectRatios.kind === "UNSUPPORTED") {
    throw new AppError(
      "VALIDATION_FAILED",
      "This model cannot be relied on to deliver a chosen aspect ratio; the project requests one",
    );
  }
  if (
    capability.aspectRatios.kind === "PROVIDER_HONORED" &&
    !capability.aspectRatios.ratios.includes(settings.aspectRatio)
  ) {
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
  // Only UNSUPPORTED refuses. PROVIDER_FIELD and PROMPT_RENDERED are both
  // faithful deliveries — the second still reaches the model, just through the
  // documented prompt input rather than a dedicated parameter.
  if (isProvided(settings.negativePrompt) && capability.negativePrompt.kind === "UNSUPPORTED") {
    throw new AppError(
      "VALIDATION_FAILED",
      "This model does not honour a negative prompt; remove it or choose another model",
    );
  }
  if (settings.cameraMotion !== null && capability.cameraMotion.kind === "UNSUPPORTED") {
    throw new AppError(
      "VALIDATION_FAILED",
      "This model does not honour a camera motion; remove it or choose another model",
    );
  }
}
