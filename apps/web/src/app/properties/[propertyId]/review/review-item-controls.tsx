"use client";

import { useCallback, useState } from "react";
import { CorrectionPanel, type RoomOption } from "./correction-panel";
import { ReviewDecisionPanel, type DecisionMember } from "./review-panel";

/** One photo's correction state, resolved server-side from the analysis DTO. */
export interface CorrectionTarget {
  readonly assetId: string;
  readonly filename: string;
  readonly analyzerRoomType: string;
  readonly roomTypeOverride: string | null;
  readonly orderOverride: number | null;
}

interface Props {
  readonly organizationId: string;
  readonly propertyId: string;
  /** Photos whose corrections this reviewer may edit. May be empty. */
  readonly corrections: readonly CorrectionTarget[];
  /** Photos this reviewer may decide. May be empty. */
  readonly members: readonly DecisionMember[];
  readonly roomOptions: readonly RoomOption[];
}

const BLOCKED_BY_UNSAVED =
  "Save or discard your correction changes before approving or rejecting.";

/**
 * Coordinate the two review operations for one photo — or one duplicate cluster.
 *
 * They remain **separate writes**: correcting and deciding are different HTTP
 * calls, different audit events, and different buttons. Approve never submits a
 * correction, and saving a correction never approves.
 *
 * What this wrapper adds is the interlock between them. A reviewer who edits a
 * correction, forgets to save, and approves would otherwise freeze the revision
 * around the *old* stored correction — losing the change they can still see on
 * screen, and needing a refresh and a new revision to redo it. So while any
 * correction here is dirty, the decision controls are unavailable and say why.
 * A **failed** save keeps the edits dirty, so it does not unlock them either.
 *
 * It holds presentation state and nothing else: no domain rule, no knowledge of
 * how corrections are stored, no context provider, no store. A cluster's photos
 * share one decision panel, so any dirty member blocks that panel — which is
 * correct, since approving the cluster acts on the member being edited.
 */
export function ReviewItemControls({
  organizationId,
  propertyId,
  corrections,
  members,
  roomOptions,
}: Props) {
  const [dirtyAssets, setDirtyAssets] = useState<readonly string[]>([]);

  const onDirtyChange = useCallback((assetId: string, dirty: boolean) => {
    setDirtyAssets((current) => {
      const without = current.filter((id) => id !== assetId);
      return dirty ? [...without, assetId] : without;
    });
  }, []);

  return (
    <div className="review-controls">
      {corrections.map((target) => (
        <CorrectionPanel
          key={target.assetId}
          organizationId={organizationId}
          propertyId={propertyId}
          assetId={target.assetId}
          filename={target.filename}
          analyzerRoomType={target.analyzerRoomType}
          roomTypeOverride={target.roomTypeOverride}
          orderOverride={target.orderOverride}
          roomOptions={roomOptions}
          onDirtyChange={onDirtyChange}
        />
      ))}
      {members.length > 0 ? (
        <ReviewDecisionPanel
          organizationId={organizationId}
          propertyId={propertyId}
          members={members}
          disabledReason={dirtyAssets.length > 0 ? BLOCKED_BY_UNSAVED : null}
        />
      ) : null}
    </div>
  );
}
