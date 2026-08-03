import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { appErrorToResponse } from "@/lib/http";
import { getStoryboardService, toVideoProjectDto } from "@/lib/storyboard";
import {
  optionalString,
  readJsonBody,
  requiredPositiveInteger,
  requiredString,
} from "@/lib/request";

export const dynamic = "force-dynamic";

/**
 * Create a video project for a property.
 *
 * Thin adapter. Whether the property exists in this tenant, whether the caller
 * may write to it, and what a valid project looks like are all decided by
 * StoryboardService. The handler checks the *shape* of the body and nothing
 * else — in particular it applies no provider capability rule to duration,
 * aspect ratio, or resolution, which is Phase 4's job.
 *
 * Lifecycle state is not accepted: `CreateProjectInput` cannot express status,
 * a composition fingerprint, or scenes, so a client cannot present a project as
 * already composed.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ propertyId: string }> },
): Promise<NextResponse> {
  const current = await getCurrentUser();
  if (!current) return appErrorToResponse(new AppError("UNAUTHENTICATED", "Sign in required"));
  const { propertyId } = await context.params;

  try {
    const { organizationId, body } = await readJsonBody(request);
    const project = await getStoryboardService().createProject(
      current.user.id,
      organizationId,
      propertyId,
      {
        name: requiredString(body, "name"),
        durationSeconds: requiredPositiveInteger(body, "durationSeconds"),
        aspectRatio: requiredString(body, "aspectRatio"),
        resolution: requiredString(body, "resolution"),
        prompt: optionalString(body, "prompt"),
        negativePrompt: optionalString(body, "negativePrompt"),
        cameraMotion: optionalString(body, "cameraMotion"),
      },
    );
    return NextResponse.json(toVideoProjectDto(project), { status: 201 });
  } catch (error) {
    return appErrorToResponse(error);
  }
}
