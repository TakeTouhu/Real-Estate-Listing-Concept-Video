"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { envelopeMessage, mapAnalysisError } from "@/lib/analysis-errors";
// A type only, erased from the browser bundle: the view's domain code stays on the server.
import type { AnalyzeTarget } from "@/lib/review-view";

interface Props {
  readonly organizationId: string;
  readonly propertyId: string;
  /** Never empty: the page mounts the button only when there is a photo to analyze. */
  readonly targets: readonly AnalyzeTarget[];
}

/**
 * Starts the analysis of every photo the review page lists as not analyzed
 * yet (GS-13b, ADR-0122).
 *
 * One press asks the existing analysis route for each photo in turn, as the
 * member, so who may analyze, which photos may be, the audit and a second
 * press finding a photo already analyzed all stay with `AnalysisService`
 * (ADR-0009).
 * Nothing is analyzed until the member presses. A refusal that holds for every
 * photo (signed out, or a role that cannot analyze) stops the run and is shown
 * once; any other is shown against its photo. The page is then read again from
 * the database, so analyzed photos move to "Awaiting decision".
 */
export function AnalyzePhotosButton({ organizationId, propertyId, targets }: Props) {
  const router = useRouter();
  const [current, setCurrent] = useState<number | null>(null);
  const [errors, setErrors] = useState<readonly string[]>([]);

  async function analyze(): Promise<void> {
    setErrors([]);
    const failures: string[] = [];
    for (const [index, target] of targets.entries()) {
      setCurrent(index + 1);
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
    setCurrent(null);
    router.refresh();
  }

  const count = targets.length;
  return (
    <div className="analyze-panel">
      <button type="button" disabled={current !== null} onClick={() => void analyze()}>
        {`Analyze ${count} ${count === 1 ? "photo" : "photos"} not analyzed yet`}
      </button>
      {current === null ? null : (
        <span className="muted">{` Analyzing ${current} of ${count}…`}</span>
      )}
      {errors.map((error) => (
        <p key={error} className="status-bad">
          {error}
        </p>
      ))}
    </div>
  );
}
