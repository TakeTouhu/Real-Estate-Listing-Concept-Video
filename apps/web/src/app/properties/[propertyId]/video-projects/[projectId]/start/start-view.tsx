import type { StartOffer } from "@app/domain";
import { QUALITY_NAMES } from "@/lib/units-view";

interface Props {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly projectId: string;
  /** What a start would be now, or `null` for a member who may not start videos. */
  readonly offer: StartOffer | null;
  /** Each scene's room, by scene id, resolved by the server. */
  readonly roomLabels: ReadonlyMap<string, string>;
  /** Made by the server for this offer only: posting it twice starts once. */
  readonly idempotencyKey: string;
  /** Why the last start started nothing, as the start route words it. */
  readonly error: string | null;
}

/**
 * The start page's body (GS-10d, ADR-0112): the offer the start service read,
 * and for a `READY` offer the one form that starts it. Every refusal says why,
 * in words the customer can act on, and shows no form.
 */
export function StartView({ organizationId, propertyId, projectId, offer, roomLabels, idempotencyKey, error }: Props) {
  return (
    <>
      {error ? (
        <p className="card status-bad" role="alert">
          {error}
        </p>
      ) : null}
      {offer === null ? (
        <p className="card status-bad">You cannot start videos for this project.</p>
      ) : offer.kind === "READY" ? (
        <Ready
          organizationId={organizationId}
          propertyId={propertyId}
          projectId={projectId}
          offer={offer}
          roomLabels={roomLabels}
          idempotencyKey={idempotencyKey}
        />
      ) : (
        <p className="card">{refusal(offer)}</p>
      )}
    </>
  );
}

/** A count of Units of one quality: "1 HQ Unit", "2 HQ Units". */
function units(count: number, quality: string): string {
  return `${count} ${quality} Unit${count === 1 ? "" : "s"}`;
}

/** Why a start would not happen now, and what to do about it. */
export function refusal(offer: Exclude<StartOffer, { kind: "READY" }>): string {
  switch (offer.kind) {
    case "VIDEO_EXISTS":
      // A failed video holds its project until its Units are back (ADR-0110).
      return (
        (offer.delivered
          ? "This project's video has been delivered. "
          : "This project's video is in progress, or its Units have not come back yet. ") +
        "A project has one video at a time, and is started again only once its video has ended without being " +
        "delivered and its Units have come back."
      );
    case "NOT_COMPOSED":
      return "This project has no storyboard yet. Compose one on the project page, then review the video here.";
    case "STALE":
      return (
        "The approved photos have changed since the storyboard was composed. Compose it again on the project " +
        "page, then review the video here."
      );
    case "RECOMPOSE":
      return (
        "This storyboard must be composed again before a video can be made from it. Compose it on the project page."
      );
    case "QUALITY_NOT_OFFERED":
      return `${QUALITY_NAMES[offer.qualityTier]} videos cannot be made yet.`;
    case "LENGTH_NOT_SUPPORTED":
      return `The storyboard is ${offer.durationSeconds} seconds long, longer than a video VTaVision makes.`;
    case "NO_PLAN":
      return "This organization has no plan yet, or its plan has not started yet. Videos can be started once it has.";
    case "INSUFFICIENT_UNITS": {
      const quality = QUALITY_NAMES[offer.qualityTier];
      return (
        `This video needs ${units(offer.requiredUnits, quality)}, and the Units it may use cover ` +
        `${offer.eligibleUnits}. Ask a member who manages billing about additional ${quality} Units.`
      );
    }
  }
}

function Ready({
  organizationId,
  propertyId,
  projectId,
  offer,
  roomLabels,
  idempotencyKey,
}: Omit<Props, "offer" | "error"> & { readonly offer: Extract<StartOffer, { kind: "READY" }> }) {
  const quality = QUALITY_NAMES[offer.qualityTier];
  return (
    <div className="card">
      <h2>Review the video</h2>
      <p>
        Quality: {quality}. {offer.scenes.length} scenes, {offer.durationSeconds} seconds in all:
      </p>
      <ol>
        {offer.scenes.map((scene) => (
          <li key={scene.id}>
            {roomLabels.get(scene.id) ?? "Scene"} <span className="muted">· {scene.durationSeconds} seconds</span>
          </li>
        ))}
      </ol>
      <p>
        Starting now would reserve {units(offer.requiredUnits, quality)}: {funding(offer, quality)}. The start reserves
        them when you confirm, so the split can differ, or the Units fall short, if Units are reserved, released or
        bought meanwhile.
      </p>
      <p>
        The Units are used only if the video is delivered. If no video is delivered, they come back.
      </p>
      <p>
        The video is made from your approved photos and carries a notice that it was made with generative AI. It is
        not captured footage and makes no claim about dimensions. It is delivered to your organization only; nothing
        is published.
      </p>
      <form method="post" action={`/api/video-projects/${encodeURIComponent(projectId)}/generations`}>
        <input type="hidden" name="organizationId" value={organizationId} />
        <input type="hidden" name="propertyId" value={propertyId} />
        <input type="hidden" name="qualityTier" value={offer.qualityTier} />
        {offer.scenes.map((scene) => (
          <input key={scene.id} type="hidden" name="sceneId" value={scene.id} />
        ))}
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
        <button type="submit">
          Start the video and reserve {units(offer.requiredUnits, quality)}
        </button>
      </form>
      <p className="muted">
        Development only: this page exists only in development, and the video is made when the development pipeline
        command runs.
      </p>
    </div>
  );
}

/** Where the Units would come from, naming only the sources that give some. */
function funding(offer: Extract<StartOffer, { kind: "READY" }>, quality: string): string {
  const { baseUnits, addOnUnits } = offer.funding;
  const sources = [
    baseUnits > 0 ? `${baseUnits} of your plan's Base Units` : null,
    addOnUnits > 0 ? `${addOnUnits} additional ${quality} Unit${addOnUnits === 1 ? "" : "s"}` : null,
  ];
  return sources.filter((source) => source !== null).join(" and ");
}
