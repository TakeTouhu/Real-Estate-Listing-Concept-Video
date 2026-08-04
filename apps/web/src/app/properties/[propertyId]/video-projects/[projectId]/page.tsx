import { redirect } from "next/navigation";
import { MIN_STORYBOARD_SCENES, hasPermission } from "@app/domain";
import { getAnalysisService } from "@/lib/analysis";
import { getCurrentUser } from "@/lib/auth";
import { getIdentityServices } from "@/lib/identity";
import { getPropertyServices } from "@/lib/property";
import { humanizeRoomType } from "@/lib/review-view";
import { getStoryboardService, toVideoProjectDto } from "@/lib/storyboard";
import { thumbnailUrls } from "@/lib/thumbnails";
import { StoryboardView, type SceneRow } from "./storyboard-view";

export const dynamic = "force-dynamic";

/**
 * One video project and its storyboard.
 *
 * Data loading only; the markup lives in {@link StoryboardView}. Reads go
 * through the application service boundary — never a repository — and the
 * storyboard read recomputes freshness server-side, so `fresh` arrives already
 * decided rather than inferred here.
 *
 * The room label and the signed thumbnail are resolved on this side, so the
 * presentation module needs no domain import. `MIN_STORYBOARD_SCENES` is
 * likewise read here and passed down as a plain number: that module mounts a
 * Client Component, and a value import would be a route for domain code into
 * the browser bundle.
 */
export default async function StoryboardPage({
  params,
}: {
  params: Promise<{ propertyId: string; projectId: string }>;
}) {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  const { propertyId, projectId } = await params;

  const organizations = await getIdentityServices().organizations.listForUser(current.user.id);
  const services = getPropertyServices();

  for (const { organization, role } of organizations) {
    let property;
    try {
      property = await services.properties.get(current.user.id, organization.id, propertyId);
    } catch {
      continue;
    }

    const view = await getStoryboardService().getStoryboard(
      current.user.id,
      organization.id,
      projectId,
    );
    const assets = await services.assets.list(current.user.id, organization.id, propertyId);
    const analyses = await getAnalysisService().listForProperty(
      current.user.id,
      organization.id,
      propertyId,
    );
    const thumbnails = await thumbnailUrls(current.user.id, organization.id, assets);
    const filenames = new Map(assets.map((asset) => [asset.id, asset.originalFilename]));

    // Informational only. Whether a photo is *eligible* additionally depends on
    // the duplicate-group rule, which `selectEligibleAnalyses` owns — this count
    // deliberately does not reimplement it, does not claim to be the eligible
    // scene count, and does not gate composition. The compose result is
    // authoritative.
    const approvedCount = analyses.filter(
      (analysis) => analysis.status === "SUCCEEDED" && analysis.reviewStatus === "APPROVED",
    ).length;

    const scenes: SceneRow[] = view.scenes.map((scene) => ({
      id: scene.id,
      position: scene.position,
      roomLabel: humanizeRoomType(scene.roomType),
      durationSeconds: scene.durationSeconds,
      filename: filenames.get(scene.assetId) ?? "Photo",
      thumbnailUrl: thumbnails.get(scene.assetId) ?? null,
    }));

    return (
      <section>
        <p className="muted">
          <a href={`/properties/${property.id}/video-projects`}>← Videos</a>
        </p>
        <h1>{view.project.name}</h1>
        <p className="muted">
          {organization.name} · {property.name} · signed in as {role}. Nothing is generated or
          published automatically.
        </p>

        <StoryboardView
          organizationId={organization.id}
          project={toVideoProjectDto(view.project)}
          scenes={scenes}
          fresh={view.fresh}
          approvedCount={approvedCount}
          minimumScenes={MIN_STORYBOARD_SCENES}
          canCompose={hasPermission(role, "property:write")}
        />
      </section>
    );
  }

  redirect("/?error=Property%20not%20found");
}
