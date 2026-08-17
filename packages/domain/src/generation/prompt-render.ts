import { AppError } from "@app/shared";
import type { CompiledPrompt, SceneFacts } from "../storyboard/prompt";

/**
 * The single place a structured `CompiledPrompt` becomes the one string a
 * provider's documented `prompt` parameter can carry.
 *
 * It lives in the domain rather than beside an adapter because *what the model
 * is told* is product policy, not a vendor detail — the preservation rules are
 * quoted from `docs/AIVideoPipeline.md`, and a second provider must inherit
 * them rather than invent its own phrasing. The adapter's job stays narrow:
 * put this string in the field the vendor documents.
 *
 * **One renderer, one direction.** It reads a `CompiledPrompt` and returns a
 * string. It never writes back, never re-compiles, and never normalizes the
 * stored structure — `CompiledPrompt` remains the hashed, persisted,
 * reviewable form (ADR-0018), and this is a projection of it.
 *
 * ADR-0020 records the format, what it costs, and what would reverse it.
 */

/**
 * Section headings, fixed and in this order.
 *
 * The order is the design, not formatting. Every system-authored section
 * appears **before** every customer-authored one, so nothing a customer typed
 * is positioned as a preamble that the rules then appear to qualify. The two
 * customer sections carry their attribution in the heading itself, so a human
 * reviewing a generation — which the product requires before publication — can
 * see at a glance which words came from the customer.
 *
 * The "the rules above take precedence" clause is a **mitigation, not a
 * control**. Once flattened into one field the model is free to ignore it. The
 * control is that customer text is moderated before compilation and can only
 * ever land inside these two delimited regions (ADR-0014, ADR-0020 §4).
 */
const PRESERVATION_HEADING = "Preservation rules:";
const AVOID_HEADING = "Avoid:";
const CAMERA_MOTION_HEADING =
  "Camera motion requested by the customer (the rules above take precedence):";
const CUSTOMIZATION_HEADING =
  "Styling requested by the customer (the rules above take precedence):";

/**
 * Everything the rendered prompt is allowed to contain.
 *
 * This type is the structural half of two guarantees, and it is why the
 * renderer is split in two rather than written as one function:
 *
 * - **The customer's negative prompt cannot reach the positive prompt.** There
 *   is no field here that could carry it. `CompiledPrompt` is not assignable
 *   to this type either, so it cannot be forwarded wholesale by accident —
 *   reintroducing the user negative would mean adding a field here *and*
 *   populating it in {@link renderPrompt}, in a diff that says so plainly.
 *   Folding a negative constraint into a positive instruction inverts its
 *   meaning, which is the one transformation no renderer may perform.
 * - **Internal identifiers cannot leak into a provider payload.**
 *   `SceneFacts.assetId` and `SceneFacts.position` are storyboard bookkeeping;
 *   omitting the fields is stronger than remembering not to print them.
 *
 * `durationSeconds` is absent for a different reason: the provider carries it
 * in its own documented `duration` parameter, so restating it as prose would
 * give the model two sources for one fact and a way to disagree with the
 * request that was actually hashed and billed.
 *
 * Neither guarantee is enforceable against a caller who builds this object by
 * hand and puts the wrong text in the wrong field. What the split buys is that
 * the mistake has to be written down somewhere a reviewer reads.
 */
interface PositivePromptParts {
  readonly roomType: SceneFacts["roomType"];
  readonly cameraMotion: string | null;
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
    labelled(CAMERA_MOTION_HEADING, parts.cameraMotion),
    labelled(CUSTOMIZATION_HEADING, parts.userCustomization),
  ]
    .filter((section): section is string => section !== null)
    .join("\n\n");
}

/**
 * Render one compiled prompt into the provider's `prompt` string.
 *
 * Pure and total: same structure in, same string out, nothing mutated, no
 * clock, environment, or network read. That matters because the string is
 * derived from a value that was hashed at admission — a renderer that varied
 * by anything else would send text the customer's approved request never
 * described.
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
 * @throws AppError INTERNAL_ERROR if the whole structure renders to nothing.
 *   The preservation rules are system constants copied into every compilation,
 *   so an empty render means the structure was built wrong — and an empty
 *   `prompt` sent to a paid endpoint is a charge for nothing.
 */
export function renderPrompt(compiled: CompiledPrompt): string {
  // Every value the prompt may contain is named on the way in. What is absent
  // here is the point: `negativeConstraints.user`, `assetId`, `position`, and
  // `durationSeconds` have no route to the string below.
  const rendered = renderParts({
    roomType: compiled.sceneFacts.roomType,
    cameraMotion: compiled.sceneFacts.cameraMotion,
    preservation: compiled.preservation,
    systemNegatives: compiled.negativeConstraints.system,
    userCustomization: compiled.userCustomization,
  });

  if (rendered.length === 0) {
    throw new AppError("INTERNAL_ERROR", "The compiled prompt rendered to an empty provider prompt");
  }
  return rendered;
}
