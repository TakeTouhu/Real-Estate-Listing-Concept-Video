/** Audit actions emitted by analysis writes. */
export const AnalysisAuditAction = {
  AnalysisRequested: "analysis.requested",
  AnalysisSucceeded: "analysis.succeeded",
  AnalysisFailed: "analysis.failed",
  AnalysisRefreshed: "analysis.refreshed",
  AnalysisApproved: "analysis.approved",
  AnalysisRejected: "analysis.rejected",
  /** A human corrected the analyzer's room classification or the scene order. */
  AnalysisCorrected: "analysis.corrected",
} as const;

export type AnalysisAuditActionValue =
  (typeof AnalysisAuditAction)[keyof typeof AnalysisAuditAction];
