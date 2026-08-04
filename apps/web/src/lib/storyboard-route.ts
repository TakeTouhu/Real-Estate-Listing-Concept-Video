import type { StoryboardView } from "@app/domain";
import { AppError } from "@app/shared";

/**
 * Resolve a storyboard for the nested
 * `/properties/{propertyId}/video-projects/{projectId}` route.
 *
 * `StoryboardService.getStoryboard` is organization-scoped, which is the
 * security boundary and is correct — but a project belonging to a *different
 * property in the same organization* is still a valid service result. Without
 * this check a hand-built URL would render the header, approved-photo count,
 * and assets of one property beside the project and scenes of another. Not a
 * cross-tenant leak, but wrong, and the page must not show it.
 *
 * Returns `null` for the two cases that mean "this route does not resolve" —
 * the project does not exist (for this caller), or it belongs to another
 * property. The caller turns both into its ordinary not-found behaviour, so a
 * mismatch is indistinguishable from a missing project and never reveals that
 * the project exists under some other property.
 *
 * **Everything else propagates.** An authorization refusal, a repository
 * failure, or the duplicate-approved-input invariant must not be flattened into
 * "not found": that would present a broken system as a missing page, the same
 * mistake `isFresh` is written to avoid.
 *
 * Takes the load as a thunk so the rule is testable without standing up the
 * service graph.
 */
export async function resolveStoryboardForProperty(
  load: () => Promise<StoryboardView>,
  propertyId: string,
): Promise<StoryboardView | null> {
  let view: StoryboardView;
  try {
    view = await load();
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") return null;
    throw error;
  }
  return view.project.propertyId === propertyId ? view : null;
}
