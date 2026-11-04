import { describe, expect, it } from "vitest";
import { readVideoPreview } from "./video-preview";

/**
 * The link the project page plays its delivered video from (GS-12b-2,
 * ADR-0117): asked for only when the page's progress shows the video
 * completed, as the member, and handed to the player as plain data.
 */

const NOW = Date.parse("2026-11-04T09:00:00.000Z");

function preview(answer: { url: string; expiresAt: Date } | null | Error) {
  const calls: [string, string, string][] = [];
  return {
    calls,
    service: {
      link: (actorUserId: string, organizationId: string, videoProjectId: string) => {
        calls.push([actorUserId, organizationId, videoProjectId]);
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    },
  };
}

describe("the project page's video link", () => {
  it("asks for a link to a completed video as the member, and passes it on with how long it has left", async () => {
    const { calls, service } = preview({
      url: "https://app.test/api/storage/download?token=t",
      expiresAt: new Date("2026-11-04T09:05:00.000Z"),
    });
    expect(await readVideoPreview(service, true, "usr_1", "org_1", "vpr_1", () => NOW)).toEqual({
      src: "https://app.test/api/storage/download?token=t",
      lifetimeSeconds: 300,
    });
    expect(calls).toEqual([["usr_1", "org_1", "vpr_1"]]);
  });

  it("counts whole seconds left on the server's clock, and none for a link already run out", async () => {
    const { service } = preview({
      url: "https://app.test/api/storage/download?token=t",
      expiresAt: new Date("2026-11-04T09:05:00.000Z"),
    });
    const at = (iso: string) => () => Date.parse(iso);
    expect(await readVideoPreview(service, true, "usr_1", "org_1", "vpr_1", at("2026-11-04T09:00:00.999Z"))).toEqual({
      src: "https://app.test/api/storage/download?token=t",
      lifetimeSeconds: 299,
    });
    const late = await readVideoPreview(service, true, "usr_1", "org_1", "vpr_1", at("2026-11-04T09:05:01.000Z"));
    expect(late?.lifetimeSeconds).toBe(0);
  });

  it("asks for none for a video that is not completed", async () => {
    const { calls, service } = preview(new Error("must not be asked"));
    expect(await readVideoPreview(service, false, "usr_1", "org_1", "vpr_1")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("shows no player when the link service has none to give", async () => {
    const { service } = preview(null);
    expect(await readVideoPreview(service, true, "usr_1", "org_1", "vpr_1")).toBeNull();
  });

  it("lets a failure through, as a photo link's is", async () => {
    const { service } = preview(new Error("store down"));
    await expect(readVideoPreview(service, true, "usr_1", "org_1", "vpr_1")).rejects.toThrow("store down");
  });
});
