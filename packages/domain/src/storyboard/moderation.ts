/**
 * Moderation of the two user-authored prompt fields.
 *
 * This is **not** the prompt-injection defence. Injection is handled
 * structurally by `CompiledPrompt`, which keeps untrusted text in its own
 * fields where it can never displace a preservation constraint (ADR-0014). The
 * moderator's job is narrower: catch a customer *explicitly* asking for
 * something the product rules forbid.
 */

/** Which untrusted field a finding came from. Both are user-authored. */
export type ModerationField = "prompt" | "negativePrompt";

/**
 * Coded findings, never vendor prose. A future vendor adapter normalizes into
 * this vocabulary, so callers never surface a third party's wording.
 *
 * Every code traces to a documented product rule — nothing here was invented:
 * the first four to `docs/AIVideoPipeline.md` "Mandatory preservation rules",
 * the last to the same section read in reverse (a negative prompt that asks for
 * preservation to stop).
 */
export type ModerationCode =
  | "ADDS_NONEXISTENT_FEATURE"
  | "ALTERS_MATERIAL_OR_SIZE"
  | "ADDS_PEOPLE_OR_LOGOS"
  | "CLAIMS_MEASURED_GEOMETRY"
  | "DEFEATS_PRESERVATION";

/** What failed and where — carrying no trace of the text that failed. */
export interface ModerationFinding {
  readonly field: ModerationField;
  readonly code: ModerationCode;
}

export type ModerationVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly findings: readonly ModerationFinding[] };

export interface ModerationRequest {
  readonly field: ModerationField;
  /** Untrusted text. Never logged, echoed, or excerpted into a verdict. */
  readonly text: string;
}

export interface PromptModerator {
  /** Adapter name for diagnostics. Not a secret, not customer-facing. */
  readonly name: string;
  moderate(request: ModerationRequest): Promise<ModerationVerdict>;
}

/** Fixed, sanitized sentences. Chosen by code, never built from input. */
export const MODERATION_MESSAGES: Record<ModerationCode, string> = {
  ADDS_NONEXISTENT_FEATURE:
    "The prompt asks to add a feature the photo does not show. Generated video must not invent windows, doors, rooms, views, or equipment.",
  ALTERS_MATERIAL_OR_SIZE:
    "The prompt asks to change a material or make the space look larger. That would misrepresent the property.",
  ADDS_PEOPLE_OR_LOGOS:
    "The prompt asks to add people or a logo. Generated video must show only the property.",
  CLAIMS_MEASURED_GEOMETRY:
    "The prompt claims accurate dimensions, geometry, or real captured footage. Generated video cannot make that claim.",
  DEFEATS_PRESERVATION:
    "The negative prompt asks to stop preserving what the photo shows. Preservation rules cannot be switched off.",
};

interface Rule {
  readonly code: ModerationCode;
  readonly pattern: RegExp;
  /**
   * `positive` fires on a plain request ("add people") and is suppressed when
   * negated ("do not add people"). `negated` is the reverse: it fires only when
   * a preservation verb is negated ("do not preserve the walls").
   */
  readonly polarity: "positive" | "negated";
}

/**
 * A deliberately narrow, documented set. Not a general blacklist, not semantic
 * moderation, and **not** the injection defence: it detects explicit requests
 * for the four documented prohibitions plus an attempt to switch preservation
 * off. False negatives are expected and accepted — a paraphrase will pass. It
 * exists so a blatant violation is caught offline, and it is replaceable by a
 * real moderation vendor behind {@link PromptModerator} without touching a
 * caller.
 */
const RULES: readonly Rule[] = [
  {
    code: "ADDS_NONEXISTENT_FEATURE",
    pattern:
      /\badd(?:s|ing)?\b[^.;]{0,40}?\b(window|windows|door|doors|room|rooms|balcony|view|views|opening|openings|furniture|equipment)\b/i,
    polarity: "positive",
  },
  {
    code: "ALTERS_MATERIAL_OR_SIZE",
    pattern:
      /\b(?:make|makes|making|render|renders)\b[^.;]{0,40}?\b(larger|bigger|wider|roomier|more spacious)\b|\bchange\b[^.;]{0,30}?\b(material|materials|flooring|finish|finishes)\b/i,
    polarity: "positive",
  },
  {
    code: "ADDS_PEOPLE_OR_LOGOS",
    pattern:
      /\badd(?:s|ing)?\b[^.;]{0,40}?\b(people|person|persons|family|model|models|logo|logos)\b/i,
    polarity: "positive",
  },
  {
    code: "CLAIMS_MEASURED_GEOMETRY",
    pattern:
      /\b(exact|accurate|measured|true|actual)\b[^.;]{0,30}?\b(dimension|dimensions|measurement|measurements|floor ?plan|geometry|footage)\b/i,
    polarity: "positive",
  },
  {
    code: "DEFEATS_PRESERVATION",
    pattern: /\b(preserve|preserving|keep|keeping|retain|retaining|maintain|maintaining)\b/i,
    polarity: "negated",
  },
];

/** Words immediately before a match that flip it from a request to a ban. */
const NEGATION = /\b(?:do not|don'?t|never|no|without|avoid|exclude|stop)\b[\s\w]{0,24}$/i;

function isNegated(text: string, matchIndex: number): boolean {
  return NEGATION.test(text.slice(Math.max(0, matchIndex - 32), matchIndex));
}

/**
 * Offline moderator: deterministic, no network, no vendor.
 *
 * Polarity is the one piece of nuance it carries, and it is there for a real
 * reason: a negative prompt legitimately says "do not add people", which must
 * not be read as a request to add people. The same machinery lets
 * "do not preserve the original walls" be caught, since that negates a
 * preservation verb rather than a prohibited action.
 */
export function createOfflinePromptModerator(): PromptModerator {
  return {
    name: "offline-documented-rules",
    moderate({ field, text }: ModerationRequest): Promise<ModerationVerdict> {
      const findings: ModerationFinding[] = [];
      for (const rule of RULES) {
        const match = rule.pattern.exec(text);
        if (!match) continue;
        const negated = isNegated(text, match.index);
        if (rule.polarity === "positive" ? !negated : negated) {
          findings.push({ field, code: rule.code });
        }
      }
      return Promise.resolve(
        findings.length === 0 ? { allowed: true } : { allowed: false, findings },
      );
    },
  };
}
