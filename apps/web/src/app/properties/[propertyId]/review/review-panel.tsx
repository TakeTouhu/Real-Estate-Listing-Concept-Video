"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { mapDecisionError } from "@/lib/decision-errors";

/** One reviewable photo the panel can act on. */
export interface DecisionMember {
  readonly assetId: string;
  readonly filename: string;
  readonly canApprove: boolean;
  readonly canReject: boolean;
}

interface Props {
  readonly organizationId: string;
  readonly propertyId: string;
  /** One member for an ordinary photo; two or more for a duplicate cluster. */
  readonly members: readonly DecisionMember[];
  /**
   * Presentation-only: why decisions are temporarily unavailable, or null when
   * they are available. Set while a sibling correction has unsaved changes, so
   * an approval cannot freeze the revision around correction state the reviewer
   * can still see on screen but has not saved.
   *
   * This component does not know what corrections are or how they are stored —
   * only that something asked it to hold off. The request payload is unaffected.
   */
  readonly disabledReason?: string | null;
}

/**
 * Approve / reject controls.
 *
 * Mounted only where a decision is actually available: never for a decided
 * revision, never for a viewer without `video:review`, and with no approve
 * control for a photo carrying a blocking finding. Those are decisions the
 * server already made — this component renders them, it does not re-derive them.
 *
 * For a duplicate cluster the reviewer names the primary with a radio, and
 * approval acts on that member: the domain requires `primaryAssetId` to be the
 * asset being approved, so one selection drives both. Whether another member
 * already holds the group's approval is still the database's call, and its
 * refusal surfaces here like any other.
 *
 * No request carries `analysisRevision`. The API accepts no revision token, so
 * sending one would invent an optimistic-concurrency contract that does not
 * exist; a stale view is caught by the domain's "already reviewed" refusal.
 */
export function ReviewDecisionPanel({
  organizationId,
  propertyId,
  members,
  disabledReason = null,
}: Props) {
  const router = useRouter();
  const isCluster = members.length > 1;
  const [primary, setPrimary] = useState<string | null>(isCluster ? null : (members[0]?.assetId ?? null));
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function decide(decision: "approve" | "reject", assetId: string): Promise<void> {
    setPending(assetId);
    setErrors((prev) => ({ ...prev, [assetId]: "" }));
    const reason = (reasons[assetId] ?? "").trim();
    const body =
      decision === "approve"
        ? { organizationId, primaryAssetId: assetId, ...(reason ? { reason } : {}) }
        : { organizationId, reason };
    try {
      const response = await fetch(
        `/api/properties/${propertyId}/assets/${assetId}/analysis/${decision}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (response.ok) {
        // Re-render the server component from the database rather than merging
        // state here: rejection also changes the asset's status, and the row
        // must move between sections.
        router.refresh();
        return;
      }
      const message = mapDecisionError(response.status, await messageOf(response));
      setErrors((prev) => ({ ...prev, [assetId]: message }));
    } catch {
      setErrors((prev) => ({ ...prev, [assetId]: mapDecisionError(null, null) }));
    } finally {
      setPending(null);
    }
  }

  const selected = members.find((m) => m.assetId === primary) ?? null;

  return (
    <div className="decision-panel">
      {disabledReason ? <p className="status-bad">{disabledReason}</p> : null}
      {isCluster ? (
        <fieldset className="primary-choice">
          <legend>Which photo is the primary?</legend>
          {members.map((member) => (
            <label key={member.assetId}>
              <input
                type="radio"
                name={`primary-${members[0]!.assetId}`}
                value={member.assetId}
                checked={primary === member.assetId}
                onChange={() => setPrimary(member.assetId)}
              />{" "}
              {member.filename}
            </label>
          ))}
        </fieldset>
      ) : null}

      {members.map((member) => (
        <div key={member.assetId} className="decision-row">
          {isCluster ? <p className="muted">{member.filename}</p> : null}
          <label className="field">
            <span className="muted">Reason (required to reject)</span>
            <input
              type="text"
              value={reasons[member.assetId] ?? ""}
              aria-label={`Reason for ${member.filename}`}
              onChange={(event) =>
                setReasons((prev) => ({ ...prev, [member.assetId]: event.target.value }))
              }
            />
          </label>
          <div className="decision-buttons">
            {member.canApprove ? (
              <button
                type="button"
                disabled={
                  disabledReason !== null ||
                  pending !== null ||
                  (isCluster && selected?.assetId !== member.assetId)
                }
                onClick={() => void decide("approve", member.assetId)}
              >
                Approve
              </button>
            ) : null}
            {member.canReject ? (
              <button
                type="button"
                disabled={
                  disabledReason !== null ||
                  pending !== null ||
                  (reasons[member.assetId] ?? "").trim().length === 0
                }
                onClick={() => void decide("reject", member.assetId)}
              >
                Reject
              </button>
            ) : null}
            {pending === member.assetId ? <span className="muted">Recording…</span> : null}
          </div>
          {errors[member.assetId] ? (
            <p className="status-bad">{errors[member.assetId]}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** The envelope's message, or null when the body is missing or not JSON. */
async function messageOf(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    const message = (body as { error?: { message?: unknown } }).error?.message;
    return typeof message === "string" && message.length > 0 ? message : null;
  } catch {
    return null;
  }
}
