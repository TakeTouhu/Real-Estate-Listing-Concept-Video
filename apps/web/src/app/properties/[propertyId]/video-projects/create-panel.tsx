"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { mapProjectError } from "@/lib/project-errors";

interface Props {
  readonly organizationId: string;
  readonly propertyId: string;
}

/**
 * The optional fields, in the order they are shown.
 *
 * There is deliberately no negative-prompt control. The configured production
 * model documents no `negative_prompt` parameter, so a project carrying one is
 * refused at generation admission — offering the field here would invite
 * customers to write a requirement the product cannot honour and then fail them
 * later, at the point they ask for a video (ADR-0019).
 *
 * The HTTP, domain, and database contracts still carry `negativePrompt`: it is
 * provider-neutral, a future model may honour it, and projects created through
 * the API keep failing admission honestly rather than having their text
 * silently dropped.
 *
 * Camera motion stays: it has no dedicated request parameter either, but the
 * model's prompt input carries motion intent, so it is genuinely delivered.
 */
const OPTIONAL_FIELDS = [
  { key: "prompt", label: "What should the walkthrough feel like? (optional)" },
  { key: "cameraMotion", label: "Camera motion (optional)" },
] as const;

type OptionalKey = (typeof OPTIONAL_FIELDS)[number]["key"];

/**
 * Create a video project for this property.
 *
 * Mounted only for members the server says may write, so a reviewer never
 * receives these controls at all rather than disabled ones. The API remains the
 * security boundary; this component re-derives no authorization.
 *
 * Every field maps one-to-one onto `CreateProjectInput`. Nothing about the
 * project's lifecycle is sent — no status, no composition fingerprint, no
 * scenes — because the create endpoint cannot express them and a client must
 * not present a project as already composed.
 *
 * Aspect ratio and resolution remain free text. The configured model's real
 * capabilities now exist (ADR-0019) but are enforced at generation admission,
 * on the server, where the authority belongs — this component fetches no
 * capability and re-derives no rule. The placeholders show the *shape* of the
 * string, not a claim about what any provider accepts.
 */
export function CreateProjectPanel({ organizationId, propertyId }: Props) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [duration, setDuration] = useState("");
  const [aspectRatio, setAspectRatio] = useState("");
  const [resolution, setResolution] = useState("");
  const [optional, setOptional] = useState<Record<OptionalKey, string>>({
    prompt: "",
    cameraMotion: "",
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  // Shape only — a whole number above zero. Whether a duration is *achievable*
  // depends on how many photos are approved and is the domain's call at compose
  // time, so nothing here caps or defaults it.
  const durationSeconds = Number(duration);
  const durationValid =
    duration.trim().length > 0 && Number.isInteger(durationSeconds) && durationSeconds > 0;
  const complete =
    name.trim().length > 0 &&
    durationValid &&
    aspectRatio.trim().length > 0 &&
    resolution.trim().length > 0;

  async function submit(): Promise<void> {
    setPending(true);
    setError("");
    const body: Record<string, string | number> = {
      organizationId,
      name: name.trim(),
      durationSeconds,
      aspectRatio: aspectRatio.trim(),
      resolution: resolution.trim(),
    };
    for (const { key } of OPTIONAL_FIELDS) {
      const value = optional[key].trim();
      if (value.length > 0) body[key] = value;
    }

    try {
      const response = await fetch(`/api/properties/${propertyId}/video-projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.status === 201) {
        // Re-render the server component from the database rather than
        // inserting the new project locally: the server is authoritative about
        // what the list contains, and it already returns it.
        setName("");
        setDuration("");
        setAspectRatio("");
        setResolution("");
        setOptional({ prompt: "", cameraMotion: "" });
        router.refresh();
        return;
      }
      setError(mapProjectError(response.status, await messageOf(response)));
    } catch {
      setError(mapProjectError(null, null));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="card">
      <h2>New video project</h2>
      <p className="muted">
        A project holds the settings for one walkthrough video. You compose its storyboard from the
        photos you have already approved.
      </p>

      <Field label="Project name" value={name} onChange={setName} />
      <label className="field">
        <span className="muted">Target length in seconds</span>
        <input
          type="text"
          inputMode="numeric"
          value={duration}
          aria-label="Target length in seconds"
          onChange={(event) => setDuration(event.target.value)}
        />
      </label>
      <Field
        label="Aspect ratio"
        value={aspectRatio}
        onChange={setAspectRatio}
        placeholder="16:9"
      />
      <Field
        label="Resolution"
        value={resolution}
        onChange={setResolution}
        placeholder="1080p"
      />

      {OPTIONAL_FIELDS.map(({ key, label }) => (
        <Field
          key={key}
          label={label}
          value={optional[key]}
          onChange={(value) => setOptional((prev) => ({ ...prev, [key]: value }))}
        />
      ))}

      <button type="button" disabled={!complete || pending} onClick={() => void submit()}>
        Create project
      </button>
      {pending ? <span className="muted"> Creating…</span> : null}
      {error ? <p className="status-bad">{error}</p> : null}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="field">
      <span className="muted">{label}</span>
      <input
        type="text"
        value={value}
        aria-label={label}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
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
