"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { envelopeMessage, mapAnalysisError } from "@/lib/analysis-errors";
// A type only, erased from the browser bundle: the view's domain code stays on the server.
import type { AnalyzeTarget } from "@/lib/review-view";

interface Props {
  readonly organizationId: string;
  readonly propertyId: string;
  /** Empty for a viewer who cannot analyze, or when every photo has an analysis. */
  readonly targets: readonly AnalyzeTarget[];
}

/**
 * Starts the analysis of every photo the review page lists as not analyzed
 * yet (GS-13b, ADR-0122).
 *
 * One press asks the existing analysis route for each photo in turn, as the
 * member, so who may analyze, which photos may be, the audit and a second
 * press finding a photo already analyzed all stay with `AnalysisService`
 * (ADR-0009). Nothing is analyzed until the member presses. A refusal that
 * holds for every photo (signed out, or a role that cannot analyze) stops the
 * run and is shown once; any other is shown against its photo. The page is
 * then read again from the database, so analyzed photos move to "Awaiting
 * decision".
 *
 * The page mounts it for every viewer, in the same place, and it shows nothing
 * while there is nothing to analyze and nothing to say: so a refusal stays on
 * screen after the page is read again, even when no photo is left to offer.
 */
export function AnalyzePhotosButton({ organizationId, propertyId, targets }: Props) {
  const router = useRouter();
  const [progress, setProgress] = useState<{ readonly done: number; readonly total: number } | null>(null);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [refreshing, startRefresh] = useTransition();

  async function analyze(): Promise<void> {
    // The photos as they were when pressed: the page may be read again meanwhile.
    const run = [...targets];
    setErrors([]);
    const failures: string[] = [];
    for (const [index, target] of run.entries()) {
      setProgress({ done: index + 1, total: run.length });
      try {
        const response = await fetch(
          `/api/properties/${propertyId}/assets/${target.assetId}/analysis`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ organizationId }),
          },
        );
        if (response.ok) continue;
        const message = mapAnalysisError(response.status, await envelopeMessage(response));
        if (response.status === 401 || response.status === 403) {
          failures.push(message);
          break;
        }
        failures.push(`${target.filename}: ${message}`);
      } catch {
        failures.push(`${target.filename}: ${mapAnalysisError(null, null)}`);
      }
    }
    setErrors(failures);
    setProgress(null);
    // Kept unpressable until the page has been read again, so the count is current.
    startRefresh(() => router.refresh());
  }

  const count = targets.length;
  if (count === 0 && progress === null && errors.length === 0) return null;
  return (
    <div>
      {count === 0 ? null : (
        <button type="button" disabled={progress !== null || refreshing} onClick={() => void analyze()}>
          {`Analyze ${count} ${count === 1 ? "photo" : "photos"} not analyzed yet`}
        </button>
      )}
      {progress === null ? null : (
        <span className="muted" role="status">{` Analyzing ${progress.done} of ${progress.total}…`}</span>
      )}
      {errors.map((error, index) => (
        <p key={index} className="status-bad" role="alert">
          {error}
        </p>
      ))}
    </div>
  );
}
