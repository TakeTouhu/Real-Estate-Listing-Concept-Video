"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import type { VideoPlayerSource } from "@/lib/video-progress-view";

/**
 * A link this close to running out is taken as run out: it was signed a little
 * before it reached the page.
 */
export const LINK_EXPIRY_MARGIN_MS = 30_000;

/** Shown when the video cannot be played and a new link would not help. */
export const PLAYBACK_FAILED = "The video could not be played. Reload the page to try again.";

/** A link as this page holds it. */
interface HeldLink {
  readonly src: string;
  /** How long after it arrived it is taken as run out. */
  readonly goodForMs: number;
  /** When it arrived, on the page's own clock (`performance.now()`), which stops while the device sleeps. */
  readonly arrivedAt: number;
  /** When it arrived by the browser's date, which keeps counting while the device sleeps. */
  readonly arrivedOn: number;
}

function held(source: VideoPlayerSource): HeldLink {
  const goodForMs = source.lifetimeSeconds * 1000 - LINK_EXPIRY_MARGIN_MS;
  return { src: source.src, goodForMs, arrivedAt: performance.now(), arrivedOn: Date.now() };
}

/**
 * Whether a link has run out: the longer of the two times since it arrived,
 * each measured on one clock, so neither clock is compared with the server's.
 */
function hasRunOut(link: HeldLink): boolean {
  const age = Math.max(performance.now() - link.arrivedAt, Date.now() - link.arrivedOn);
  return age >= link.goodForMs;
}

/**
 * The project's delivered video, played in the page (GS-12b-2, ADR-0117)
 * straight from its signed link, a range at a time (ADR-0115). Nothing plays
 * until the member presses play, and the browser is asked to read only the
 * video's length and first frame before. Its controls offer no download where
 * the browser honours that: downloading is its own audited action, for members
 * holding `video.download` (GS-12c).
 *
 * A link lives five minutes (ADR-0116), and a player keeps asking for ranges
 * while the video is watched, so one may run out while it is open. How long a
 * link has had is measured from when it arrived, never against the server's
 * clock, so a browser whose date is set wrong renews no sooner and no later;
 * the browser's date counts too, as the page's own clock stops while the
 * device sleeps. When the video fails once its link has run out, it
 * takes a newer link the page already gave or asks the page for one, once, and
 * goes back to where it was, playing if it was. Any other failure says so.
 * Nothing waits on a timer: a refresh that cannot reach the server loads the
 * page afresh, and a link is asked for only once it has run out, minutes after
 * it was signed, so the page never gives the same one back.
 *
 * A link the page gives for any other reason (the page is refreshed after a
 * change elsewhere on it) waits while the member watches, so the video is
 * never restarted under them.
 */
export function VideoPlayer({ source }: { source: VideoPlayerSource }) {
  const router = useRouter();
  const alertId = useId();
  const video = useRef<HTMLVideoElement>(null);
  /** The link the video plays. */
  const [current, setCurrent] = useState<HeldLink>(() => held(source));
  /** A newer link the page gave, waiting while the member watches. */
  const waiting = useRef<HeldLink | null>(null);
  /** Whether the member has played or moved the video: from then on a new link waits until it is needed. */
  const started = useRef(false);
  /**
   * Whether the video was last played rather than paused. Read from the
   * events, not from the video: a browser marks it paused before it reports
   * the failure.
   */
  const playing = useRef(false);
  /** The link a new one was asked of the page for: each link is renewed at most once. */
  const renewedFrom = useRef<string | null>(null);
  /** Where the video was when its link ran out, for the next one to resume from. */
  const resume = useRef<{ time: number; playing: boolean } | null>(null);
  /** The link that failed, so a new link starts without the message. */
  const [failed, setFailed] = useState<string | null>(null);

  function take(link: HeldLink): void {
    waiting.current = null;
    setCurrent(link);
  }

  // A link the page gives later: taken at once unless the member is watching
  // the one before, which it never interrupts.
  useEffect(() => {
    if (source.src === current.src || source.src === waiting.current?.src) return;
    const link = held(source);
    if (renewedFrom.current === current.src || !started.current || failed === current.src) take(link);
    else waiting.current = link;
    // Only a new link is news: `current` and `failed` are read as they are when it arrives.
  }, [source.src]);

  // A failure before the page could listen for it, such as a format the
  // browser cannot play, is reported when it can.
  useEffect(() => {
    if (video.current?.error) onError();
  }, []);

  function onError(): void {
    const element = video.current;
    if (element === null) return;
    // A new link is on its way: the one failing again is the one it replaces.
    if (renewedFrom.current === current.src) return;
    if (!hasRunOut(current)) {
      // Nothing resumes from a failure: a later link starts where the member puts it.
      resume.current = null;
      setFailed(current.src);
      return;
    }
    resume.current = { time: element.currentTime, playing: playing.current };
    const next = waiting.current;
    if (next !== null && !hasRunOut(next)) {
      take(next);
      return;
    }
    renewedFrom.current = current.src;
    router.refresh();
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
        src={current.src}
        controls
        controlsList="nodownload"
        playsInline
        preload="metadata"
        aria-label="The delivered video"
        aria-describedby={failed === current.src ? alertId : undefined}
        onPlay={() => {
          started.current = true;
          playing.current = true;
        }}
        onPause={() => {
          playing.current = false;
        }}
        onSeeked={() => {
          started.current = true;
        }}
        onError={onError}
        onLoadedMetadata={onLoadedMetadata}
      />
      {failed === current.src ? (
        <p id={alertId} role="alert" className="status-bad">
          {PLAYBACK_FAILED}
        </p>
      ) : null}
    </>
  );
}
