import { redirect } from "next/navigation";
import type { MediaAsset } from "@app/domain";
import { getCurrentUser } from "@/lib/auth";
import { getAnalysisService } from "@/lib/analysis";
import { getIdentityServices } from "@/lib/identity";
import { getPropertyServices } from "@/lib/property";
import {
  buildReviewBoard,
  type DuplicateCluster,
  type ReviewBoard,
  type ReviewItem,
} from "@/lib/review-view";
import { ReviewDecisionPanel } from "./review-panel";

export const dynamic = "force-dynamic";

/**
 * Read-only review surface (Phase 3B-3a). Decision controls arrive in 3B-3b;
 * nothing here mutates, so it exposes no data a member could not already read
 * through the analysis API.
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
              <Decisions
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

/**
 * Short-lived signed thumbnail URLs, minted per render and never persisted.
 * An asset with no thumbnail variant simply renders without a preview.
 */
async function thumbnailUrls(
  userId: string,
  organizationId: string,
  assets: readonly MediaAsset[],
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  const previewable = assets.filter((a) => a.status === "READY" && a.thumbnailKey);
  for (const asset of previewable) {
    const signed = await getPropertyServices().assets.createDownloadUrl(
      userId,
      organizationId,
      asset.id,
      "thumbnail",
    );
    urls.set(asset.id, signed.url);
  }
  return urls;
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
      <Decisions
        organizationId={organizationId}
        propertyId={propertyId}
        items={cluster.items}
      />
    </div>
  );
}

/**
 * Mount the decision panel only for members that actually have an action —
 * so a decided revision, a viewer without `video:review`, and a photo whose
 * every action is barred render no controls at all rather than disabled ones.
 */
function Decisions({
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
  if (members.length === 0) return null;
  return (
    <ReviewDecisionPanel
      organizationId={organizationId}
      propertyId={propertyId}
      members={members}
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
        {item.actions.unavailableReason ? (
          <p className="muted">{item.actions.unavailableReason}</p>
        ) : null}
      </div>
    </div>
  );
}
