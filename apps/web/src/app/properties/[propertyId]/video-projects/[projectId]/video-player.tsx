"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { VideoPlayerSource } from "@/lib/video-progress-view";

/**
 * A link this close to running out is taken as run out: the browser's clock and
 * the server's need not agree.
 */
export const LINK_EXPIRY_MARGIN_MS = 30_000;

/** Shown when the video cannot be played and a new link would not help. */
export const PLAYBACK_FAILED = "The video could not be played. Reload the page to try again.";

/**
 * The project's delivered video, played in the page (GS-12b-2, ADR-0117)
 * straight from its signed link, a range at a time (ADR-0115). Nothing plays
 * until the member presses play, and only the video's length and first frame
 * are read before. The browser's own controls offer no download: downloading
 * is its own audited action, for members holding `video.download` (GS-12c).
 *
 * A link lives five minutes (ADR-0116), and a player keeps asking for ranges
 * while the video is watched, so one may run out while it is open. When the
 * video fails to load once its link has run out, the page is asked once for a
 * new one, and the video goes back to where it was, playing if it was. Any
 * other failure, or a second one on the same link, says so and stops.
 */
export function VideoPlayer({ source }: { source: VideoPlayerSource }) {
  const router = useRouter();
  const video = useRef<HTMLVideoElement>(null);
  /**
   * Whether the member last pressed play rather than pause. Read from the
   * events, not from the video: a browser marks it paused before it reports
   * the failure.
   */
  const playing = useRef(false);
  /** The link a new one was asked for, so each link is renewed at most once. */
  const renewed = useRef<string | null>(null);
  /** Where the member was when the link ran out, for the new one to resume from. */
  const resume = useRef<{ time: number; playing: boolean } | null>(null);
  /** The link that failed, so a new link starts without the message. */
  const [failed, setFailed] = useState<string | null>(null);

  function onError(): void {
    const element = video.current;
    const runOut = Date.now() >= Date.parse(source.expiresAt) - LINK_EXPIRY_MARGIN_MS;
    if (runOut && element !== null && renewed.current !== source.src) {
      renewed.current = source.src;
      resume.current = { time: element.currentTime, playing: playing.current };
      router.refresh();
      return;
    }
    setFailed(source.src);
  }

  function onLoadedMetadata(): void {
    const element = video.current;
    const at = resume.current;
    if (element === null || at === null) return;
    resume.current = null;
    element.currentTime = at.time;
    if (at.playing) void element.play().catch(() => undefined);
  }

  return (
    <>
      <video
        ref={video}
        className="video-player"
        src={source.src}
        controls
        controlsList="nodownload"
        playsInline
        preload="metadata"
        aria-label="The delivered video"
        onPlay={() => (playing.current = true)}
        onPause={() => (playing.current = false)}
        onError={onError}
        onLoadedMetadata={onLoadedMetadata}
      />
      {failed === source.src ? <p role="alert">{PLAYBACK_FAILED}</p> : null}
    </>
  );
}
