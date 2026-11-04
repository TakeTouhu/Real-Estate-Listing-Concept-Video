// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VIDEO_PREVIEW_LINK_TTL_SECONDS } from "@app/domain";
import type { VideoPlayerSource } from "@/lib/video-progress-view";
import { LINK_EXPIRY_MARGIN_MS, PLAYBACK_FAILED, VideoPlayer } from "./video-player";

/**
 * The delivered video's player (GS-12b-2, ADR-0117): it plays from its link,
 * reads nothing but the video's length before it is played, and asks the page
 * once for a new link when the video fails after its link ran out, going back
 * to where it was. How long a link has left is measured on the page's own
 * clock from when it arrived, and a link the page gives while the member
 * watches waits until it is needed.
 */

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const FIRST: VideoPlayerSource = { src: "https://app.test/api/storage/download?token=first", lifetimeSeconds: 300 };
const SECOND: VideoPlayerSource = { src: "https://app.test/api/storage/download?token=second", lifetimeSeconds: 300 };
const THIRD: VideoPlayerSource = { src: "https://app.test/api/storage/download?token=third", lifetimeSeconds: 300 };
/** How long, from its arrival, a five-minute link is taken as good. */
const GOOD_FOR_MS = 300_000 - LINK_EXPIRY_MARGIN_MS;

let clock: number;
let play: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  refresh.mockReset();
  clock = 1_000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-11-04T09:00:00.000Z"));
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

/** The member played the video and, unless still `playing`, paused it at `time`. */
function watched(time: number, playing: boolean): void {
  fireEvent.play(video());
  if (!playing) fireEvent.pause(video());
  video().currentTime = time;
}

/** The video fails, as a browser reports it: the error, then the video marked paused. */
function fails(): void {
  fireEvent.error(video());
  fireEvent.pause(video());
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
    expect(video().hasAttribute("aria-describedby")).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.loadedMetadata(video());
    expect(play).not.toHaveBeenCalled();
    expect(video().currentTime).toBe(0);
  });

  it("says it cannot be played when it fails while its link is still good, and asks for no new link", () => {
    render(<VideoPlayer source={FIRST} />);
    clock += GOOD_FOR_MS - 1;
    fails();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(PLAYBACK_FAILED);
    expect(alert.className).toBe("status-bad");
    expect(video().getAttribute("aria-describedby")).toBe(alert.id);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("asks the page once for a new link when it fails as its link runs out, and resumes playing where it was", () => {
    const { rerender } = render(<VideoPlayer source={FIRST} />);
    watched(42.5, true);
    clock += GOOD_FOR_MS;
    fails();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(LINK_EXPIRY_MARGIN_MS).toBe(30_000);
    // Failing again while the new link is on its way asks for no other.
    fails();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();

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
    watched(10, false);
    clock += GOOD_FOR_MS + 1;
    fails();
    rerender(<VideoPlayer source={SECOND} />);
    video().currentTime = 0;
    fireEvent.loadedMetadata(video());
    expect(video().currentTime).toBe(10);
    expect(play).not.toHaveBeenCalled();
  });

  it("lets a browser that will not resume playing leave the video paused where it was", () => {
    const refusal = Promise.reject(new DOMException("blocked", "NotAllowedError"));
    const handled = vi.spyOn(refusal, "then");
    play.mockReturnValue(refusal);
    const { rerender } = render(<VideoPlayer source={FIRST} />);
    watched(7, true);
    clock += GOOD_FOR_MS;
    fails();
    rerender(<VideoPlayer source={SECOND} />);
    video().currentTime = 0;
    fireEvent.loadedMetadata(video());
    // The refusal is handled, not left to fail the page.
    expect(handled).toHaveBeenCalledWith(undefined, expect.any(Function));
    expect(video().currentTime).toBe(7);
    expect(play).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("measures a link from when it arrived, so a browser whose date is set wrong renews no sooner", () => {
    vi.setSystemTime(Date.parse("2030-01-01T00:00:00.000Z"));
    render(<VideoPlayer source={FIRST} />);
    watched(3, true);
    fails();
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(PLAYBACK_FAILED);
  });

  it("counts the time the device slept, which the page's own clock does not", () => {
    render(<VideoPlayer source={FIRST} />);
    watched(10, false);
    // Fifteen minutes asleep: the date moves on, the page's own clock does not.
    vi.setSystemTime(Date.now() + 15 * 60_000);
    clock += 5_000;
    fails();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("takes a link as good for most of its life", () => {
    expect(VIDEO_PREVIEW_LINK_TTL_SECONDS * 1000 - LINK_EXPIRY_MARGIN_MS).toBe(GOOD_FOR_MS);
    // A margin as long as the link would make every new link look run out.
    expect(GOOD_FOR_MS).toBeGreaterThanOrEqual(VIDEO_PREVIEW_LINK_TTL_SECONDS * 1000 * 0.8);
  });

  it("renews the new link in its turn when it runs out", () => {
    const { rerender } = render(<VideoPlayer source={FIRST} />);
    watched(20, true);
    clock += GOOD_FOR_MS;
    fails();
    rerender(<VideoPlayer source={SECOND} />);
    clock += GOOD_FOR_MS;
    fails();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<VideoPlayer source={THIRD} />);
    expect(video().getAttribute("src")).toBe(THIRD.src);
  });

  it("says it cannot be played when the new link fails while it is still good", () => {
    const { rerender } = render(<VideoPlayer source={FIRST} />);
    watched(20, true);
    clock += GOOD_FOR_MS;
    fails();
    // A new link is measured from when it came, however long that took.
    clock += 60_000;
    rerender(<VideoPlayer source={SECOND} />);
    clock += GOOD_FOR_MS - 1;
    fails();
    expect(screen.getByRole("alert").textContent).toBe(PLAYBACK_FAILED);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps a link the page gives while the member watches until the one playing runs out", () => {
    const { rerender } = render(<VideoPlayer source={FIRST} />);
    watched(30, true);
    clock += 60_000;
    rerender(<VideoPlayer source={SECOND} />);
    expect(video().getAttribute("src")).toBe(FIRST.src);

    clock += GOOD_FOR_MS - 60_000;
    watched(95, true);
    fails();
    expect(refresh).not.toHaveBeenCalled();
    expect(video().getAttribute("src")).toBe(SECOND.src);
    video().currentTime = 0;
    fireEvent.loadedMetadata(video());
    expect(video().currentTime).toBe(95);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("keeps a link the page gives while the video is paused part way", () => {
    const { rerender } = render(<VideoPlayer source={FIRST} />);
    watched(30, false);
    rerender(<VideoPlayer source={SECOND} />);
    expect(video().getAttribute("src")).toBe(FIRST.src);
  });

  it("keeps a link the page gives once the member has moved the video without playing it", () => {
    const { rerender } = render(<VideoPlayer source={FIRST} />);
    video().currentTime = 40;
    fireEvent.seeked(video());
    rerender(<VideoPlayer source={SECOND} />);
    expect(video().getAttribute("src")).toBe(FIRST.src);
  });

  it("resumes nothing after a failure: a later link starts where the browser puts it", () => {
    const { rerender } = render(<VideoPlayer source={FIRST} />);
    watched(30, true);
    clock += 60_000;
    rerender(<VideoPlayer source={SECOND} />);
    clock += GOOD_FOR_MS - 60_000;
    fails();
    expect(video().getAttribute("src")).toBe(SECOND.src);
    // The waiting link fails before it loads, while it is still good.
    fails();
    expect(screen.getByRole("alert").textContent).toBe(PLAYBACK_FAILED);
    rerender(<VideoPlayer source={THIRD} />);
    expect(video().getAttribute("src")).toBe(THIRD.src);
    video().currentTime = 0;
    fireEvent.loadedMetadata(video());
    expect(video().currentTime).toBe(0);
    expect(play).not.toHaveBeenCalled();
  });

  it("asks for a new link when the one waiting has run out too", () => {
    const { rerender } = render(<VideoPlayer source={FIRST} />);
    watched(30, true);
    rerender(<VideoPlayer source={SECOND} />);
    clock += GOOD_FOR_MS;
    fails();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(video().getAttribute("src")).toBe(FIRST.src);
    rerender(<VideoPlayer source={THIRD} />);
    expect(video().getAttribute("src")).toBe(THIRD.src);
  });

  it("takes a new link at once before the video is played, and after it has failed", () => {
    const { rerender } = render(<VideoPlayer source={FIRST} />);
    rerender(<VideoPlayer source={SECOND} />);
    expect(video().getAttribute("src")).toBe(SECOND.src);

    watched(5, true);
    fails();
    expect(screen.getByRole("alert").textContent).toBe(PLAYBACK_FAILED);
    rerender(<VideoPlayer source={THIRD} />);
    expect(video().getAttribute("src")).toBe(THIRD.src);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("reports a failure the browser met before the page could listen for it", () => {
    const original = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "error");
    Object.defineProperty(HTMLMediaElement.prototype, "error", {
      configurable: true,
      get: () => ({ code: 4 }),
    });
    try {
      render(<VideoPlayer source={FIRST} />);
      expect(screen.getByRole("alert").textContent).toBe(PLAYBACK_FAILED);
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(HTMLMediaElement.prototype, "error", original);
    }
  });
});
