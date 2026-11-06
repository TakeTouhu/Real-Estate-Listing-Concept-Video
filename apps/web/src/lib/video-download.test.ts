import { describe, expect, it } from "vitest";
import { AppError, type AppErrorCode } from "@app/shared";
import { DOWNLOAD_NOTICES, downloadNotice, downloadOnProjectPage, requestDownload } from "./video-download";

/**
 * The download on the project page (GS-12c-3, ADR-0120): who is shown the
 * button, where a press sends the member for each answer the download service
 * gives, and that the page shows only its own notices, never text the URL
 * carries.
 */

function downloads(answer: { url: string; expiresAt: Date } | null | Error) {
  const calls: [string, string, string][] = [];
  const errors: [string, unknown][] = [];
  const service = {
    link: (actorUserId: string, organizationId: string, videoProjectId: string) => {
      calls.push([actorUserId, organizationId, videoProjectId]);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  const log = { error: (message: string, fields?: unknown) => void errors.push([message, fields]) };
  return { calls, errors, ask: () => requestDownload(service, log, "usr_1", "org_1", "vpr_1") };
}

const LINK = { url: "/api/storage/download?token=t", expiresAt: new Date("2026-11-06T09:05:00.000Z") };

describe("where a download sends the member", () => {
  it("sends the member to the link the service gives, asked for as the member, reporting nothing", async () => {
    const { calls, errors, ask } = downloads(LINK);
    expect(await ask()).toEqual({ to: "LINK", url: LINK.url });
    expect(calls).toEqual([["usr_1", "org_1", "vpr_1"]]);
    expect(errors).toEqual([]);
  });

  it("sends the member back to the page when there is no delivered video", async () => {
    const { errors, ask } = downloads(null);
    expect(await ask()).toEqual({ to: "PAGE", notice: "none" });
    expect(errors).toEqual([]);
  });

  it("answers a member who may not download it and a project out of reach alike, reporting nothing", async () => {
    for (const code of ["FORBIDDEN", "NOT_FOUND"] as const) {
      const { errors, ask } = downloads(new AppError(code, "refused"));
      expect(await ask()).toEqual({ to: "PAGE", notice: "forbidden" });
      expect(errors).toEqual([]);
    }
  });

  it("takes any other refusal as a failure to try again, and reports it by its code", async () => {
    const codes: AppErrorCode[] = [
      "UNAUTHENTICATED",
      "VALIDATION_FAILED",
      "RATE_LIMITED",
      "CONFIGURATION_ERROR",
      "PROVIDER_ERROR",
      "INTERNAL_ERROR",
    ];
    for (const code of codes) {
      const { errors, ask } = downloads(new AppError(code, "failed"));
      expect(await ask()).toEqual({ to: "PAGE", notice: "failed" });
      expect(errors).toEqual([
        ["A video's download link could not be given", { code, organizationId: "org_1", videoProjectId: "vpr_1" }],
      ]);
    }
  });

  it("reports the video's id with the failure when the refusal names it, as the page's support reference", async () => {
    const { errors, ask } = downloads(
      new AppError("INTERNAL_ERROR", "This video's progress could not be read", { details: { jobId: "gjob_9" } }),
    );
    expect(await ask()).toEqual({ to: "PAGE", notice: "failed" });
    expect(errors).toEqual([
      [
        "A video's download link could not be given",
        { code: "INTERNAL_ERROR", organizationId: "org_1", videoProjectId: "vpr_1", jobId: "gjob_9" },
      ],
    ]);
  });

  it("lets through what is not an application error, for the route to fail with", async () => {
    const { ask } = downloads(new TypeError("bug"));
    await expect(ask()).rejects.toThrow("bug");
  });
});

describe("the download button", () => {
  it("is given for a delivered video to a member holding video.download, posting to the project's route", () => {
    expect(downloadOnProjectPage(true, ["video.view", "video.download"], "org_1", "prp_1", "vpr_1")).toEqual({
      action: "/api/video-projects/vpr_1/download",
      organizationId: "org_1",
      propertyId: "prp_1",
    });
  });

  it("is not given for a video that is not delivered, or to a member without video.download", () => {
    expect(downloadOnProjectPage(false, ["video.view", "video.download"], "org_1", "prp_1", "vpr_1")).toBeNull();
    expect(downloadOnProjectPage(true, ["video.view", "video.generate"], "org_1", "prp_1", "vpr_1")).toBeNull();
    expect(downloadOnProjectPage(true, [], "org_1", "prp_1", "vpr_1")).toBeNull();
  });

  it("puts the project's id in the route's path as one segment", () => {
    expect(downloadOnProjectPage(true, ["video.download"], "org_1", "prp_1", "a/b?c")?.action).toBe(
      "/api/video-projects/a%2Fb%3Fc/download",
    );
  });
});

describe("the notice after a download that gave no link", () => {
  it("says what ADR-0120 Decision 3 says, for each code", () => {
    expect(DOWNLOAD_NOTICES).toEqual({
      none: "There is no delivered video to download.",
      forbidden: "You may not download this video.",
      failed:
        "The video could not be downloaded. Try again; if it keeps failing, contact support with the video's " +
        "support reference.",
    });
  });

  it("names each of the page's own notices by its code", () => {
    expect(downloadNotice("none")).toBe(DOWNLOAD_NOTICES.none);
    expect(downloadNotice("forbidden")).toBe(DOWNLOAD_NOTICES.forbidden);
    expect(downloadNotice("failed")).toBe(DOWNLOAD_NOTICES.failed);
  });

  it("shows nothing for any other value, never the text the URL carries", () => {
    for (const param of [undefined, "", "Your video is ready", "toString", "__proto__", "constructor", "NONE"]) {
      expect(downloadNotice(param)).toBeNull();
    }
    expect(downloadNotice(["none", "failed"])).toBeNull();
  });

  it("says nothing of why a member may not download, or of a provider", () => {
    for (const notice of Object.values(DOWNLOAD_NOTICES)) {
      expect(notice.toLowerCase()).not.toMatch(/permission|role|provider|model|not found/);
    }
  });
});
