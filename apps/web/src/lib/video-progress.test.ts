import { describe, expect, it } from "vitest";
import type { VideoProgress, VideoProgressService } from "@app/domain";
import { AppError } from "@app/shared";
import { readVideoProgress } from "./video-progress";

/**
 * What the project page reads of its video (GS-11b, ADR-0114): the member's
 * own read of this organization's project, a project with no video as none,
 * a video the read refuses to describe as unreadable with its id, and every
 * other failure left to the page.
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

describe("the project page's read of its video", () => {
  it("reads it as the member, in the organization, for the project", async () => {
    const { progress, reads } = service(PROGRESS);
    expect(await readVideoProgress(progress, "usr_1", "org_1", "vpr_1")).toEqual({
      kind: "PROGRESS",
      progress: PROGRESS,
    });
    expect(reads).toEqual([["usr_1", "org_1", "vpr_1"]]);
  });

  it("reads a project that has no video as none", async () => {
    expect(await readVideoProgress(service(null).progress, "usr_1", "org_1", "vpr_1")).toEqual({ kind: "NONE" });
  });

  it("reads a video the read refuses to describe as unreadable, with its id for support", async () => {
    const refused = new AppError("INTERNAL_ERROR", "This video's progress could not be read", {
      details: { jobId: "gjob_9" },
    });
    expect(await readVideoProgress(service(refused).progress, "usr_1", "org_1", "vpr_1")).toEqual({
      kind: "UNREADABLE",
      supportReference: "gjob_9",
    });
  });

  it("leaves every other failure to the page", async () => {
    for (const failure of [
      new AppError("NOT_FOUND", "Video project not found"),
      new AppError("FORBIDDEN", "Forbidden", { details: { jobId: "gjob_9" } }),
      new AppError("INTERNAL_ERROR", "A video's state is outside its vocabulary"),
      new AppError("INTERNAL_ERROR", "This video's progress could not be read", { details: { jobId: "" } }),
      new Error("connection lost"),
    ]) {
      await expect(readVideoProgress(service(failure).progress, "usr_1", "org_1", "vpr_1")).rejects.toBe(failure);
    }
  });
});
