import { managedDeliverableOutputKey } from "../deliverable-composition-execution/durable";
import { recordAudit } from "../identity/audit";
import {
  ATTACHMENT_FILENAME_MAX_BYTES,
  replaceUnsafeFilenameCharacters,
  utf8ByteLength,
} from "../property/attachment-filename";
import type { SignedUrl } from "../property/ports";
import {
  completedVersionOf,
  VIDEO_AUDIT_RESOURCE_TYPE,
  VideoAuditAction,
  type VideoPreviewServiceDeps,
} from "./preview";
import { readProjectVideo } from "./progress";

/**
 * A link to download a project's delivered video (GS-12c, ADR-0119): the
 * signed download route serves it as an attachment, saved under the project's
 * name, rather than shown in the browser (ADR-0118).
 */

/** How long a link to download a video lives: as long as one to watch it (ADR-0119 Decision 2). */
export const VIDEO_DOWNLOAD_LINK_TTL_SECONDS = 300;

/** Every delivered video is MP4 (ADR-0115). */
const VIDEO_EXTENSION = ".mp4";

/** The name of a video whose project's name leaves nothing to use. */
const FALLBACK_STEM = "video";

/** A dot, or white space. */
const LOOSE = /^[\s.]$/u;

/** Where a name may be cut: between the characters a reader sees, never inside one. */
const CHARACTERS = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The name without dots or white space at either end, in one pass however long it is. */
function withoutLooseEnds(name: string): string {
  let start = 0;
  let end = name.length;
  while (start < end && LOOSE.test(name.charAt(start))) start += 1;
  while (end > start && LOOSE.test(name.charAt(end - 1))) end -= 1;
  return name.slice(start, end);
}

/** A name with each run of white space as one space, each unsafe character as `_`, and nothing loose at its ends. */
function tidy(name: string): string {
  return withoutLooseEnds(replaceUnsafeFilenameCharacters(name.normalize("NFC").replace(/\s+/gu, " "), "_"));
}

/**
 * The name a project's video is saved under (ADR-0119 Decision 1): the
 * project's name as its members wrote it, made safe for a file and cut to fit,
 * with `.mp4`. Each run of white space (spaces, tabs, line breaks and the
 * like) becomes one space, each other character no file name holds `_`, and
 * white space and dots at either end go. A name that leaves nothing is
 * `video.mp4`.
 */
export function videoDownloadFilename(projectName: string): string {
  const room = ATTACHMENT_FILENAME_MAX_BYTES - utf8ByteLength(VIDEO_EXTENSION);
  let stem = "";
  // A character as a reader sees it at a time, so the cut never splits one.
  for (const { segment } of CHARACTERS.segment(tidy(projectName))) {
    if (utf8ByteLength(stem + segment) > room) break;
    stem += segment;
  }
  return `${tidy(stem) || FALLBACK_STEM}${VIDEO_EXTENSION}`;
}

/** What the download reads and signs with: the preview's. */
export type VideoDownloadServiceDeps = VideoPreviewServiceDeps;

export class VideoDownloadService {
  constructor(private readonly deps: VideoDownloadServiceDeps) {}

  /**
   * A short-lived link that downloads the project's delivered video, saved
   * under the project's name, or `null` when it has none: the video a link to
   * watch it names (ADR-0116 Decision 1), for a member holding
   * `video.download` with the project's Property in reach. Each link is
   * audited when it is given.
   *
   * @throws AppError FORBIDDEN when the member lacks `video.download`.
   * @throws AppError NOT_FOUND when the project is not this organization's or
   *   its Property is out of the member's reach, before anything about its
   *   video is read.
   * @throws AppError INTERNAL_ERROR for a video whose Units contradict
   *   ADR-0052, as its progress is refused (ADR-0113 Decision 4).
   */
  async link(actorUserId: string, organizationId: string, videoProjectId: string): Promise<SignedUrl | null> {
    const { project, video } = await readProjectVideo(
      this.deps,
      actorUserId,
      organizationId,
      videoProjectId,
      "video.download",
    );
    const deliverableVersionId = completedVersionOf(video);
    if (video === null || deliverableVersionId === null) return null;
    const key = managedDeliverableOutputKey({ organizationId, deliverableVersionId });
    const link = await this.deps.storage.createSignedDownloadUrl(key, VIDEO_DOWNLOAD_LINK_TTL_SECONDS, {
      attachmentFilename: videoDownloadFilename(project.name),
    });
    await recordAudit(this.deps.identity, {
      organizationId,
      actorUserId,
      action: VideoAuditAction.DownloadLinkIssued,
      resourceType: VIDEO_AUDIT_RESOURCE_TYPE,
      resourceId: deliverableVersionId,
      metadata: { jobId: video.jobId },
    });
    return link;
  }
}
