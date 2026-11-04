import { managedDeliverableOutputKey } from "../deliverable-composition-execution/durable";
import { recordAudit } from "../identity/audit";
import type { ObjectStorage, SignedUrl } from "../property/ports";
import { readNewestVideo, videoProgressOf, type VideoProgressServiceDeps } from "./progress";

/**
 * A link that plays a project's delivered video in its organization's
 * workspace (GS-12b, ADR-0116). The video plays in the member's browser
 * straight from the signed download route, a range at a time (ADR-0115).
 */

/**
 * How long a link to watch a video lives: as long as a photo's (ADR-0116
 * Decision 2). The page renews one that has run out.
 */
export const VIDEO_PREVIEW_LINK_TTL_SECONDS = 300;

/** Audit vocabulary for a delivered video. */
export const VideoAuditAction = {
  /** A member was given a link to watch a delivered video (ADR-0116 Decision 3). */
  PreviewLinkIssued: "video.preview_link_issued",
} as const;

/** The `resourceType` of a delivered video's audit entries: the version watched. Table-name form. */
export const VIDEO_AUDIT_RESOURCE_TYPE = "generation_deliverable_version";

export interface VideoPreviewServiceDeps extends VideoProgressServiceDeps {
  /** Signs the link; nothing else of the store is reached. */
  readonly storage: Pick<ObjectStorage, "createSignedDownloadUrl">;
}

export class VideoPreviewService {
  constructor(private readonly deps: VideoPreviewServiceDeps) {}

  /**
   * A short-lived link to the project's delivered video, or `null` when it has
   * none to watch: no video, one not delivered yet, or one that ended without
   * one. The video is the one its progress shows as completed: the job's
   * current version, which only the commit that delivers it sets. Each link is
   * audited when it is given.
   *
   * Its readers are the progress's ({@link readNewestVideo}, whose refusals it
   * throws). A video whose Units contradict ADR-0052 is refused as its
   * progress is (ADR-0113 Decision 4): no link is given to it.
   */
  async link(actorUserId: string, organizationId: string, videoProjectId: string): Promise<SignedUrl | null> {
    const record = await readNewestVideo(this.deps, actorUserId, organizationId, videoProjectId);
    if (record === null || record.deliveredVersionId === null) return null;
    if (videoProgressOf(record).phase !== "COMPLETED") return null;
    const deliverableVersionId = record.deliveredVersionId;
    const key = managedDeliverableOutputKey({ organizationId, deliverableVersionId });
    const link = await this.deps.storage.createSignedDownloadUrl(key, VIDEO_PREVIEW_LINK_TTL_SECONDS);
    await recordAudit(this.deps.identity, {
      organizationId,
      actorUserId,
      action: VideoAuditAction.PreviewLinkIssued,
      resourceType: VIDEO_AUDIT_RESOURCE_TYPE,
      resourceId: deliverableVersionId,
      metadata: { jobId: record.jobId },
    });
    return link;
  }
}
