import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  type GenerationQualityTier,
  type StartGenerationInput,
  type StartGenerationOutcome,
} from "@app/domain";
import { AppError } from "@app/shared";

/**
 * The start form (GS-10c, ADR-0111 Decision 3): what the start page showed,
 * carried back as fields, where the route sends the customer after a start,
 * and the words for every way a start can be refused. Shape only; the start
 * service decides the rest.
 */

const QUALITIES: readonly GenerationQualityTier[] = ["NORMAL", "HIGH_QUALITY"];
const MAX_ID_LENGTH = 64;

function id(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH ? value : null;
}

/** The Property the start page belongs to, which only says where to send the customer. */
export function readPropertyId(form: FormData): string | null {
  return id(form.get("propertyId"));
}

/** The start the form carries, or `null` when it cannot be one. */
export function readGenerationStartForm(videoProjectId: string, form: FormData): StartGenerationInput | null {
  const organizationId = id(form.get("organizationId"));
  const qualityTier = QUALITIES.find((candidate) => candidate === form.get("qualityTier"));
  const key = form.get("idempotencyKey");
  const sent = form.getAll("sceneId");
  // In the order the page listed them, which is the storyboard's.
  const sceneIds = sent.map(id).filter((sceneId): sceneId is string => sceneId !== null);
  if (
    organizationId === null ||
    qualityTier === undefined ||
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    sceneIds.length === 0 ||
    sceneIds.length !== sent.length
  ) {
    return null;
  }
  return {
    organizationId,
    videoProjectId,
    idempotencyKey: key,
    confirmed: { qualityTier, storyboardSceneIds: sceneIds },
  };
}

/** The pages a start lands on: the project's own, and its start page (GS-10d). */
export function startPages(propertyId: string, videoProjectId: string): { project: string; start: string } {
  const project = `/properties/${encodeURIComponent(propertyId)}/video-projects/${encodeURIComponent(videoProjectId)}`;
  return { project, start: `${project}/start` };
}

export const NOT_USABLE = "The start request could not be read. Nothing was started. Review the video again.";

/**
 * Where a start's answer sends the customer: the project page when the video
 * started, now or by this same confirmation before; else the start page, saying
 * why nothing was started there.
 */
export type StartLanding = { readonly to: "PROJECT" } | { readonly to: "START"; readonly message: string };

const REFUSALS: Record<Exclude<StartGenerationOutcome["kind"], "STARTED" | "ALREADY_STARTED">, string> = {
  VIDEO_EXISTS: "This project already has a video, in progress or delivered. Nothing new was started.",
  STORYBOARD_CHANGED: "The storyboard changed after you reviewed it. Nothing was started. Review it again.",
  QUALITY_CHANGED: "The project's quality changed after you reviewed it. Nothing was started. Review it again.",
  QUALITY_NOT_OFFERED: "Videos of this project's quality cannot be made yet. Nothing was started.",
  LENGTH_NOT_SUPPORTED: "The storyboard is longer than a video VTaVision makes. Nothing was started.",
  NO_PLAN: "This organization has no plan yet, or its plan has not started. Nothing was started.",
  INSUFFICIENT_UNITS: "There are not enough Units for this video. Nothing was started.",
};

export function landingFor(outcome: StartGenerationOutcome): StartLanding {
  if (outcome.kind === "STARTED" || outcome.kind === "ALREADY_STARTED") return { to: "PROJECT" };
  return { to: "START", message: REFUSALS[outcome.kind] };
}

/**
 * The words for a start that failed. A refused permission, a project not found
 * and a storyboard that cannot be started say nothing was started; any other
 * failure may have come after the write, so the customer is sent to look
 * before trying again.
 */
export function failureMessage(error: AppError): string {
  switch (error.code) {
    case "FORBIDDEN":
      return "You cannot start videos for this project. Nothing was started.";
    case "NOT_FOUND":
      return "The video project was not found. Nothing was started.";
    case "VALIDATION_FAILED":
      return "This storyboard cannot be started as it is. Nothing was started. Review it again.";
    default:
      return "The start could not be confirmed. Check the project page before trying again.";
  }
}
