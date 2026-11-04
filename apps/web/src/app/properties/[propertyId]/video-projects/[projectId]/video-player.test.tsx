// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VideoPlayerSource } from "@/lib/video-progress-view";
import { LINK_EXPIRY_MARGIN_MS, PLAYBACK_FAILED, VideoPlayer } from "./video-player";

/**
 * The delivered video's player (GS-12b-2, ADR-0117): it plays from its link,
 * reads nothing but the video's length before it is played, and asks the page
 * once for a new link when the video fails after its link ran out, going back
 * to where it was.
 */

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const NOW = Date.parse("2026-11-04T09:00:00.000Z");
const FIRST: VideoPlayerSource = {
  src: "https://app.test/api/storage/download?token=first",
  expiresAt: "2026-11-04T09:05:00.000Z",
};
const SECOND: VideoPlayerSource = {
  src: "https://app.test/api/storage/download?token=second",
  expiresAt: "2026-11-04T09:10:00.000Z",
};

let play: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  refresh.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function video(): HTMLVideoElement {
  return screen.getByLabelText("The delivered video") as HTMLVideoElement;
}

/**
 * The video at `time`, last played or paused by the member. It reads paused
 * either way, as a browser marks it before it reports a failure.
 */
function at(time: number, playing: boolean): void {
  fireEvent.play(video());
  if (!playing) fireEvent.pause(video());
  video().currentTime = time;
  Object.defineProperty(video(), "paused", { configurable: true, value: true });
}

describe("the delivered video's player", () => {
  it("plays from its link with the browser's controls, inline, reading only its length before it is played", () => {
    render(<VideoPlayer source={FIRST} />);
    expect(video().getAttribute("src")).toBe(FIRST.src);
    expect(video().hasAttribute("controls")).toBe(true);
    // Downloading is its own audited action (GS-12c), never the player's menu.
    expect(video().getAttribute("controlslist")).toBe("nodownload");
    expect(video().hasAttribute("playsinline")).toBe(true);
    expect(video().getAttribute("preload")).toBe("metadata");
    expect(video().hasAttribute("autoplay")).toBe(false);
    expect(video().className).toBe("video-player");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says it cannot be played when it fails while its link is still good, and asks for no new link", () => {
    render(<VideoPlayer source={FIRST} />);
    vi.setSystemTime(Date.parse(FIRST.expiresAt) - LINK_EXPIRY_MARGIN_MS - 1);
    fireEvent.error(video());
    expect(screen.getByRole("alert").textContent).toBe(PLAYBACK_FAILED);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("asks the page once for a new link when it fails as its link runs out, and resumes playing where it was", () => {
    const { rerender } = render(<VideoPlayer source={FIRST} />);
    at(42.5, true);
    vi.setSystemTime(Date.parse(FIRST.expiresAt) - LINK_EXPIRY_MARGIN_MS);
    fireEvent.error(video());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(LINK_EXPIRY_MARGIN_MS).toBe(30_000);

    rerender(<VideoPlayer source={SECOND} />);
    expect(video().getAttribute("src")).toBe(SECOND.src);
    video().currentTime = 0;
    fireEvent.loadedMetadata(video());
    expect(video().currentTime).toBe(42.5);
    expect(play).toHaveBeenCalledTimes(1);
    // Only once: a later load of the same link starts where the browser puts it.
    video().currentTime = 0;
    fireEvent.loadedMetadata(video());
    expect(video().currentTime).toBe(0);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("resumes a paused video paused", () => {
    const { rerender } = render(<VideoPlayer source={FIRST} />);
    at(10, false);
    vi.setSystemTime(Date.parse(FIRST.expiresAt) + 1);
    fireEvent.error(video());
    rerender(<VideoPlayer source={SECOND} />);
    fireEvent.loadedMetadata(video());
    expect(video().currentTime).toBe(10);
    expect(play).not.toHaveBeenCalled();
  });

  it("asks for a new link at most once per link, and says so when that one fails too", () => {
    const { rerender } = render(<VideoPlayer source={FIRST} />);
    vi.setSystemTime(Date.parse(FIRST.expiresAt) + 1);
    fireEvent.error(video());
    fireEvent.error(video());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toBe(PLAYBACK_FAILED);

    // The new link plays afresh, and is itself renewed once when it runs out.
    rerender(<VideoPlayer source={SECOND} />);
    expect(screen.queryByRole("alert")).toBeNull();
    vi.setSystemTime(Date.parse(SECOND.expiresAt) + 1);
    fireEvent.error(video());
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("plays nothing on its own when the page loads", () => {
    render(<VideoPlayer source={FIRST} />);
    fireEvent.loadedMetadata(video());
    expect(play).not.toHaveBeenCalled();
    expect(video().currentTime).toBe(0);
  });
});
