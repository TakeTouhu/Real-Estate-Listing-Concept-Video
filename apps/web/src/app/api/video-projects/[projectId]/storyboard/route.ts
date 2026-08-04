import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { appErrorToResponse } from "@/lib/http";
import { getStoryboardService, toStoryboardReadDto } from "@/lib/storyboard";
import { readJsonBody, requireOrganizationIdFromQuery, requiredPositiveInteger } from "@/lib/request";

export const dynamic = "force-dynamic";

/**
 * Read a project's storyboard: the project, its scenes, and whether the
 * storyboard still matches the approved photos it was composed from.
 *
 * Any organization member may read. A project that has never been composed
 * returns no scenes and `fresh: false` — existing semantics, with no status
 * invented for the case.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<NextResponse> {
  const current = await getCurrentUser();
  if (!current) return appErrorToResponse(new AppError("UNAUTHENTICATED", "Sign in required"));
  const { projectId } = await context.params;

  try {
    const organizationId = requireOrganizationIdFromQuery(request);
    const view = await getStoryboardService().getStoryboard(
      current.user.id,
      organizationId,
      projectId,
    );
    return NextResponse.json(toStoryboardReadDto(view));
  } catch (error) {
    return appErrorToResponse(error);
  }
}

/**
 * Compose the storyboard from the property's approved analyses.
 *
 * Thin adapter. The route checks only that the bounds are positive whole
 * numbers; whether the requested total is achievable within them, which photos
 * are eligible, how scenes are ordered, and whether the prompt passes moderation
 * are all decided by StoryboardService and the Phase 3C primitives behind it.
 *
 * The bounds are temporary orchestration inputs, **not** provider capabilities:
 * Phase 4 must validate against the configured provider before any provider
 * call (`docs/decisions/TODO.md`).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<NextResponse> {
  const current = await getCurrentUser();
  if (!current) return appErrorToResponse(new AppError("UNAUTHENTICATED", "Sign in required"));
  const { projectId } = await context.params;

  try {
    const { organizationId, body } = await readJsonBody(request);
    const composed = await getStoryboardService().compose(
      current.user.id,
      organizationId,
      projectId,
      {
        minSeconds: requiredPositiveInteger(body, "minSceneSeconds"),
        maxSeconds: requiredPositiveInteger(body, "maxSceneSeconds"),
      },
    );
    return NextResponse.json(toStoryboardReadDto({ ...composed, fresh: true }));
  } catch (error) {
    return appErrorToResponse(error);
  }
}
