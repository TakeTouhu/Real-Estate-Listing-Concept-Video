"use client";

import { useCallback, useRef, useState } from "react";

type UploadState = "queued" | "uploading" | "processing" | "done" | "error";

interface UploadItem {
  readonly localId: string;
  readonly filename: string;
  /** The chosen file, kept so Retry can send it again to the same photo. */
  readonly file: File;
  state: UploadState;
  progress: number;
  assetId?: string;
  status?: string;
  message?: string;
}

interface Props {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly remainingSlots: number;
}

/** PUT the file to the signed URL with real progress via XHR. */
function putWithProgress(
  url: string,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed with status ${xhr.status}`));
    });
    xhr.addEventListener("error", () => reject(new Error("Network error during upload")));
    xhr.send(file);
  });
}

export function UploadPanel({ organizationId, propertyId, remainingSlots }: Props) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const patch = useCallback((localId: string, changes: Partial<UploadItem>) => {
    setItems((prev) =>
      prev.map((item) => (item.localId === localId ? { ...item, ...changes } : item)),
    );
  }, []);

  /** Sends the file to the signed URL, then asks the server to check and process the stored bytes. */
  const sendAndComplete = useCallback(
    async (localId: string, assetId: string, uploadUrl: string | null, file: File) => {
      if (uploadUrl !== null) {
        patch(localId, { state: "uploading", progress: 0 });
        await putWithProgress(uploadUrl, file, (fraction) =>
          patch(localId, { progress: Math.round(fraction * 100) }),
        );
      }
      patch(localId, { state: "processing", progress: 100 });
      const completeRes = await fetch(`/api/assets/${assetId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId }),
      });
      const completeJson = await completeRes.json();
      if (!completeRes.ok) throw new Error(completeJson?.error?.message ?? "Processing failed");

      const status = completeJson.status as string;
      patch(localId, {
        state: status === "READY" ? "done" : "error",
        status,
        message: completeJson.failureReason ?? undefined,
      });
    },
    [organizationId, patch],
  );

  /** A failure before the server judged the stored bytes: no status, so Retry sends the file again. */
  const failed = useCallback(
    (localId: string, error: unknown, fallback: string) =>
      patch(localId, {
        state: "error",
        status: undefined,
        message: error instanceof Error ? error.message : fallback,
      }),
    [patch],
  );

  const uploadOne = useCallback(
    async (item: UploadItem) => {
      try {
        patch(item.localId, { state: "uploading", progress: 0 });
        const urlRes = await fetch(`/api/properties/${propertyId}/assets/upload-url`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId, filename: item.file.name, sizeBytes: item.file.size }),
        });
        const urlJson = await urlRes.json();
        if (!urlRes.ok) throw new Error(urlJson?.error?.message ?? "Could not start upload");

        const assetId = urlJson.assetId as string;
        patch(item.localId, { assetId });
        await sendAndComplete(item.localId, assetId, urlJson.uploadUrl as string, item.file);
      } catch (error) {
        failed(item.localId, error, "Upload failed");
      }
    },
    [organizationId, propertyId, patch, sendAndComplete, failed],
  );

  const addFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const selected = Array.from(files).slice(0, Math.max(remainingSlots, 0));
      const created = selected.map((file, index) => ({
        localId: `${Date.now()}-${index}-${file.name}`,
        filename: file.name,
        file,
        state: "queued" as UploadState,
        progress: 0,
      }));
      setItems((prev) => [...prev, ...created]);
      created.forEach((item) => void uploadOne(item));
    },
    [remainingSlots, uploadOne],
  );

  /**
   * Tries the same photo again, never a new one. A photo the server failed
   * after storing its bytes is checked again from those bytes; one whose bytes
   * never arrived is given a new upload link for the same photo and sent the
   * kept file. The server refuses a failed photo where the Property has no
   * place left for it (ADR-0165).
   */
  const retry = useCallback(
    async (item: UploadItem) => {
      const assetId = item.assetId;
      if (!assetId) return;
      patch(item.localId, { state: "queued", message: undefined, progress: 0 });
      try {
        let uploadUrl: string | null = null;
        if (item.status !== "FAILED") {
          const res = await fetch(`/api/assets/${assetId}/retry`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ organizationId }),
          });
          const json = await res.json();
          if (!res.ok) throw new Error(json?.error?.message ?? "Retry failed");
          uploadUrl = json.uploadUrl as string;
        }
        await sendAndComplete(item.localId, assetId, uploadUrl, item.file);
      } catch (error) {
        failed(item.localId, error, "Retry failed");
      }
    },
    [organizationId, patch, sendAndComplete, failed],
  );

  return (
    <div className="card">
      <h2>Upload photos</h2>
      <p className="muted">
        JPEG, PNG, or WebP. Up to {remainingSlots} more photo{remainingSlots === 1 ? "" : "s"} for
        this property. You must own or have licensed every photo you upload.
      </p>

      <div
        className={dragging ? "dropzone dragging" : "dropzone"}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          addFiles(event.dataTransfer.files);
        }}
      >
        <p>Drag photos here, or</p>
        <button type="button" onClick={() => inputRef.current?.click()} disabled={remainingSlots <= 0}>
          Choose files
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          hidden
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>

      {items.length > 0 ? (
        <ul className="upload-list">
          {items.map((item) => (
            <li key={item.localId}>
              <div className="upload-row">
                <span className="upload-name">{item.filename}</span>
                <span className={item.state === "error" ? "status-bad" : "muted"}>
                  {item.state === "uploading"
                    ? `${item.progress}%`
                    : item.state === "processing"
                      ? "processing…"
                      : item.state === "done"
                        ? "ready"
                        : item.state === "error"
                          ? (item.status ?? "failed")
                          : "queued"}
                </span>
              </div>
              <progress max={100} value={item.state === "done" ? 100 : item.progress} />
              {item.message ? <p className="status-bad">{item.message}</p> : null}
              {/* A quarantined or rejected photo is final: the server refuses to try it again. */}
              {item.state === "error" && item.assetId && (item.status === undefined || item.status === "FAILED") ? (
                <button type="button" onClick={() => void retry(item)}>
                  Retry upload
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
