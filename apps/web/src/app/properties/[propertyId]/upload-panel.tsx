"use client";

import { useCallback, useRef, useState } from "react";

type UploadState = "queued" | "uploading" | "processing" | "done" | "error";

interface UploadItem {
  readonly localId: string;
  readonly filename: string;
  state: UploadState;
  progress: number;
  assetId?: string;
  status?: string;
  message?: string;
  duplicateOf?: string[];
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

  const uploadOne = useCallback(
    async (item: UploadItem, file: File) => {
      try {
        patch(item.localId, { state: "uploading", progress: 0 });
        const urlRes = await fetch(`/api/properties/${propertyId}/assets/upload-url`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId, filename: file.name, sizeBytes: file.size }),
        });
        const urlJson = await urlRes.json();
        if (!urlRes.ok) throw new Error(urlJson?.error?.message ?? "Could not start upload");

        const assetId = urlJson.assetId as string;
        patch(item.localId, { assetId });
        await putWithProgress(urlJson.uploadUrl as string, file, (fraction) =>
          patch(item.localId, { progress: Math.round(fraction * 100) }),
        );

        patch(item.localId, { state: "processing", progress: 100 });
        const completeRes = await fetch(`/api/assets/${assetId}/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId }),
        });
        const completeJson = await completeRes.json();
        if (!completeRes.ok) throw new Error(completeJson?.error?.message ?? "Processing failed");

        const status = completeJson.status as string;
        patch(item.localId, {
          state: status === "READY" ? "done" : "error",
          status,
          message: completeJson.failureReason ?? undefined,
          duplicateOf: completeJson.duplicateOf ?? [],
        });
      } catch (error) {
        patch(item.localId, {
          state: "error",
          message: error instanceof Error ? error.message : "Upload failed",
        });
      }
    },
    [organizationId, propertyId, patch],
  );

  const addFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const selected = Array.from(files).slice(0, Math.max(remainingSlots, 0));
      const created = selected.map((file, index) => ({
        localId: `${Date.now()}-${index}-${file.name}`,
        filename: file.name,
        state: "queued" as UploadState,
        progress: 0,
      }));
      setItems((prev) => [...prev, ...created]);
      created.forEach((item, index) => void uploadOne(item, selected[index]!));
    },
    [remainingSlots, uploadOne],
  );

  const retry = useCallback(
    async (item: UploadItem) => {
      if (!item.assetId) return;
      patch(item.localId, { state: "queued", message: undefined, progress: 0 });
      try {
        const res = await fetch(`/api/assets/${item.assetId}/retry`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ organizationId }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error?.message ?? "Retry failed");
        patch(item.localId, {
          message: "Ready to retry — choose the file again to re-upload.",
          state: "error",
        });
      } catch (error) {
        patch(item.localId, {
          state: "error",
          message: error instanceof Error ? error.message : "Retry failed",
        });
      }
    },
    [organizationId, patch],
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
              {item.duplicateOf && item.duplicateOf.length > 0 ? (
                <p className="muted">Looks similar to {item.duplicateOf.length} existing photo(s).</p>
              ) : null}
              {item.state === "error" && item.assetId ? (
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
