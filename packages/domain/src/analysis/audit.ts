/** Audit actions emitted by analysis writes. */
export const AnalysisAuditAction = {
  AnalysisRequested: "analysis.requested",
  AnalysisSucceeded: "analysis.succeeded",
  AnalysisFailed: "analysis.failed",
  AnalysisRefreshed: "analysis.refreshed",
  AnalysisApproved: "analysis.approved",
  AnalysisRejected: "analysis.rejected",
} as const;

export type AnalysisAuditActionValue =
  (typeof AnalysisAuditAction)[keyof typeof AnalysisAuditAction];
