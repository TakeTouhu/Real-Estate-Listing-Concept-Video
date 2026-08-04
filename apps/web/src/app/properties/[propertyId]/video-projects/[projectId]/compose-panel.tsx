"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { mapComposeError } from "@/lib/project-errors";

interface Props {
  readonly organizationId: string;
  readonly projectId: string;
  /** Whether a storyboard already exists, which decides the button's wording. */
  readonly hasScenes: boolean;
}

/** Shape only: a whole number above zero, as the compose route requires. */
function positiveInteger(raw: string): number | null {
  if (raw.trim().length === 0) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Compose — or recompose — this project's storyboard.
 *
 * Mounted only for members the server says may write. The API remains the
 * security boundary; nothing here re-derives authorization.
 *
 * Recomposition uses the **same** endpoint as the first composition: `POST
 * …/storyboard` replaces the storyboard from the current approved photos, so
 * there is no separate recompose call and none is needed.
 *
 * The two bounds set how long each photo is held on screen. They have **no
 * default**: no provider-derived value exists yet, and a prefilled number would
 * function as a provisional capability assumption however it were labelled.
 * Phase 4 replaces this input with the configured provider's real capabilities
 * before any provider call (`docs/decisions/TODO.md`). Whether a requested total
 * actually fits the approved photos is the domain's call and arrives as a `422`.
 */
export function ComposePanel({ organizationId, projectId, hasScenes }: Props) {
  const router = useRouter();
  const [minSeconds, setMinSeconds] = useState("");
  const [maxSeconds, setMaxSeconds] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const min = positiveInteger(minSeconds);
  const max = positiveInteger(maxSeconds);

  async function compose(): Promise<void> {
    if (min === null || max === null) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/video-projects/${projectId}/storyboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          minSceneSeconds: min,
          maxSceneSeconds: max,
        }),
      });
      if (response.ok) {
        // Re-render from the database: composition changes the scenes, the
        // project's status, and its freshness all at once, and the server is
        // authoritative about every one of them.
        router.refresh();
        return;
      }
      setError(mapComposeError(response.status, await messageOf(response)));
    } catch {
      setError(mapComposeError(null, null));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="card">
      <h2>{hasScenes ? "Compose again" : "Compose the storyboard"}</h2>
      <p className="muted">
        Scene pacing: the shortest and longest time any single photo is held on screen. The
        storyboard is built only from photos a person has approved.
      </p>

      <label className="field">
        <span className="muted">Shortest scene, in seconds</span>
        <input
          type="text"
          inputMode="numeric"
          value={minSeconds}
          aria-label="Shortest scene, in seconds"
          onChange={(event) => setMinSeconds(event.target.value)}
        />
      </label>
      <label className="field">
        <span className="muted">Longest scene, in seconds</span>
        <input
          type="text"
          inputMode="numeric"
          value={maxSeconds}
          aria-label="Longest scene, in seconds"
          onChange={(event) => setMaxSeconds(event.target.value)}
        />
      </label>

      <button
        type="button"
        disabled={min === null || max === null || pending}
        onClick={() => void compose()}
      >
        {hasScenes ? "Compose again" : "Compose storyboard"}
      </button>
      {pending ? <span className="muted"> Composing…</span> : null}
      {error ? <p className="status-bad">{error}</p> : null}
    </div>
  );
}

/** The envelope's message, or null when the body is missing or not JSON. */
async function messageOf(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    const message = (body as { error?: { message?: unknown } }).error?.message;
    return typeof message === "string" && message.length > 0 ? message : null;
  } catch {
    return null;
  }
}
