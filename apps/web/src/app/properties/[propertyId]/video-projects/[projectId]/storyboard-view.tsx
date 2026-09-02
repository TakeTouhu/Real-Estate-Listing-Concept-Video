import { cameraMotionDisplay, type VideoProjectDto } from "@/lib/storyboard";
import { ComposePanel } from "./compose-panel";

/** Human labels for the persisted project status. */
const STATUS_LABELS: Record<VideoProjectDto["status"], string> = {
  DRAFT: "Draft",
  STORYBOARD_READY: "Storyboard ready",
  STORYBOARD_STALE: "Storyboard stale",
};

/**
 * One planned scene, already resolved for display by the server.
 *
 * The room label arrives humanized and the thumbnail arrives as a signed URL,
 * so this module needs no domain import to render either. It carries no
 * compiled prompt, no preservation or system negative constraints, no storage
 * key, and no analysis internals — the scene DTO does not expose them
 * (ADR-0014).
 */
export interface SceneRow {
  readonly id: string;
  readonly position: number;
  readonly roomLabel: string;
  readonly durationSeconds: number;
  readonly filename: string;
  /** Short-lived signed URL, or null when the asset has no thumbnail variant. */
  readonly thumbnailUrl: string | null;
}

interface Props {
  readonly organizationId: string;
  readonly project: VideoProjectDto;
  readonly scenes: readonly SceneRow[];
  /**
   * Whether the stored storyboard still matches the approved photos it was
   * composed from, recomputed by the server at read time.
   */
  readonly fresh: boolean;
  readonly approvedCount: number;
  /**
   * `MIN_STORYBOARD_SCENES`, resolved on the server and passed as a plain
   * number. The domain constant is deliberately **not** imported here: this
   * module mounts a Client Component, and a value import would be a route for
   * domain code into the browser bundle.
   */
  readonly minimumScenes: number;
  /** Whether this member's role carries `property:write`. Decided by the server. */
  readonly canCompose: boolean;
}

type Freshness = "NEVER_COMPOSED" | "FRESH" | "STALE";

/**
 * Which of the three states this storyboard is in.
 *
 * Derived from `fresh` and the scene count — **never from `project.status`**.
 * The persisted status is written at compose time and nothing updates it in the
 * background when an approval later changes (ADR-0012), so a project can read
 * `STORYBOARD_READY` while its storyboard no longer matches its inputs.
 * Trusting the status would present a stale storyboard as generation-ready,
 * which is precisely what must never happen.
 */
function freshnessOf(scenes: readonly SceneRow[], fresh: boolean): Freshness {
  if (scenes.length === 0) return "NEVER_COMPOSED";
  return fresh ? "FRESH" : "STALE";
}

export function StoryboardView({
  organizationId,
  project,
  scenes,
  fresh,
  approvedCount,
  minimumScenes,
  canCompose,
}: Props) {
  const freshness = freshnessOf(scenes, fresh);
  // The DTO carries the token, because that is the API contract. The label is a
  // read-surface concern, derived from the one domain vocabulary (ADR-0022).
  const motion = cameraMotionDisplay(project.cameraMotion);

  return (
    <>
      <div className="card">
        <h2>Project settings</h2>
        <dl>
          <dt>Name</dt>
          <dd>{project.name}</dd>
          <dt>Status</dt>
          <dd>{STATUS_LABELS[project.status]}</dd>
          <dt>Target length</dt>
          <dd>{project.durationSeconds} seconds</dd>
          <dt>Aspect ratio</dt>
          <dd>{project.aspectRatio}</dd>
          <dt>Output resolution</dt>
          <dd>{project.targetOutputResolution}</dd>
          {motion ? (
            <>
              <dt>Camera motion</dt>
              <dd>
                {motion.label}
                {motion.approved ? null : (
                    <span className="muted"> (legacy value, no longer selectable)</span>
                )}
              </dd>
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
        <p className="muted">
          These settings are fixed for this project. Composition needs at least {minimumScenes}{" "}
          approved photos; this property has {approvedCount} approved photos.
        </p>
      </div>

      <FreshnessBanner freshness={freshness} />

      {canCompose ? (
        <ComposePanel
          organizationId={organizationId}
          projectId={project.id}
          hasScenes={scenes.length > 0}
        />
      ) : (
        <p className="card muted">
          Your role can read this storyboard but cannot compose it.
        </p>
      )}

      <div className="card">
        <h2>
          Storyboard <span className="muted">({scenes.length} scenes)</span>
        </h2>
        {scenes.length === 0 ? (
          <p className="muted">Nothing composed yet.</p>
        ) : (
          scenes.map((scene) => <Scene key={scene.id} scene={scene} />)
        )}
        <p className="muted">
          A storyboard is a plan built from your approved photos. It is not a measured floor plan
          and makes no claim about dimensions or geometry.
        </p>
      </div>
    </>
  );
}

/**
 * The one place the customer learns whether this storyboard can be used.
 *
 * A stale storyboard is never described as ready or current.
 */
function FreshnessBanner({ freshness }: { freshness: Freshness }) {
  if (freshness === "NEVER_COMPOSED") {
    return (
      <p className="card muted">
        No storyboard composed yet. Compose one from the photos you have approved.
      </p>
    );
  }
  if (freshness === "FRESH") {
    return (
      <p className="card status-ok">
        This storyboard matches the photos currently approved for this property.
      </p>
    );
  }
  return (
    <p className="card status-bad">
      The approved photos have changed since this storyboard was composed. It is out of date and
      cannot be used until it is composed again.
    </p>
  );
}

function Scene({ scene }: { scene: SceneRow }) {
  return (
    <div className="scene-row">
      {scene.thumbnailUrl ? (
        <img className="review-thumb" src={scene.thumbnailUrl} alt="" />
      ) : null}
      <div>
        <p className="scene-name">
          {scene.position}. {scene.roomLabel} <span className="muted">· {scene.filename}</span>
        </p>
        <p className="muted">{scene.durationSeconds} seconds</p>
      </div>
    </div>
  );
}
