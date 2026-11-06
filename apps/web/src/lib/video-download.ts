import { VideoDownloadService } from "@app/domain";
import {
  createPrismaPropertyRepositories,
  createPrismaStoryboardRepositories,
  createVideoProgressRepository,
  getPrismaClient,
} from "@app/database";
import { createLogger, type Logger } from "@app/observability";
import { AppError } from "@app/shared";
import { getIdentityServices } from "./identity";
import { getPropertyServices } from "./property";
import type { VideoDownloadForm } from "./video-progress-view";

/**
 * The download of a project's delivered video from its project page (GS-12c-3,
 * ADR-0120). Server-only.
 *
 * Built wherever the page is, as the preview is (ADR-0117): a link is given
 * only for a delivered video, and where nothing can start a video, no project
 * has one.
 */

let service: VideoDownloadService | undefined;
let logger: Logger | undefined;

export function getVideoDownloadService(): VideoDownloadService {
  if (service) return service;
  const prisma = getPrismaClient();
  service = new VideoDownloadService({
    identity: getIdentityServices().deps,
    properties: createPrismaPropertyRepositories(prisma).properties,
    projects: createPrismaStoryboardRepositories(prisma).projects,
    progress: createVideoProgressRepository(prisma),
    storage: getPropertyServices().storage,
  });
  return service;
}

/** Where a download that failed is reported, for support to find. */
export function getVideoDownloadLogger(): Pick<Logger, "error"> {
  logger ??= createLogger({ base: { component: "video-download" } });
  return logger;
}

/**
 * What the project page says when a download gave no link, by the code the
 * route sends it back with (`?download=`). The page shows only these: never
 * text the URL carries.
 */
export const DOWNLOAD_NOTICES = {
  none: "There is no delivered video to download.",
  forbidden: "You may not download this video.",
  failed:
    "The video could not be downloaded. Try again; if it keeps failing, contact support with the video's " +
    "support reference.",
} as const;

export type DownloadNotice = keyof typeof DOWNLOAD_NOTICES;

const NOTICES: ReadonlyMap<string, string> = new Map(Object.entries(DOWNLOAD_NOTICES));

/** The notice a `?download=` code names, or `null` for anything else. */
export function downloadNotice(param: string | readonly string[] | undefined): string | null {
  return typeof param === "string" ? (NOTICES.get(param) ?? null) : null;
}

/**
 * The download button, for a video its progress shows delivered and a member
 * holding `video.download` (ADR-0120 Decision 1); `null` otherwise.
 */
export function downloadOnProjectPage(
  completed: boolean,
  permissions: readonly string[],
  organizationId: string,
  propertyId: string,
  videoProjectId: string,
): VideoDownloadForm | null {
  if (!completed || !permissions.includes("video.download")) return null;
  return { action: `/api/video-projects/${encodeURIComponent(videoProjectId)}/download`, organizationId, propertyId };
}

/** Where a download sends the member: to its link, or back to the project page with a notice. */
export type DownloadLanding =
  | { readonly to: "LINK"; readonly url: string }
  | { readonly to: "PAGE"; readonly notice: DownloadNotice };

/**
 * Ask for a link to download the project's video (ADR-0119), and say where it
 * sends the member (ADR-0120 Decision 2). A member who may not download it and
 * a project out of reach are answered alike; any other refusal is a failure to
 * try again, reported by its code and never with a link. What is not an
 * `AppError` is the route's to fail with.
 */
export async function requestDownload(
  downloads: Pick<VideoDownloadService, "link">,
  log: Pick<Logger, "error">,
  actorUserId: string,
  organizationId: string,
  videoProjectId: string,
): Promise<DownloadLanding> {
  let link: Awaited<ReturnType<VideoDownloadService["link"]>>;
  try {
    link = await downloads.link(actorUserId, organizationId, videoProjectId);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.code === "FORBIDDEN" || error.code === "NOT_FOUND") return { to: "PAGE", notice: "forbidden" };
    // The video's id, which the page quotes as its support reference, when the refusal names it.
    const jobId = error.details?.jobId;
    log.error("A video's download link could not be given", {
      code: error.code,
      organizationId,
      videoProjectId,
      ...(typeof jobId === "string" ? { jobId } : {}),
    });
    return { to: "PAGE", notice: "failed" };
  }
  return link === null ? { to: "PAGE", notice: "none" } : { to: "LINK", url: link.url };
}
