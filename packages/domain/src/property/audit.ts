/** Audit actions emitted by property and media-asset writes. */
export const PropertyAuditAction = {
  PropertyCreated: "property.created",
  PropertyUpdated: "property.updated",
  PropertyDeleted: "property.deleted",
  /** A Property's responsible user or group changed (ADR-0052 Decision 10). */
  PropertyAssignmentChanged: "property.assignment_changed",
  /** A member's assignment the creation-time rules or the reassignment authority refused. */
  PropertyAssignmentRefused: "property.assignment_refused",
  AssetUploadRequested: "asset.upload_requested",
  AssetUploadCompleted: "asset.upload_completed",
  AssetQuarantined: "asset.quarantined",
  AssetRejected: "asset.rejected",
  AssetFailed: "asset.failed",
  AssetReady: "asset.ready",
  AssetDownloaded: "asset.download_url_issued",
  AssetDeletionRequested: "asset.deletion_requested",
} as const;

export type PropertyAuditActionValue =
  (typeof PropertyAuditAction)[keyof typeof PropertyAuditAction];
