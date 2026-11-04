import type { VideoProgressPanel as Panel } from "@/lib/video-progress-view";

const TONES: Record<Panel["tone"], string> = {
  ok: "card status-ok",
  bad: "card status-bad",
  neutral: "card",
};

/**
 * The project's video, as its customer sees it (GS-11b, ADR-0114): where it
 * is, what became of its Units and, for a video that ended without one,
 * ADR-0052's message and whether a new video can be started for the project;
 * always with the reference to quote to support. Nothing here retries the
 * video. A region, not a live one: it is read when the page loads.
 */
export function VideoProgressPanel({ panel }: { panel: Panel }) {
  return (
    <section className={TONES[panel.tone]} aria-labelledby="video-progress-heading">
      <h2 id="video-progress-heading">Video</h2>
      <p>
        <strong>{panel.status}</strong>
        {panel.summary !== null ? <span className="muted"> · {panel.summary}</span> : null}
      </p>
      {panel.notDelivered !== null ? <p lang="ja">{panel.notDelivered}</p> : null}
      {panel.scenes !== null ? <p>{panel.scenes}</p> : null}
      {panel.units !== null ? <p>{panel.units}</p> : null}
      {panel.startAgain !== null ? <p>{panel.startAgain}</p> : null}
      {panel.reload !== null ? <p className="muted">{panel.reload}</p> : null}
      <p className="muted">
        Support reference: <code>{panel.supportReference}</code>
      </p>
    </section>
  );
}
