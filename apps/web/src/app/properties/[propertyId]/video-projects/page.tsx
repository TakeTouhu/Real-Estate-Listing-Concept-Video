import { redirect } from "next/navigation";
import { hasPermission } from "@app/domain";
import { getCurrentUser } from "@/lib/auth";
import { getIdentityServices } from "@/lib/identity";
import { getPropertyServices } from "@/lib/property";
import { getStoryboardService, toVideoProjectDto } from "@/lib/storyboard";
import { ProjectsView } from "./projects-view";

export const dynamic = "force-dynamic";

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
        />
      </section>
    );
  }

  redirect("/?error=Property%20not%20found");
}
