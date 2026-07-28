/** Audit actions emitted by analysis writes. */
export const AnalysisAuditAction = {
  AnalysisRequested: "analysis.requested",
  AnalysisSucceeded: "analysis.succeeded",
  AnalysisFailed: "analysis.failed",
  AnalysisRefreshed: "analysis.refreshed",
} as const;

export type AnalysisAuditActionValue =
  (typeof AnalysisAuditAction)[keyof typeof AnalysisAuditAction];
