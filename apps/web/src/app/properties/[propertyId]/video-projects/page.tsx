import { redirect } from "next/navigation";
import { CAMERA_MOTIONS, hasPermission, humanizeCameraMotion } from "@app/domain";
import { getCurrentUser } from "@/lib/auth";
import { getIdentityServices } from "@/lib/identity";
import { getPropertyServices } from "@/lib/property";
import { getStoryboardService, toVideoProjectDto } from "@/lib/storyboard";
import { ProjectsView } from "./projects-view";
import type { CameraMotionOption } from "./create-panel";

export const dynamic = "force-dynamic";

/**
 * Camera-motion choices, resolved **here** and passed down as plain data.
 *
 * `CreateProjectPanel` is a Client Component, so importing `CAMERA_MOTIONS` or
 * `humanizeCameraMotion` there would put domain code in the browser bundle —
 * the boundary rule established in Phase 3B-3b and repeated for room types.
 *
 * The list is presentation only. The server refuses an unapproved value
 * regardless of what this component offers, because the same route serves API
 * callers who never load this page (ADR-0022).
 */
const CAMERA_MOTION_OPTIONS: readonly CameraMotionOption[] = CAMERA_MOTIONS.map((value) => ({
  value,
  label: humanizeCameraMotion(value),
}));

/**
 * A property's video projects.
 *
 * Data loading only; the markup lives in {@link ProjectsView}. Reads go through
 * the application service boundary — never a repository — and every one of them
 * is scoped to an organization the signed-in user actually belongs to, which is
 * checked again inside the service.
 */
export default async function VideoProjectsPage({
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
    const projects = await getStoryboardService().listProjects(
      current.user.id,
      organization.id,
      propertyId,
    );

    return (
      <section>
        <p className="muted">
          <a href={`/properties/${property.id}`}>← {property.name}</a>
        </p>
        <h1>Videos</h1>
        <p className="muted">
          {organization.name} · signed in as {role}. A storyboard is composed only from photos a
          person has approved, and nothing is published automatically.
        </p>

        <ProjectsView
          organizationId={organization.id}
          propertyId={property.id}
          projects={projects.map(toVideoProjectDto)}
          canCreate={hasPermission(role, "property:write")}
          cameraMotionOptions={CAMERA_MOTION_OPTIONS}
        />
      </section>
    );
  }

  redirect("/?error=Property%20not%20found");
}
