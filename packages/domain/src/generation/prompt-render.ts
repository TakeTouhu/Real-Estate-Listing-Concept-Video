import { AppError } from "@app/shared";
import { isRoomType } from "../analysis/types";
import { isCameraMotion, type CameraMotion } from "../storyboard/camera-motion";
import {
  PRESERVATION_RULES,
  SYSTEM_NEGATIVE_CONSTRAINTS,
  type CompiledPrompt,
  type SceneFacts,
} from "../storyboard/prompt";

/**
 * The single place a persisted generation request becomes the one string a
 * provider's documented `prompt` parameter can carry.
 *
 * **The boundary is the durable snapshot, not a typed object.** A generation
 * stores `requestCompiledPrompt` as an opaque JSON string (ADR-0018), so that
 * is what this function accepts. An earlier revision took an already-typed
 * `CompiledPrompt`, which left Phase 4C no honest way to get from the stored
 * column to the renderer except `JSON.parse(value) as CompiledPrompt` — an
 * unchecked cast that lets a corrupt or legacy row render as if it were valid.
 * Review found three reachable consequences of that, all fixed here: missing
 * preservation rules, missing system constraints, and a customer negative
 * prompt each produced a plausible, sendable prompt.
 *
 * It lives in the domain rather than beside an adapter because *what the model
 * is told* is product policy — the preservation rules are quoted from
 * `docs/AIVideoPipeline.md`, and a second provider must inherit them rather
 * than invent its own phrasing. The adapter's job stays narrow: put this string
 * in the field the vendor documents.
 *
 * **One renderer, one direction.** It reads the stored string and returns a
 * string. It never writes back, re-compiles, or normalizes what was stored.
 *
 * ADR-0020 records the format, what it costs, and what would reverse it.
 */

/**
 * Section headings, fixed and in this order.
 *
 * The order is the design, not formatting. Preservation rules and system
 * constraints are structurally **prior** to everything the customer influenced,
 * so nothing the customer chose or typed is positioned as a preamble the rules
 * then appear to qualify.
 *
 * The two customer-influenced sections are not equivalent, and the headings say
 * which is which:
 *
 * - **Camera motion** is *customer-selected, system-constrained intent*. The
 *   customer picked a token from an approved vocabulary; every word emitted
 *   here is written by us (ADR-0022). It carries no "the rules take precedence"
 *   caveat because there is no customer text in it to caveat — but it still
 *   renders after the rules, because the customer chose the intent.
 * - **Styling** is genuinely customer-authored text, moderated at compilation
 *   and emitted verbatim. Its caveat is a **mitigation, not a control**: once
 *   flattened into one field the model is free to ignore it. The control is
 *   that the text is moderated before compilation and can only ever land inside
 *   this one delimited region (ADR-0014, ADR-0020 §4).
 */
const PRESERVATION_HEADING = "Preservation rules:";
const AVOID_HEADING = "Avoid:";
const CAMERA_MOTION_HEADING = "Camera motion (customer-selected):";
const CUSTOMIZATION_HEADING =
  "Styling requested by the customer (the rules above take precedence):";

/**
 * Refuse to render, without saying anything about the data.
 *
 * Every `reason` passed here is a **fixed sentence chosen by code**, never
 * derived from the stored value — so no compiled prompt, customer
 * customization, customer negative text, room type, asset id, generation id,
 * request hash, tenant id, or credential can reach a message, a log, or an
 * audit entry through this path. The reasons are distinct because an operator
 * needs to know *which* invariant failed; none of them needs the content to
 * say so.
 *
 * `INTERNAL_ERROR` rather than `VALIDATION_FAILED`: every condition below is
 * impossible for a request admitted through `GenerationService`, so reaching
 * one means stored state disagrees with the code that wrote it. That is not
 * something a customer can act on.
 */
function reject(reason: string): never {
  throw new AppError(
    "INTERNAL_ERROR",
    `The stored generation request cannot be rendered: ${reason}`,
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** Same members, same order — not merely "contains". */
function sameSequence(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((item, i) => item === expected[i]);
}

/**
 * Parse the stored snapshot into a `CompiledPrompt`, or refuse.
 *
 * `JSON.parse` succeeding is not evidence of anything. Every field the renderer
 * reads is checked here, so no property access downstream can meet `undefined`
 * and throw a raw `TypeError` instead of a neutral domain error.
 */
function parseCompiledPrompt(storedJson: string): CompiledPrompt {
  let raw: unknown;
  try {
    raw = JSON.parse(storedJson);
  } catch {
    reject("it is not valid JSON");
  }

  const root = asRecord(raw);
  if (root === null) reject("it is not a JSON object");
  if (!isStringArray(root.preservation)) reject("its preservation rules are missing or malformed");
  if (!isNullableString(root.userCustomization)) {
    reject("its customer customization is malformed");
  }

  const facts = asRecord(root.sceneFacts);
  if (facts === null) reject("its scene facts are missing or malformed");
  if (typeof facts.assetId !== "string") reject("its scene facts are malformed");
  if (typeof facts.position !== "number") reject("its scene facts are malformed");
  if (typeof facts.durationSeconds !== "number") reject("its scene facts are malformed");
  if (facts.cameraMotion !== null && !isCameraMotion(facts.cameraMotion)) {
    reject("its scene facts name an unapproved camera motion");
  }
  if (facts.roomType !== null && !isRoomType(facts.roomType)) {
    reject("its scene facts name an unknown room type");
  }

  const negative = asRecord(root.negativeConstraints);
  if (negative === null) reject("its negative constraints are missing or malformed");
  if (!isStringArray(negative.system)) reject("its system constraints are missing or malformed");
  if (!isNullableString(negative.user)) reject("its customer negative constraint is malformed");

  const sceneFacts: SceneFacts = {
    assetId: facts.assetId,
    position: facts.position,
    roomType: facts.roomType === null ? null : facts.roomType,
    durationSeconds: facts.durationSeconds,
    cameraMotion: facts.cameraMotion,
  };

  return {
    preservation: root.preservation,
    sceneFacts,
    userCustomization: root.userCustomization,
    negativeConstraints: { system: negative.system, user: negative.user },
  };
}

/**
 * Refuse a structurally valid request whose **safety content** is not intact.
 *
 * Shape validation is not enough. Review found that an empty `preservation` or
 * an empty `negativeConstraints.system` rendered a complete, plausible,
 * sendable prompt carrying none of the product's rules — including
 * "text overlays claiming measurements or floor plans", which no preservation
 * rule covers and which `CLAUDE.md` states as a product rule.
 *
 * The check is **exact sequence equality** against the frozen constants, not a
 * subset or superset test, because `compileScenePrompt` writes exactly
 * `[...PRESERVATION_RULES]` and `[...SYSTEM_NEGATIVE_CONSTRAINTS]`. Anything
 * else is corruption: a missing rule silently weakens the request, and an extra
 * entry would render unreviewed text at system trust level.
 *
 * **Consequence, deliberately accepted.** Editing either constant invalidates
 * every generation already admitted and not yet executed — those fail closed
 * rather than executing under rules the customer's approved request never
 * described. That is the same drift this renderer is careful about elsewhere,
 * resolved in the safe direction: changing the rules is a re-admission event,
 * not a silent upgrade. ADR-0020 records it.
 */
function assertSafetyContentIntact(compiled: CompiledPrompt): void {
  if (!sameSequence(compiled.preservation, PRESERVATION_RULES)) {
    reject("its preservation rules are not the approved set");
  }
  if (!sameSequence(compiled.negativeConstraints.system, SYSTEM_NEGATIVE_CONSTRAINTS)) {
    reject("its system constraints are not the approved set");
  }
}

/**
 * Everything the rendered prompt is allowed to contain.
 *
 * This type is the structural half of two guarantees, and it is why rendering
 * is split from parsing rather than written as one function:
 *
 * - **The customer's negative prompt cannot reach the positive prompt.** There
 *   is no field here that could carry it, and `CompiledPrompt` is not
 *   assignable to this type, so it cannot be forwarded wholesale by accident.
 *   Folding a negative constraint into a positive instruction inverts its
 *   meaning, which is the one transformation no renderer may perform. A present
 *   customer negative is now refused outright before this point, so exclusion
 *   is the second line of defence rather than the only one.
 * - **Internal identifiers cannot leak into a provider payload.**
 *   `SceneFacts.assetId` and `SceneFacts.position` are storyboard bookkeeping;
 *   omitting the fields is stronger than remembering not to print them.
 *
 * `durationSeconds` is absent for a different reason: the provider carries it
 * in its own documented `duration` parameter, so restating it as prose would
 * give the model two sources for one fact and a way to disagree with the
 * request that was actually hashed and billed.
 */
interface PositivePromptParts {
  readonly roomType: SceneFacts["roomType"];
  readonly cameraMotion: CameraMotion | null;
  readonly preservation: readonly string[];
  readonly systemNegatives: readonly string[];
  readonly userCustomization: string | null;
}

/** Blank and whitespace-only text is absent, matching `compileScenePrompt`. */
function present(text: string | null): string | null {
  const trimmed = (text ?? "").trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** A heading followed by one `- ` item per line, or nothing if the list is empty. */
function bulleted(heading: string, items: readonly string[]): string | null {
  const kept = items.map((item) => present(item)).filter((item): item is string => item !== null);
  return kept.length === 0 ? null : [heading, ...kept.map((item) => `- ${item}`)].join("\n");
}

/** A heading followed by the text verbatim, or nothing if there is no text. */
function labelled(heading: string, text: string | null): string | null {
  const kept = present(text);
  return kept === null ? null : `${heading}\n${kept}`;
}

/**
 * The reviewed sentence each approved camera motion becomes.
 *
 * This mapping is **prompt-rendering policy**, which is why it lives with the
 * renderer and not with the vocabulary or the capability descriptor: the set of
 * intents a customer may choose is a product decision, while the words that
 * express one to a particular model are a rendering decision. A second model
 * may phrase the same token differently, or declare `cameraMotion:
 * PROVIDER_FIELD` and map it to a native parameter, without the vocabulary or
 * the UI changing (ADR-0022).
 *
 * Typed as a total `Record`, so adding a token to `CAMERA_MOTIONS` without
 * writing its sentence is a **compile error** rather than a token that silently
 * renders nothing.
 *
 * The phrasing is deliberately restrained. A single still photograph cannot
 * support aggressive movement, and overstating motion invites the model to
 * invent geometry the source image never showed — the failure the preservation
 * rules exist to prevent.
 */
const CAMERA_MOTION_PROMPT: Record<CameraMotion, string> = {
  STATIC: "Hold the camera still; no camera movement.",
  SLOW_DOLLY_FORWARD: "Move the camera slowly forward into the room.",
  SLOW_PAN_LEFT: "Pan the camera slowly to the left.",
  SLOW_PAN_RIGHT: "Pan the camera slowly to the right.",
};

/**
 * `LIVING_ROOM` → `living room`, and `null` → no line at all.
 *
 * An unclassified room stays unsaid. Writing "Room: unclassified" would spend
 * tokens telling the model something it cannot act on, and inventing a likely
 * label would be exactly the guess `SceneFacts.roomType` documents as
 * forbidden.
 */
function renderRoom(roomType: SceneFacts["roomType"]): string | null {
  return roomType === null ? null : `Room: ${roomType.toLowerCase().split("_").join(" ")}`;
}

function renderParts(parts: PositivePromptParts): string {
  return [
    renderRoom(parts.roomType),
    bulleted(PRESERVATION_HEADING, parts.preservation),
    bulleted(AVOID_HEADING, parts.systemNegatives),
    labelled(
      CAMERA_MOTION_HEADING,
      parts.cameraMotion === null ? null : CAMERA_MOTION_PROMPT[parts.cameraMotion],
    ),
    labelled(CUSTOMIZATION_HEADING, parts.userCustomization),
  ]
    .filter((section): section is string => section !== null)
    .join("\n\n");
}

/**
 * Render one stored generation request into the provider's `prompt` string.
 *
 * Takes `SceneGeneration.requestCompiledPrompt` — the immutable snapshot frozen
 * at admission (ADR-0018) — so execution never needs the mutable project or
 * storyboard to reconstruct what was approved.
 *
 * Pure and total: same stored string in, same prompt out, nothing mutated, no
 * clock, environment, or network read. That matters because the input is the
 * exact value the request hash covered — a renderer that varied by anything
 * else would send text the customer's approved request never described.
 *
 * **Camera motion is rendered here, and that is what makes a provider's
 * `cameraMotion: PROMPT_RENDERED` declaration true.** A model with no dedicated
 * motion parameter still receives the intent, through the input the vendor
 * documents as controlling motion. `packages/video-providers` pins the two
 * together: if this function stops carrying motion, the descriptor must become
 * `UNSUPPORTED` rather than the test being relaxed.
 *
 * Camera motion is also **customer-authored free text** — `createProject`
 * accepts whatever is typed — and unlike `prompt` and `negativePrompt` it does
 * not pass through the moderator. That is why it renders under a customer
 * heading below the rules rather than as a system fact above them, and why
 * `docs/decisions/TODO.md` records the moderation gap as an obligation rather
 * than this milestone quietly widening moderation.
 *
 * @throws AppError INTERNAL_ERROR when the stored request is not valid JSON,
 *   does not match the `CompiledPrompt` contract, does not carry the approved
 *   preservation rules and system constraints, or carries a customer negative
 *   prompt. Every message is a fixed sentence; none contains stored content.
 */
export function renderPrompt(requestCompiledPrompt: string): string {
  const compiled = parseCompiledPrompt(requestCompiledPrompt);
  assertSafetyContentIntact(compiled);

  // A customer negative prompt is refused — never rendered, never dropped.
  // Admission already refuses one, because every production model declares
  // `negativePrompt: UNSUPPORTED`, so reaching here means stored state
  // disagrees with the rule that admitted it. Silently omitting it would
  // discard a stated customer requirement; folding it into the positive prompt
  // would invert it. Neither is acceptable, so this fails closed.
  if (present(compiled.negativeConstraints.user) !== null) {
    reject("it carries a customer negative prompt, which no supported model honours");
  }

  // Every value the prompt may contain is named on the way in. What is absent
  // here is the point: `negativeConstraints.user`, `assetId`, `position`, and
  // `durationSeconds` have no route to the string below.
  return renderParts({
    roomType: compiled.sceneFacts.roomType,
    cameraMotion: compiled.sceneFacts.cameraMotion,
    preservation: compiled.preservation,
    systemNegatives: compiled.negativeConstraints.system,
    userCustomization: compiled.userCustomization,
  });
}
