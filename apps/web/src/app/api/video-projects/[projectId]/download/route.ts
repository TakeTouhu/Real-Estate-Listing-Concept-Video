import { NextResponse } from "next/server";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { isId, readPropertyId, startPages } from "@/lib/generation-start-form";
import { appErrorToResponse } from "@/lib/http";
import { pathWithQuery, seeOther, seeOtherToSignedLink } from "@/lib/redirect";
import { isSameOriginPost } from "@/lib/same-origin";
import { countDownload, getVideoDownloadLogger, getVideoDownloadService, requestDownload } from "@/lib/video-download";

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
 * asked for, not a page prefetching it. Each is counted per account with the
 * photo download links (ADR-0173); a refused one comes back as `limited` with
 * its wait, and a limiter that cannot answer, as `failed`.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
): Promise<NextResponse> {
  if (!isSameOriginPost(request)) {
    return appErrorToResponse(new AppError("FORBIDDEN", "A video must be downloaded from this site"));
  }
  const current = await getCurrentUser();
  if (!current) return seeOther("/login");
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

  // Counted once the session and the ids are checked, before a link is signed or audited, and never given back
  // (ADR-0173 Decisions 3, 4 and 9).
  const log = getVideoDownloadLogger();
  const landing =
    (await countDownload(current.user.id, log)) ??
    (await requestDownload(getVideoDownloadService(), log, current.user.id, organizationId, projectId));
  if (landing.to === "LINK") {
    // A path on this site is sent as it is, for the browser to resolve against
    // the address it posted to: the token never rides on an address the server
    // rebuilt from its own view of the request. The link is good for minutes,
    // so nothing keeps the answer that carries it.
    const response = seeOtherToSignedLink(landing.url);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
  const page = startPages(propertyId, projectId).project;
  return seeOther(pathWithQuery(page, { download: landing.notice, retry: landing.retry?.toString() }));
}
