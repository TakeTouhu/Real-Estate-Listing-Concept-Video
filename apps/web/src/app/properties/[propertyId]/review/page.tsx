import { redirect } from "next/navigation";
import { ROOM_TYPES } from "@app/domain";
import { getCurrentUser } from "@/lib/auth";
import { getAnalysisService } from "@/lib/analysis";
import { getIdentityServices } from "@/lib/identity";
import { getPropertyServices } from "@/lib/property";
import { thumbnailUrls } from "@/lib/thumbnails";
import {
  buildReviewBoard,
  humanizeRoomType,
  type DuplicateCluster,
  type ReviewBoard,
  type ReviewItem,
} from "@/lib/review-view";
import { ReviewItemControls, type CorrectionTarget } from "./review-item-controls";
import type { RoomOption } from "./correction-panel";

export const dynamic = "force-dynamic";

/**
 * Room choices for the correction control, resolved **here** and passed down as
 * plain data. The correction panel is a Client Component, so importing
 * `ROOM_TYPES` or `humanizeRoomType` there would put domain code in the browser
 * bundle — the boundary rule established in Phase 3B-3b and repeated for
 * `minimumScenes` in 3C-6b.
 */
const ROOM_OPTIONS: readonly RoomOption[] = ROOM_TYPES.map((value) => ({
  value,
  label: humanizeRoomType(value),
}));

/**
 * The review surface: what the analyzer decided, what a person corrected, and
 * the approve/reject decision. Corrections and decisions are separate writes,
 * and a decided revision shows its corrections read-only — changing them means
 * refreshing the analysis into a new revision (ADR-0015).
 */
export default async function ReviewPage({
  params,
}: {
  params: Promise<{ propertyId: string }>;
}) {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  const { propertyId } = await params;

  const organizations = await getIdentityServices().organizations.listForUser(current.user.id);
  const services = getPropertyServices();

  for (const { organization, role } of organizations) {
    let property;
    try {
      property = await services.properties.get(current.user.id, organization.id, propertyId);
    } catch {
      continue;
    }
    const assets = await services.assets.list(current.user.id, organization.id, propertyId);
    const analyses = await getAnalysisService().listForProperty(
      current.user.id,
      organization.id,
      propertyId,
    );
    const board = buildReviewBoard(assets, analyses, role);
    const thumbnails = await thumbnailUrls(current.user.id, organization.id, assets);

    return (
      <section>
        <p className="muted">
          <a href={`/properties/${property.id}`}>← {property.name}</a>
        </p>
        <h1>Review</h1>
        <p className="muted">
          {organization.name} · signed in as {role}. Every photo used for generation must be
          approved by a person; nothing is published automatically.
        </p>
        {board.canReview ? null : (
          <p className="card status-bad">
            Your role can read this review queue but cannot approve or reject photos.
          </p>
        )}

        <Section title="Awaiting decision" count={board.awaiting.length + clusterCount(board)}>
          {board.clusters.map((cluster) => (
            <Cluster
              key={cluster.duplicateGroup}
              cluster={cluster}
              thumbnails={thumbnails}
              organizationId={organization.id}
              propertyId={property.id}
            />
          ))}
          {board.awaiting.map((item) => (
            <div key={item.assetId}>
              <Item item={item} thumbnails={thumbnails} />
              <Controls
                organizationId={organization.id}
                propertyId={property.id}
                items={[item]}
              />
            </div>
          ))}
        </Section>

        <Section title="Decided" count={board.decided.length}>
          {board.decided.map((item) => (
            <Item key={item.assetId} item={item} thumbnails={thumbnails} />
          ))}
        </Section>

        <Section title="Not reviewable yet" count={board.notReviewable.length}>
          {board.notReviewable.map((item) => (
            <Item key={item.assetId} item={item} thumbnails={thumbnails} />
          ))}
        </Section>
      </section>
    );
  }

  redirect("/?error=Property%20not%20found");
}

/** Awaiting photos inside clusters, so the header counts photos and not cards. */
function clusterCount(board: ReviewBoard): number {
  return board.clusters.flatMap((c) => c.items).filter((i) => i.bucket === "AWAITING").length;
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="card">
      <h2>
        {title} <span className="muted">({count})</span>
      </h2>
      {count === 0 ? <p className="muted">Nothing here.</p> : children}
    </div>
  );
}

function Cluster({
  cluster,
  thumbnails,
  organizationId,
  propertyId,
}: {
  cluster: DuplicateCluster;
  thumbnails: Map<string, string>;
  organizationId: string;
  propertyId: string;
}) {
  return (
    <div className="cluster">
      <p className="muted">
        {cluster.items.length} near-duplicate photos. Only one may be approved; approving requires
        choosing which is the primary.
      </p>
      {cluster.items.map((item) => (
        <Item key={item.assetId} item={item} thumbnails={thumbnails} />
      ))}
      <Controls
        organizationId={organizationId}
        propertyId={propertyId}
        items={cluster.items}
      />
    </div>
  );
}

/**
 * Mount the review controls where the member actually has something to do.
 *
 * Corrections and decisions are separate writes, but they are coordinated:
 * {@link ReviewItemControls} blocks approval while a correction is unsaved, so
 * an approval cannot freeze the revision around correction state the reviewer
 * can still see on screen. Nothing renders when the member can neither correct
 * nor decide — absent controls rather than disabled ones.
 */
function Controls({
  organizationId,
  propertyId,
  items,
}: {
  organizationId: string;
  propertyId: string;
  items: readonly ReviewItem[];
}) {
  const members = items
    .filter((item) => item.actions.canApprove || item.actions.canReject)
    .map((item) => ({
      assetId: item.assetId,
      filename: item.filename,
      canApprove: item.actions.canApprove,
      canReject: item.actions.canReject,
    }));
  const corrections: CorrectionTarget[] = items
    .filter((item) => item.correction?.canCorrect)
    .map((item) => ({
      assetId: item.assetId,
      filename: item.filename,
      analyzerRoomType: item.correction!.analyzerRoomType,
      roomTypeOverride: item.correction!.roomTypeOverride,
      orderOverride: item.correction!.orderOverride,
    }));
  if (members.length === 0 && corrections.length === 0) return null;

  // Authoritative-reset seam.
  //
  // `router.refresh()` re-fetches the server payload but deliberately preserves
  // client state, so the controls' unsaved-correction interlock would survive a
  // successful save and block the decision forever. Keying the wrapper on the
  // authoritative correction and review state means the refreshed payload —
  // and only it — remounts the controls, discarding local edit state at exactly
  // the moment the screen becomes fresh.
  const authoritativeKey = items
    .map((item) =>
      [
        item.assetId,
        item.analysisRevision ?? "",
        item.bucket,
        item.correction?.roomTypeOverride ?? "",
        item.correction?.orderOverride ?? "",
      ].join(":"),
    )
    .join("|");

  return (
    <ReviewItemControls
      key={authoritativeKey}
      organizationId={organizationId}
      propertyId={propertyId}
      corrections={corrections}
      members={members}
      roomOptions={ROOM_OPTIONS}
    />
  );
}

function Item({ item, thumbnails }: { item: ReviewItem; thumbnails: Map<string, string> }) {
  const thumbnail = thumbnails.get(item.assetId);
  return (
    <div className="review-item">
      {thumbnail ? <img className="review-thumb" src={thumbnail} alt="" /> : null}
      <div>
        <p className="review-name">
          {item.filename} <span className="muted">· {item.roomLabel}</span>
          {item.analysisRevision === null ? null : (
            <span className="muted"> · revision {item.analysisRevision}</span>
          )}
        </p>
        {item.notReviewableReason ? <p className="muted">{item.notReviewableReason}</p> : null}
        {item.blockingFlags.map((flag) => (
          <p key={flag.code} className="status-bad">
            Blocking · {flag.message}
          </p>
        ))}
        {item.warningFlags.map((flag) => (
          <p key={flag.code} className="muted">
            Warning · {flag.message}
          </p>
        ))}
        {item.lowConfidence && item.bucket !== "NOT_REVIEWABLE" ? (
          <p className="muted">Low confidence — confirm the room before approving.</p>
        ) : null}
        {/* A decision is immutable for its revision; only a refresh reopens review. */}
        {item.decision ? (
          <div className="decision">
            <p className={item.decision.status === "APPROVED" ? "status-ok" : "status-bad"}>
              {item.decision.status} · revision {item.decision.analysisRevision}
            </p>
            {item.decision.note ? <p>{item.decision.note}</p> : null}
            <p className="muted">
              by {item.decision.reviewedBy ?? "unknown"}
              {item.decision.reviewedAt ? ` · ${item.decision.reviewedAt.toISOString()}` : ""}
            </p>
            <p className="muted">
              Final for this revision. Refresh the analysis to review this photo again.
            </p>
          </div>
        ) : null}
        {/* Read-only for a decided or not-yet-reviewable row: the correction is
            visible but not editable, because the decision froze it. */}
        {item.correction && !item.correction.canCorrect && item.correction.corrected ? (
          <p className="muted">
            Corrected · analyzer read this as {item.correction.analyzerRoomType}, used as{" "}
            {item.correction.effectiveRoomType}
            {item.correction.orderOverride === null
              ? ""
              : ` · order priority ${item.correction.orderOverride}`}
          </p>
        ) : null}
        {item.actions.unavailableReason ? (
          <p className="muted">{item.actions.unavailableReason}</p>
        ) : null}
      </div>
    </div>
  );
}
