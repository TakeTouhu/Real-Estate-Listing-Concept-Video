import { AppError } from "@app/shared";
import type { RoomType } from "../analysis/types";
import type { ModerationFinding, PromptModerator } from "./moderation";

/**
 * The mandatory preservation rules, verbatim from `docs/AIVideoPipeline.md`.
 *
 * Frozen, and copied into every compiled prompt: a caller that mutates what it
 * receives cannot affect the next compilation.
 */
export const PRESERVATION_RULES: readonly string[] = Object.freeze([
  "Preserve visible structure, windows, doors, equipment, materials, and finishes as far as technically possible.",
  "Do not add nonexistent furniture, equipment, views, openings, or rooms.",
  "Do not change material or apparent room size.",
  "Do not add people or fictional logos.",
]);

/** System-authored negatives, kept apart from anything the customer wrote. */
export const SYSTEM_NEGATIVE_CONSTRAINTS: readonly string[] = Object.freeze([
  "people",
  "fictional logos or branding",
  "invented windows, doors, or rooms",
  "text overlays claiming measurements or floor plans",
]);

/** What the storyboard knows about the scene. System-derived, never user text. */
export interface SceneFacts {
  readonly assetId: string;
  readonly position: number;
  /** Null stays null — an unclassified room is never guessed into a label. */
  readonly roomType: RoomType | null;
  readonly durationSeconds: number;
  readonly cameraMotion: string | null;
}

/**
 * A compiled prompt as **structure**, not an interpolated string.
 *
 * The five parts never merge. That separation — not phrase detection — is the
 * integrity mechanism: user text sits in `userCustomization` and
 * `negativeConstraints.user`, where nothing reads it as an instruction about
 * the constraints, so "ignore previous instructions" is just characters in a
 * data field. Rendering to a provider payload is Phase 4's job, and it must
 * preserve this separation (ADR-0014).
 */
export interface CompiledPrompt {
  readonly preservation: readonly string[];
  readonly sceneFacts: SceneFacts;
  /** Untrusted. Moderated before it gets here; still only ever data. */
  readonly userCustomization: string | null;
  readonly negativeConstraints: {
    readonly system: readonly string[];
    /** Untrusted, and structurally distinct from the system list above. */
    readonly user: string | null;
  };
}

export interface CompileScenePromptInput {
  readonly sceneFacts: SceneFacts;
  readonly prompt?: string | null;
  readonly negativePrompt?: string | null;
}

/** Blank and whitespace-only text is absent, not empty. */
function normalize(text: string | null | undefined): string | null {
  const trimmed = (text ?? "").trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Compile one scene's prompt, moderating both user-authored fields first.
 *
 * The moderator sees each non-empty field **exactly once**. A rejection is
 * terminal: nothing is retried, rephrased, or partially accepted, because a
 * customer asking for a prohibited edit needs to change the request rather than
 * have the system try again.
 *
 * The thrown error carries only field/code pairs and fixed sentences chosen by
 * code. The offending text is never in the message, never in `details`, and so
 * never reaches a log through this path.
 *
 * @throws AppError VALIDATION_FAILED when either field is rejected.
 */
export async function compileScenePrompt(
  input: CompileScenePromptInput,
  moderator: PromptModerator,
): Promise<CompiledPrompt> {
  const userCustomization = normalize(input.prompt);
  const userNegative = normalize(input.negativePrompt);

  const findings: ModerationFinding[] = [];
  for (const [field, text] of [
    ["prompt", userCustomization],
    ["negativePrompt", userNegative],
  ] as const) {
    if (text === null) continue;
    const verdict = await moderator.moderate({ field, text });
    if (!verdict.allowed) findings.push(...verdict.findings);
  }

  if (findings.length > 0) {
    throw new AppError("VALIDATION_FAILED", "The prompt was rejected by content review", {
      details: { findings },
    });
  }

  return {
    preservation: [...PRESERVATION_RULES],
    sceneFacts: input.sceneFacts,
    userCustomization,
    negativeConstraints: {
      system: [...SYSTEM_NEGATIVE_CONSTRAINTS],
      user: userNegative,
    },
  };
}
