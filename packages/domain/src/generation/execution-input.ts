import { AppError } from "@app/shared";
import type { SceneGeneration } from "./types";

/**
 * Reading the frozen execution artifact off an admitted generation.
 *
 * Kept apart from `request-identity` on purpose. That module answers "are these
 * two the same paid request?" and its 8-fact tuple is a frozen contract this
 * milestone does not touch. This module answers a different question — "what
 * exactly will this attempt send?" — and the answer is a stored artifact, not a
 * derived digest.
 */

/**
 * The exact provider prompt an admitted generation will submit.
 *
 * **Never re-renders.** Re-rendering is the entire failure this field exists to
 * prevent: the rendered bytes depend on the renderer's code as well as the
 * hashed structure, so a row admitted before a renderer change would silently
 * acquire different text while its `requestHash` still validated. A null column
 * therefore means "this attempt predates the freeze contract and cannot be
 * executed", not "compute it now".
 *
 * That mirrors `generationRequestFactsFrom`, which fails closed for rows
 * predating the Phase 4B-1c snapshot rather than falling back to current state.
 * Both refusals exist because a plausible reconstruction of a paid request is
 * worse than no reconstruction.
 *
 * The message names no id, hash, prompt, tenant, or provider detail — the value
 * it is refusing to return is customer-authored text.
 *
 * @throws AppError INTERNAL_ERROR when the attempt has no frozen prompt.
 */
export function frozenExecutionPromptFrom(generation: SceneGeneration): string {
  const { requestRenderedPrompt } = generation;
  if (requestRenderedPrompt === null || requestRenderedPrompt.length === 0) {
    throw new AppError(
      "INTERNAL_ERROR",
      "This generation predates the execution prompt freeze and cannot be submitted",
    );
  }
  return requestRenderedPrompt;
}
