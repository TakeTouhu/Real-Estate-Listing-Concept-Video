import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { isId, readPropertyId, startPages } from "@/lib/generation-start-form";
import { appErrorToResponse } from "@/lib/http";
import { isSameOriginPost } from "@/lib/same-origin";
import { getVideoDownloadService, requestDownload } from "@/lib/video-download";

export const dynamic = "force-dynamic";

/**
 * Download a project's delivered video, from its project page (GS-12c-3,
 * ADR-0120). Fields: `organizationId` and `propertyId`, as the page was read
 * for. The download service decides whether this member may download it and
 * records each link it gives (ADR-0119).
 *
 * A link sends the browser straight to the file, which it saves under the
 * project's name and stays on the page (ADR-0118). Anything else sends the
 * member back to the project page with a code naming one of its fixed notices.
 * A post, never a link to follow, so each recorded download is one the member
 * asked for, not a page prefetching it.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<NextResponse> {
  if (!isSameOriginPost(request)) {
    return appErrorToResponse(new AppError("FORBIDDEN", "A video must be downloaded from this site"));
  }
  const current = await getCurrentUser();
  if (!current) return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
  const { projectId } = await context.params;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return appErrorToResponse(new AppError("VALIDATION_FAILED", "A download is asked for with a form"));
  }
  // The Property says where to send the member, so it cannot be just any text.
  const organizationId = form.get("organizationId");
  const propertyId = readPropertyId(form);
  if (!isId(organizationId) || propertyId === null || !isId(projectId)) {
    return appErrorToResponse(
      new AppError("VALIDATION_FAILED", "A download names an organization, a Property and a project by their ids"),
    );
  }

  const landing = await requestDownload(getVideoDownloadService(), current.user.id, organizationId, projectId);
  if (landing.to === "LINK") {
    const response = NextResponse.redirect(new URL(landing.url, request.url), { status: 303 });
    // The link is good for minutes: nothing keeps the answer that carries it.
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
  const page = new URL(startPages(propertyId, projectId).project, request.url);
  page.searchParams.set("download", landing.notice);
  return NextResponse.redirect(page, { status: 303 });
}
