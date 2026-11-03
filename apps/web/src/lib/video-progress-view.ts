import type { GenerationQualityTier, VideoProgress, VideoProgressPhase } from "@app/domain";
import { QUALITY_NAMES } from "./units-view";

/**
 * How the project page words its video's progress (GS-11b, ADR-0114).
 *
 * Types only from the domain, so the panel that renders this needs no domain
 * code in its bundle. Nothing here names a provider, a model, an attempt or
 * why a video failed: the read carries none of them (ADR-0113).
 */

/** What the project page read of its video. */
export type VideoProgressRead =
  | { readonly kind: "NONE" }
  | { readonly kind: "PROGRESS"; readonly progress: VideoProgress }
  /** The read refused to describe it (ADR-0113 Decision 4); its id is still quoted to support. */
  | { readonly kind: "UNREADABLE"; readonly supportReference: string };

/** UXFlow's normalized states, as the page names them. */
export const PHASE_NAMES: Record<VideoProgressPhase, string> = {
  QUEUED: "Queued",
  GENERATING_SCENES: "Generating scenes",
  COMPOSING: "Composing",
  VALIDATING: "Validating",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

/**
 * ADR-0052's words for every video that ended without one, whatever its class
 * (Decisions 5 and 19; UXFlow, "Error recovery"). Shown as written.
 */
export const NOT_DELIVERED_MESSAGE = "動画を正常に生成できませんでした。今回の生成ではUnitは消費されていません。";

export interface VideoProgressPanel {
  /** The phase in UXFlow's words, or that it could not be read. */
  readonly status: string;
  readonly tone: "ok" | "bad" | "neutral";
  /** Its quality and length; `null` when it could not be read. */
  readonly summary: string | null;
  /** How many scenes are made, while it is being made. */
  readonly scenes: string | null;
  /** What became of its Units; `null` when it could not be read. */
  readonly units: string | null;
  /** ADR-0052's message, for a video that ended without one. */
  readonly notDelivered: string | null;
  /** Whether the project can be started again, for a video that ended without one. */
  readonly startAgain: string | null;
  /** That the page shows the progress as it was read. */
  readonly reload: string | null;
  readonly supportReference: string;
}

const IN_PROGRESS: readonly VideoProgressPhase[] = ["QUEUED", "GENERATING_SCENES", "COMPOSING", "VALIDATING"];

/** "1 HQ Unit", "2 Normal Units". */
export function unitsOf(count: number, quality: GenerationQualityTier): string {
  return `${count} ${QUALITY_NAMES[quality]} ${count === 1 ? "Unit" : "Units"}`;
}

/** The panel for what was read, or `null` when the project has no video. */
export function videoProgressPanel(read: VideoProgressRead): VideoProgressPanel | null {
  switch (read.kind) {
    case "NONE":
      return null;
    case "UNREADABLE":
      return {
        status: "This video's progress could not be read.",
        tone: "bad",
        summary: null,
        scenes: null,
        units: null,
        notDelivered: null,
        startAgain: null,
        reload: null,
        supportReference: read.supportReference,
      };
    case "PROGRESS":
      return panelOf(read.progress);
  }
}

function panelOf(progress: VideoProgress): VideoProgressPanel {
  const { phase, units, scenes } = progress;
  const inProgress = IN_PROGRESS.includes(phase);
  const ended = phase === "FAILED" || phase === "CANCELLED";
  return {
    status: PHASE_NAMES[phase],
    tone: phase === "COMPLETED" ? "ok" : ended ? "bad" : "neutral",
    summary: `${QUALITY_NAMES[progress.qualityTier]} · ${progress.durationSeconds} seconds`,
    scenes: inProgress ? `${scenes.ready} of ${scenes.total} scenes made` : null,
    units: unitsSentence(progress),
    notDelivered: ended ? NOT_DELIVERED_MESSAGE : null,
    // A project is started again once its video ended without one and its
    // Units came back (ADR-0110).
    startAgain: !ended
      ? null
      : units.state === "RESERVED"
        ? "This project can be started again once its Units have come back."
        : "This project can be started again.",
    reload: inProgress ? "This is its progress when the page was loaded; reload the page to see it now." : null,
    supportReference: progress.supportReference,
  };
}

/** What became of its Units, in words that never contradict ADR-0052. */
function unitsSentence({ phase, units, qualityTier }: VideoProgress): string {
  const reserved = unitsOf(units.count, qualityTier);
  switch (units.state) {
    case "NONE":
      return "It reserved no Units.";
    case "CONSUMED":
      return `It used ${reserved}.`;
    case "RELEASED":
      return `The ${reserved} reserved for it came back; none was used.`;
    case "RESERVED":
      return phase === "FAILED" || phase === "CANCELLED"
        ? `The ${reserved} reserved for it ${units.count === 1 ? "is" : "are"} still held, and come${
            units.count === 1 ? "s" : ""
          } back once settled; none was used.`
        : `${reserved} reserved for it, used only if it is delivered.`;
  }
}
