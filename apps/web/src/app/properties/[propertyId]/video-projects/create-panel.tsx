"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { mapProjectError } from "@/lib/project-errors";

interface Props {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly cameraMotionOptions: readonly CameraMotionOption[];
  /**
   * The product output targets, resolved by the server page.
   *
   * Passed as plain data for the same reason `cameraMotionOptions` is: this is
   * a Client Component, and importing the domain constant would put domain code
   * — and, through the package index, server-only crypto — in the browser
   * bundle. The server refuses an off-vocabulary value regardless of what this
   * control offers.
   */
  readonly targetOutputResolutionOptions: readonly string[];
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
 * Camera motion stays, but is no longer free text. It is chosen from an approved
 * vocabulary the server enforces; this control offers exactly those values and
 * re-derives nothing. A customer picks the intent, and the system owns every
 * word that reaches a model (ADR-0022).
 */
const OPTIONAL_FIELDS = [
  { key: "prompt", label: "What should the walkthrough feel like? (optional)" },
] as const;

/** One approved camera motion, resolved by the server page. */
export interface CameraMotionOption {
  readonly value: string;
  readonly label: string;
}

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
 * Aspect ratio remains free text. The configured model's real capabilities now
 * exist (ADR-0019) but are enforced at generation admission, on the server,
 * where the authority belongs — this component fetches no capability and
 * re-derives no rule. The placeholder shows the *shape* of the string, not a
 * claim about what any provider accepts.
 *
 * Output resolution is the exception, and for a different reason than
 * capability: it is a **closed product vocabulary**, not a provider value, so
 * the control offers exactly its members and starts unset. It is deliberately
 * not defaulted to one — a pre-selected `1080p` would have the customer
 * "choose" the more expensive deliverable by not looking at the field. The
 * options are derived from the domain constant by the server page, so a new
 * target cannot appear in the product without appearing in this control.
 *
 * The value is a quality class, which is why nothing here says "1920×1080":
 * this service supports several aspect ratios, and whether a model reaches the
 * target natively or by upscaling is a per-model fact the server records at
 * admission.
 */
export function CreateProjectPanel({
  organizationId,
  propertyId,
  cameraMotionOptions,
  targetOutputResolutionOptions,
}: Props) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [duration, setDuration] = useState("");
  const [aspectRatio, setAspectRatio] = useState("");
  // "" is a real state — nothing chosen yet — and it is why the empty option
  // exists rather than a pre-selected default.
  const [targetOutputResolution, setTargetOutputResolution] = useState("");
  const [optional, setOptional] = useState<Record<OptionalKey, string>>({ prompt: "" });
  const [cameraMotion, setCameraMotion] = useState("");
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
    targetOutputResolution !== "";

  async function submit(): Promise<void> {
    setPending(true);
    setError("");
    const body: Record<string, string | number> = {
      organizationId,
      name: name.trim(),
      durationSeconds,
      aspectRatio: aspectRatio.trim(),
      targetOutputResolution,
    };
    for (const { key } of OPTIONAL_FIELDS) {
      const value = optional[key].trim();
      if (value.length > 0) body[key] = value;
    }
    // Omitted entirely when unspecified, so the server stores null rather than
    // an empty string it would then have to interpret.
    if (cameraMotion.length > 0) body.cameraMotion = cameraMotion;

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
        setTargetOutputResolution("");
        setOptional({ prompt: "" });
        setCameraMotion("");
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
      <label className="field">
        <span className="muted">Output resolution</span>
        <select
          value={targetOutputResolution}
          aria-label="Output resolution"
          onChange={(event) =>
            // Checked against the same list the options were built from, so a
            // value this control did not offer cannot reach component state.
            setTargetOutputResolution(
              targetOutputResolutionOptions.find((target) => target === event.target.value) ?? "",
            )
          }
        >
          <option value="">Choose a resolution</option>
          {targetOutputResolutionOptions.map((target) => (
            <option key={target} value={target}>
              {target}
            </option>
          ))}
        </select>
      </label>

      {OPTIONAL_FIELDS.map(({ key, label }) => (
        <Field
          key={key}
          label={label}
          value={optional[key]}
          onChange={(value) => setOptional((prev) => ({ ...prev, [key]: value }))}
        />
      ))}

      <label className="field">
        <span className="muted">Camera motion (optional)</span>
        <select
          value={cameraMotion}
          aria-label="Camera motion (optional)"
          onChange={(event) => setCameraMotion(event.target.value)}
        >
          <option value="">Unspecified</option>
          {cameraMotionOptions.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

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
