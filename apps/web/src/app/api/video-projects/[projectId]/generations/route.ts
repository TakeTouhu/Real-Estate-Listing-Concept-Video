import { NextResponse } from "next/server";
import type { StartGenerationOutcome } from "@app/domain";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { getGenerationStartService } from "@/lib/generation-start";
import {
  NOT_USABLE,
  failureMessage,
  isId,
  landingFor,
  readGenerationStartForm,
  readPropertyId,
  startPages,
} from "@/lib/generation-start-form";
import { appErrorToResponse, redirectWithError } from "@/lib/http";
import { isSameOriginPost } from "@/lib/same-origin";

export const dynamic = "force-dynamic";

/**
 * Start the video a project's storyboard describes, from its start page
 * (GS-10c, ADR-0111). Fields: `organizationId`, `propertyId`, `qualityTier`,
 * each `sceneId` in order and `idempotencyKey`, as the page showed them. The
 * start service decides; a start reserves the video's Units and writes its job.
 *
 * Outside development with the test provider there is no start: the route
 * answers as one that does not exist, before anything else is read.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<NextResponse> {
  const starts = getGenerationStartService();
  if (starts === null) return appErrorToResponse(new AppError("NOT_FOUND", "Not found"));
  if (!isSameOriginPost(request)) {
    return appErrorToResponse(new AppError("FORBIDDEN", "A video must be started from this site"));
  }
  const current = await getCurrentUser();
  if (!current) return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
  const { projectId } = await context.params;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return appErrorToResponse(new AppError("VALIDATION_FAILED", "A start is sent as a form"));
  }
  // Both say where to send the customer, so neither can be just any text.
  const propertyId = readPropertyId(form);
  if (propertyId === null || !isId(projectId)) {
    return appErrorToResponse(new AppError("VALIDATION_FAILED", "A start names a Property and a project by their ids"));
  }
  const pages = startPages(propertyId, projectId);
  const input = readGenerationStartForm(projectId, form);
  if (input === null) return redirectWithError(request.url, pages.start, NOT_USABLE);

  let outcome: StartGenerationOutcome;
  try {
    outcome = await starts.start(current.user.id, input);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return redirectWithError(request.url, pages.start, failureMessage(error));
  }
  const landing = landingFor(outcome);
  if (landing.to === "START") return redirectWithError(request.url, pages.start, landing.message);

  // A replay of the same confirmation lands where the start did: it started once.
  const started = new URL(pages.project, request.url);
  started.searchParams.set("started", "1");
  return NextResponse.redirect(started, { status: 303 });
}
