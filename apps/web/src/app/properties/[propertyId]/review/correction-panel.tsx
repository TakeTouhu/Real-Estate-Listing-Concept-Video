"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { mapCorrectionError } from "@/lib/correction-errors";

/** One selectable room, resolved server-side so no domain code reaches the browser. */
export interface RoomOption {
  readonly value: string;
  readonly label: string;
}

/**
 * One correction field's edit state.
 *
 * `touched` is tracked explicitly rather than inferred from whether the input
 * looks empty. Inference cannot tell "the reviewer never went near this" from
 * "the reviewer deliberately cleared it", and those two must send different
 * things: an omitted key versus `null`.
 */
interface FieldEdit<T> {
  readonly touched: boolean;
  readonly value: T | null;
}

interface Props {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly assetId: string;
  readonly filename: string;
  /** What the analyzer decided, for the reviewer to judge against. */
  readonly analyzerRoomType: string;
  readonly roomTypeOverride: string | null;
  readonly orderOverride: number | null;
  readonly roomOptions: readonly RoomOption[];
  /** Told to the parent so review decisions can be blocked while unsaved. */
  readonly onDirtyChange: (assetId: string, dirty: boolean) => void;
}

/** The explicit "no override" choice. Distinct from every room value. */
const USE_ANALYZER = "";

/**
 * Correct the analyzer's room classification, or set a scene order priority.
 *
 * Saving a correction and deciding the review are **separate writes**, in that
 * order: this panel never approves or rejects, and the decision panel never
 * submits a correction. What it does do is report its dirty state upward, so
 * unsaved edits cannot be silently left behind by an approval that freezes the
 * revision.
 *
 * Each field carries the three states the HTTP contract distinguishes —
 * untouched omits the key, an explicit clear sends `null`, a value sets it —
 * and only touched fields are sent. A field touched and then returned to its
 * stored value stays dirty and is sent: the domain already answers that with
 * correct no-op semantics, and duplicating a stored-value diff here would be
 * client logic pretending to be a business rule.
 */
export function CorrectionPanel({
  organizationId,
  propertyId,
  assetId,
  filename,
  analyzerRoomType,
  roomTypeOverride,
  orderOverride,
  roomOptions,
  onDirtyChange,
}: Props) {
  const router = useRouter();
  const [room, setRoom] = useState<FieldEdit<string>>({
    touched: false,
    value: roomTypeOverride,
  });
  const [order, setOrder] = useState<FieldEdit<string>>({
    touched: false,
    value: orderOverride === null ? null : String(orderOverride),
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  function touchRoom(next: FieldEdit<string>): void {
    setRoom(next);
    onDirtyChange(assetId, true);
  }

  function touchOrder(next: FieldEdit<string>): void {
    setOrder(next);
    onDirtyChange(assetId, true);
  }

  const dirty = room.touched || order.touched;
  // Usability only: a non-empty priority must look like a whole number above
  // zero before Save is offered. The domain remains authoritative.
  const orderText = order.value ?? "";
  const orderUsable =
    orderText.length === 0 || (Number.isInteger(Number(orderText)) && Number(orderText) > 0);

  async function save(): Promise<void> {
    setPending(true);
    setError("");

    const body: Record<string, unknown> = { organizationId };
    if (room.touched) body.roomType = room.value === null ? null : room.value;
    if (order.touched) body.order = orderText.length === 0 ? null : Number(orderText);

    try {
      const response = await fetch(
        `/api/properties/${propertyId}/assets/${assetId}/analysis/correction`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (response.ok) {
        // Rebuild from the server rather than merging the response here: the
        // effective room, the corrected marker and the decision controls all
        // derive from authoritative state, and the refresh resets dirty state
        // with fresh initial values.
        onDirtyChange(assetId, false);
        router.refresh();
        return;
      }
      // A failed save leaves the edits in place *and* still dirty, so review
      // decisions stay blocked rather than silently unlocking.
      setError(mapCorrectionError(response.status, await messageOf(response)));
    } catch {
      setError(mapCorrectionError(null, null));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="correction-panel">
      <p className="muted">
        Analyzer read this as <strong>{analyzerRoomType}</strong>.
      </p>

      <label className="field">
        <span className="muted">Room</span>
        <select
          value={room.value ?? USE_ANALYZER}
          aria-label={`Room for ${filename}`}
          onChange={(event) =>
            touchRoom({
              touched: true,
              value: event.target.value === USE_ANALYZER ? null : event.target.value,
            })
          }
        >
          <option value={USE_ANALYZER}>Use analyzer result</option>
          {roomOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="muted">Order priority — lower numbers appear earlier</span>
        <input
          type="text"
          inputMode="numeric"
          value={orderText}
          aria-label={`Order priority for ${filename}`}
          onChange={(event) => touchOrder({ touched: true, value: event.target.value })}
        />
      </label>

      <div className="correction-buttons">
        <button
          type="button"
          disabled={!dirty || !orderUsable || pending}
          onClick={() => void save()}
        >
          Save correction
        </button>
        {dirty ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setRoom({ touched: false, value: roomTypeOverride });
              setOrder({
                touched: false,
                value: orderOverride === null ? null : String(orderOverride),
              });
              setError("");
              onDirtyChange(assetId, false);
            }}
          >
            Discard changes
          </button>
        ) : null}
        {pending ? <span className="muted">Saving…</span> : null}
      </div>
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
