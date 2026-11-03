import { describe, expect, it } from "vitest";
import { startOnProjectPage } from "./generation-start-form";

/** What the project page shows of the start (GS-10d, ADR-0112 Decision 4). */
const START = "/properties/prp_1/video-projects/vpr_1/start";
const MAY_START = ["video.view", "video.generate", "unit.consume"];

describe("the start on the project page", () => {
  it("links to the start page, and gives the notice after a start, where the start is built", () => {
    expect(startOnProjectPage(true, MAY_START, "prp_1", "vpr_1", "1")).toEqual({ startHref: START, started: true });
    expect(startOnProjectPage(true, MAY_START, "prp_1", "vpr_1", undefined)).toEqual({
      startHref: START,
      started: false,
    });
    expect(startOnProjectPage(true, MAY_START, "prp_1", "vpr_1", "yes").started).toBe(false);
    expect(startOnProjectPage(true, MAY_START, "prp_1", "vpr_1", ["1", "1"]).started).toBe(false);
  });

  it.each([
    ["video.generate", ["video.view", "unit.consume"]],
    ["unit.consume", ["video.view", "video.generate"]],
  ])("has no link for a member without %s", (_missing, permissions) => {
    expect(startOnProjectPage(true, permissions, "prp_1", "vpr_1", "1")).toEqual({ startHref: null, started: true });
  });

  it("shows neither where the start is not built", () => {
    expect(startOnProjectPage(false, MAY_START, "prp_1", "vpr_1", "1")).toEqual({ startHref: null, started: false });
  });
});
