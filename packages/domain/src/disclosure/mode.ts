/**
 * The disclosure mode a generation is admitted under (ADR-0073, implementing
 * ADR-0052 Decisions 8 and 10).
 *
 * The mode is chosen once, when a generation is admitted, and frozen on the job
 * and on every deliverable version planned from it. Nothing re-reads it from a
 * setting or a permission later: an admitted job is delivered under the
 * contract it was admitted with (ADR-0052 Decision 10).
 *
 * ADR-0052 names the modes A, B and C and chooses no stored identifiers. These
 * are the stored ones:
 *
 * | ADR-0052 | Stored | What the customer's video shows |
 * | --- | --- | --- |
 * | Mode A, the default | `THROUGHOUT` | the disclosure for the whole video |
 * | Mode B | not yet stored | the disclosure for the first and last 2 seconds |
 * | Mode C | not yet stored | no disclosure (ADR-0052 spells its evidence `NONE`) |
 *
 * Only Mode A is built. Mode B and Mode C each arrive with their own rules (Mode
 * C with its three gates and its consent evidence) and add their value then, to
 * this list and to the database enum together. Until they do, nothing can store
 * or admit them.
 */

import { AppError } from "@app/shared";

/** Every disclosure mode admission accepts, in ADR-0052's order. Mode A only, until B and C are built. */
export const DISCLOSURE_MODES = ["THROUGHOUT"] as const;

/** A disclosure mode a generation can be admitted under: one of `DISCLOSURE_MODES`. */
export type DisclosureMode = (typeof DISCLOSURE_MODES)[number];

/** ADR-0052 Decision 8: Mode A is the default. */
export const DEFAULT_DISCLOSURE_MODE: DisclosureMode = "THROUGHOUT";

export function isDisclosureMode(value: unknown): value is DisclosureMode {
  return typeof value === "string" && (DISCLOSURE_MODES as readonly string[]).includes(value);
}

/**
 * A mode read back from a stored row, as one this build can render (ADR-0077).
 *
 * The database enum and {@link DISCLOSURE_MODES} grow together, so a stored
 * value outside the list is a build running behind its database: a deployment
 * fault, refused as an unrunnable composition profile is, and never rendered as
 * another mode.
 *
 * @throws AppError CONFIGURATION_ERROR when this build does not know the mode.
 */
export function assertRenderableDisclosureMode(value: unknown): DisclosureMode {
  if (!isDisclosureMode(value)) {
    throw new AppError(
      "CONFIGURATION_ERROR",
      "This build cannot render the disclosure mode frozen on that record",
    );
  }
  return value;
}
