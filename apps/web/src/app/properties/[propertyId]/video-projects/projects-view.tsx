import type { VideoProjectDto } from "@/lib/storyboard";
import { CreateProjectPanel, type CameraMotionOption } from "./create-panel";

/**
 * Human labels for the persisted project status.
 *
 * Presentation only. Whether a *composed* storyboard still matches its approved
 * photos is the `fresh` flag on the storyboard read, which Phase 3C-6b surfaces
 * on the project detail page — this list neither computes it nor implies it.
 */
const STATUS_LABELS: Record<VideoProjectDto["status"], string> = {
  DRAFT: "Draft",
  STORYBOARD_READY: "Storyboard ready",
  STORYBOARD_STALE: "Storyboard stale",
};

interface Props {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly projects: readonly VideoProjectDto[];
  /** Whether this member's role carries `property:write`. Decided by the server. */
  readonly canCreate: boolean;
  /** Approved camera motions, resolved server-side and passed as plain data. */
  readonly cameraMotionOptions: readonly CameraMotionOption[];
}

/**
 * A property's video projects.
 *
 * A property may hold any number of projects; there is no active, default, or
 * primary one, and nothing here assumes a single project. Ordering is the
 * repository's — this view adds no sorting, filtering, search, or pagination
 * control.
 *
 * Each row links to the project's storyboard (Phase 3C-6b), which is where
 * composition, the scene preview, and the freshness state live.
 */
export function ProjectsView({
  organizationId,
  propertyId,
  projects,
  canCreate,
  cameraMotionOptions,
}: Props) {
  return (
    <>
      {canCreate ? (
        <CreateProjectPanel
          organizationId={organizationId}
          propertyId={propertyId}
          cameraMotionOptions={cameraMotionOptions}
        />
      ) : (
        <p className="card muted">
          Your role can read this property&rsquo;s video projects but cannot create one.
        </p>
      )}

      <div className="card">
        <h2>
          Video projects <span className="muted">({projects.length})</span>
        </h2>
        {projects.length === 0 ? (
          <p className="muted">No video projects yet.</p>
        ) : (
          projects.map((project) => (
            <ProjectRow key={project.id} project={project} propertyId={propertyId} />
          ))
        )}
      </div>
    </>
  );
}

/**
 * One project's product-facing settings.
 *
 * Everything shown here is the customer's own input or the project's lifecycle
 * status. Nothing internal appears: no organization id, no composition
 * fingerprint, no compiled prompt, no preservation or system negative
 * constraints, no provider or storage detail. The DTO does not carry them
 * (ADR-0014), so there is nothing here to leak.
 */
function ProjectRow({
  project,
  propertyId,
}: {
  project: VideoProjectDto;
  propertyId: string;
}) {
  return (
    <div className="project-row">
      <p className="project-name">
        <a href={`/properties/${propertyId}/video-projects/${project.id}`}>{project.name}</a>{" "}
        <span className={project.status === "STORYBOARD_READY" ? "status-ok" : "muted"}>
          · {STATUS_LABELS[project.status]}
        </span>
      </p>
      <dl>
        <dt>Target length</dt>
        <dd>{project.durationSeconds} seconds</dd>
        <dt>Aspect ratio</dt>
        <dd>{project.aspectRatio}</dd>
        <dt>Resolution</dt>
        <dd>{project.resolution}</dd>
        {project.cameraMotion ? (
          <>
            <dt>Camera motion</dt>
            <dd>{project.cameraMotion}</dd>
          </>
        ) : null}
        {project.prompt ? (
          <>
            <dt>Your notes</dt>
            <dd>{project.prompt}</dd>
          </>
        ) : null}
        {project.negativePrompt ? (
          <>
            <dt>Avoid</dt>
            <dd>{project.negativePrompt}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}
