// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VideoProgress } from "@app/domain";
import {
  NOT_DELIVERED_MESSAGE,
  videoProgressPanel,
  type VideoPlayerSource,
  type VideoProgressRead,
} from "@/lib/video-progress-view";
import { VideoProgressPanel } from "./video-progress-panel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

/**
 * The project's video on the project page (GS-11b, ADR-0114): each line the
 * panel carries, ADR-0052's message marked as Japanese, the support reference
 * always, and nothing that retries the video or names what made it.
 */

afterEach(cleanup);

function shown(read: VideoProgressRead, player: VideoPlayerSource | null = null) {
  const panel = videoProgressPanel(read);
  if (panel === null) throw new Error("no panel");
  return render(<VideoProgressPanel panel={panel} player={player} />);
}

const FAILED_VIDEO: VideoProgress = {
  phase: "FAILED",
  qualityTier: "HIGH_QUALITY",
  durationSeconds: 45,
  units: { count: 2, state: "RELEASED" },
  scenes: { ready: 1, total: 3 },
  supportReference: "gjob_failed",
};
const FAILED: VideoProgressRead = { kind: "PROGRESS", progress: FAILED_VIDEO };

describe("the project's video", () => {
  it("shows a failed video with ADR-0052's message in Japanese, its Units, a new start and its reference", () => {
    const { container } = shown(FAILED);
    const box = screen.getByRole("region", { name: "Video" });
    expect(box.tagName).toBe("SECTION");
    expect(box.className).toBe("card status-bad");
    // Read when the page loads: nothing announces it as live.
    expect(container.querySelector("[role=status], [aria-live]")).toBeNull();
    expect(screen.getByRole("heading", { name: "Video" })).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText(/HQ · 45 seconds/)).toBeTruthy();
    expect(screen.getByText(NOT_DELIVERED_MESSAGE).getAttribute("lang")).toBe("ja");
    expect(screen.getByText("The 2 HQ Units reserved for it came back; none was used.")).toBeTruthy();
    expect(screen.getByText("A new video can be started for this project.")).toBeTruthy();
    expect(screen.getByText("gjob_failed").tagName).toBe("CODE");
    // No control on it: nothing here retries the failed video.
    expect(container.querySelectorAll("a, button, form")).toHaveLength(0);
  });

  it("shows a video being made with its scenes and the reload note, and no message", () => {
    shown({
      kind: "PROGRESS",
      progress: { ...FAILED_VIDEO, phase: "COMPOSING", units: { count: 2, state: "RESERVED" } },
    });
    expect(screen.getByRole("region", { name: "Video" }).className).toBe("card");
    expect(screen.getByText("Composing")).toBeTruthy();
    expect(screen.getByText("1 of 3 scenes made")).toBeTruthy();
    expect(screen.getByText(/reload the page/)).toBeTruthy();
    expect(screen.queryByText(NOT_DELIVERED_MESSAGE)).toBeNull();
    expect(screen.queryByText(/can be started/)).toBeNull();
  });

  it("shows a delivered video as completed", () => {
    shown({
      kind: "PROGRESS",
      progress: { ...FAILED_VIDEO, phase: "COMPLETED", units: { count: 2, state: "CONSUMED" } },
    });
    expect(screen.getByRole("region", { name: "Video" }).className).toBe("card status-ok");
    expect(screen.getByText("It used 2 HQ Units.")).toBeTruthy();
  });

  it("plays a delivered video in the panel from its link, under its status (ADR-0117)", () => {
    const src = "https://app.test/api/storage/download?token=t";
    const { container } = shown(
      { kind: "PROGRESS", progress: { ...FAILED_VIDEO, phase: "COMPLETED", units: { count: 2, state: "CONSUMED" } } },
      { src, lifetimeSeconds: 300 },
    );
    const video = screen.getByLabelText("The delivered video");
    expect(screen.getByRole("region", { name: "Video" }).contains(video)).toBe(true);
    expect(video.getAttribute("src")).toBe(src);
    // Right under its status, before what became of its Units.
    expect(video.previousElementSibling?.textContent).toContain("Completed");
    expect(video.nextElementSibling?.textContent).toBe("It used 2 HQ Units.");
    expect(container.querySelectorAll("video")).toHaveLength(1);
  });

  it("shows no player without a link", () => {
    const { container } = shown(FAILED);
    expect(container.querySelector("video")).toBeNull();
  });

  it("shows a video it could not read with that alone, and its reference", () => {
    const { container } = shown({ kind: "UNREADABLE", supportReference: "gjob_9" });
    expect(screen.getByText("This video's progress could not be read.")).toBeTruthy();
    expect(screen.getByText("gjob_9")).toBeTruthy();
    expect(container.querySelectorAll("p")).toHaveLength(2);
  });

  it("names no provider, model or attempt", () => {
    const markup = shown(FAILED).container.innerHTML.toLowerCase();
    for (const internal of ["wavespeed", "provider", "model", "attempt", "prediction", "retry", "fake"]) {
      expect(markup).not.toContain(internal);
    }
  });
});
