import { describe, expect, it } from "vitest";
import { videoProgressOf, type VideoProgress, type VideoProgressService } from "@app/domain";
import { AppError } from "@app/shared";
import { readVideoProgress } from "./video-progress";

/**
 * What the project page reads of its video (GS-11b, ADR-0114): the member's
 * own read of this organization's project, a project with no video as none,
 * a video the read refuses to describe as unreadable with its id and reported
 * as an error, and every other failure left to the page.
 */

const PROGRESS: VideoProgress = {
  phase: "COMPOSING",
  qualityTier: "NORMAL",
  durationSeconds: 30,
  units: { count: 1, state: "RESERVED" },
  scenes: { ready: 2, total: 2 },
  supportReference: "gjob_1",
};

function service(answer: VideoProgress | null | Error) {
  const reads: string[][] = [];
  const progress: Pick<VideoProgressService, "progress"> = {
    progress: (actor, organizationId, projectId) => {
      reads.push([actor, organizationId, projectId]);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  return { progress, reads };
}

/** A logger that records what it was told. */
function recorder() {
  const errors: [string, Record<string, unknown> | undefined][] = [];
  const log = { error: (message: string, fields?: Record<string, unknown>) => void errors.push([message, fields]) };
  return { log, errors };
}

describe("the project page's read of its video", () => {
  it("reads it as the member, in the organization, for the project", async () => {
    const { progress, reads } = service(PROGRESS);
    const { log, errors } = recorder();
    expect(await readVideoProgress(progress, log, "usr_1", "org_1", "vpr_1")).toEqual({
      kind: "PROGRESS",
      progress: PROGRESS,
    });
    expect(reads).toEqual([["usr_1", "org_1", "vpr_1"]]);
    expect(errors).toEqual([]);
  });

  it("reads a project that has no video as none", async () => {
    const { log, errors } = recorder();
    expect(await readVideoProgress(service(null).progress, log, "usr_1", "org_1", "vpr_1")).toEqual({ kind: "NONE" });
    expect(errors).toEqual([]);
  });

  it("reads a video the read refuses to describe as unreadable, with its id, and reports it", async () => {
    // The domain's own refusal: a video that ended without one, but whose Units were used.
    const refused = (() => {
      try {
        videoProgressOf({
          jobId: "gjob_9",
          jobState: "FAILED_TERMINAL",
          delivered: false,
          qualityTier: "HIGH_QUALITY",
          durationSeconds: 30,
          requiredUnits: 2,
          reservationState: "CONSUMED",
          sceneCount: 2,
          scenesReady: 1,
        });
      } catch (thrown) {
        return thrown as Error;
      }
      throw new Error("the read described a video whose Units contradict ADR-0052");
    })();
    const { log, errors } = recorder();
    expect(await readVideoProgress(service(refused).progress, log, "usr_1", "org_1", "vpr_1")).toEqual({
      kind: "UNREADABLE",
      supportReference: "gjob_9",
    });
    expect(errors).toEqual([
      [
        "A video's Units contradict whether it was delivered",
        { jobId: "gjob_9", organizationId: "org_1", videoProjectId: "vpr_1" },
      ],
    ]);
  });

  it("leaves every other failure to the page", async () => {
    for (const failure of [
      new AppError("NOT_FOUND", "Video project not found"),
      new AppError("FORBIDDEN", "Forbidden", { details: { jobId: "gjob_9" } }),
      new AppError("INTERNAL_ERROR", "A video's state is outside its vocabulary"),
      new AppError("INTERNAL_ERROR", "This video's progress could not be read", { details: { jobId: "" } }),
      new Error("connection lost"),
    ]) {
      const { log, errors } = recorder();
      await expect(readVideoProgress(service(failure).progress, log, "usr_1", "org_1", "vpr_1")).rejects.toBe(failure);
      expect(errors).toEqual([]);
    }
  });
});
