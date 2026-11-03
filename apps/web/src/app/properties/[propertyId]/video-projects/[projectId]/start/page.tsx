import { notFound, redirect } from "next/navigation";
import type { StartOffer } from "@app/domain";
import { AppError } from "@app/shared";
import { getCurrentUser } from "@/lib/auth";
import { getGenerationStartService } from "@/lib/generation-start";
import { startPages } from "@/lib/generation-start-form";
import { getIdentityServices } from "@/lib/identity";
import { getPropertyServices } from "@/lib/property";
import { humanizeRoomType } from "@/lib/review-view";
import { getStoryboardService } from "@/lib/storyboard";
import { resolveStoryboardForProperty } from "@/lib/storyboard-route";
import { StartView } from "./start-view";

export const dynamic = "force-dynamic";

/**
 * Starting a project's video (GS-10d, ADR-0112): what the start would be now,
 * and the form that starts it. Viewing writes nothing.
 *
 * Only where the start is built (development with the test provider,
 * ADR-0111): anywhere else the page is not found, before anything is read.
 */
export default async function StartVideoPage({
  params,
  searchParams,
}: {
  params: Promise<{ propertyId: string; projectId: string }>;
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const starts = getGenerationStartService();
  if (starts === null) notFound();
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  const { propertyId, projectId } = await params;
  const { error } = await searchParams;
  const message = typeof error === "string" ? error : null;

  const organizations = await getIdentityServices().organizations.listForUser(current.user.id);
  const services = getPropertyServices();

  for (const { organization } of organizations) {
    const property = await services.properties
      .get(current.user.id, organization.id, propertyId)
      .catch(() => null);
    if (property === null) continue;

    // The start's own read: its permissions first, then its reach.
    let offer: StartOffer | null;
    try {
      offer = await starts.offer(current.user.id, organization.id, projectId);
    } catch (failure) {
      if (!(failure instanceof AppError)) throw failure;
      if (failure.code === "NOT_FOUND") continue;
      if (failure.code !== "FORBIDDEN") throw failure;
      offer = null;
    }

    // The project must be this Property's, as on the project page; a member who
    // may not start is told so before the storyboard is read.
    const view =
      offer === null
        ? null
        : await resolveStoryboardForProperty(
            () => getStoryboardService().getStoryboard(current.user.id, organization.id, projectId),
            propertyId,
          );
    if (offer !== null && view === null) continue;

    const roomLabels = new Map(
      (view?.scenes ?? []).map((scene) => [scene.id, humanizeRoomType(scene.roomType)] as const),
    );
    const pages = startPages(property.id, projectId);
    return (
      <section>
        <p className="muted">
          <a href={pages.project}>← {view?.project.name ?? "Back to the project"}</a>
        </p>
        <h1>Start the video</h1>
        <p className="muted">
          {organization.name} · {property.name}
        </p>
        <StartView
          organizationId={organization.id}
          propertyId={property.id}
          projectId={projectId}
          offer={offer}
          roomLabels={roomLabels}
          // A new key for every offer shown: posting this form twice starts
          // once, and starting again means reviewing again (ADR-0111 Decision 3).
          idempotencyKey={crypto.randomUUID()}
          error={message}
        />
      </section>
    );
  }

  redirect("/?error=Property%20not%20found");
}
