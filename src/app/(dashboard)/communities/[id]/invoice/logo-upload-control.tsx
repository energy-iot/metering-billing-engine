"use client";

/**
 * logo-upload-control.tsx — Drag-drop / file-picker logo uploader (#204 / PDF2).
 *
 * Drag-drop is implemented with native HTML5 events (`onDragOver`, `onDrop`)
 * — NO library. The fallback file picker is a hidden `<input type="file">`
 * triggered by clicking (or pressing Enter/Space on) the dropzone.
 *
 * Client-side validation (defense-in-depth — the server also re-validates):
 *   - MIME: image/png, image/jpeg, image/svg+xml.
 *   - Size: ≤ 500 KB (the bucket caps at 1 MiB; 500 KB keeps deploy/preview
 *     bundles small).
 *
 * Preview: `URL.createObjectURL()` blob URI rendered inline before the
 * upload click. We revoke the blob URL on unmount and on successful upload.
 *
 * In-flight guard: the Upload button disables while a previous request is
 * pending — prevents double-fire orphans in storage.
 *
 * A11y: dropzone is `tabIndex={0}` with Enter/Space triggering the file
 * picker (mirroring click). Mouse-only dropzones are an a11y bug.
 */

import * as React from "react";
import { Banner } from "@/components/ui/banner";
import { cn } from "@/lib/utils";

const ACCEPTED_MIME = "image/png,image/jpeg,image/svg+xml";
const ALLOWED_MIME_SET = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/svg+xml",
]);

const CLIENT_MAX_BYTES = 500 * 1024; // 500 KB.

export type LogoUploadResult = {
  logo_storage_path: string;
  signed_thumbnail_url: string;
};

export type LogoUploadControlProps = {
  communityId: string;
  /** Current persisted-or-staged logo path (drives the "Remove" button). */
  currentLogoPath: string | null;
  /** Signed URL to render the persisted thumbnail, when available. */
  currentSignedThumbnailUrl: string | null;
  /** Called after a successful upload so the form-state path can be staged. */
  onUploaded: (result: LogoUploadResult) => void;
  /** Clears the form-state path; does NOT delete the storage object. */
  onRemove: () => void;
};

export function LogoUploadControl({
  communityId,
  currentLogoPath,
  currentSignedThumbnailUrl,
  onUploaded,
  onRemove,
}: LogoUploadControlProps) {
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [draftFile, setDraftFile] = React.useState<File | null>(null);
  const [draftPreviewUrl, setDraftPreviewUrl] = React.useState<string | null>(
    null,
  );
  const [isDragging, setIsDragging] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Revoke the blob URL on unmount or when replaced — prevents leak.
  React.useEffect(() => {
    return () => {
      if (draftPreviewUrl) URL.revokeObjectURL(draftPreviewUrl);
    };
  }, [draftPreviewUrl]);

  function clearDraft() {
    if (draftPreviewUrl) URL.revokeObjectURL(draftPreviewUrl);
    setDraftFile(null);
    setDraftPreviewUrl(null);
  }

  function handleSelect(file: File) {
    setError(null);
    if (!ALLOWED_MIME_SET.has(file.type)) {
      setError("Unsupported file type. Use PNG, JPG, or SVG.");
      return;
    }
    if (file.size > CLIENT_MAX_BYTES) {
      setError(
        `File is too large (${Math.round(file.size / 1024)} KB). Maximum 500 KB.`,
      );
      return;
    }
    if (draftPreviewUrl) URL.revokeObjectURL(draftPreviewUrl);
    setDraftFile(file);
    setDraftPreviewUrl(URL.createObjectURL(file));
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleSelect(file);
    // Reset the input so the same filename can be re-selected.
    e.target.value = "";
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleSelect(file);
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(true);
  }

  function handleDragLeave() {
    setIsDragging(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInputRef.current?.click();
    }
  }

  async function handleUpload() {
    if (!draftFile) return;
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", draftFile);
      const res = await fetch(`/api/communities/${communityId}/invoice-logo`, {
        method: "POST",
        body: fd,
      });
      const json = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!res.ok) {
        setError(
          (typeof json.error === "string" && json.error) ||
            "Upload failed. Try again.",
        );
        return;
      }
      const path = typeof json.logo_storage_path === "string"
        ? json.logo_storage_path
        : "";
      const signedUrl = typeof json.signed_thumbnail_url === "string"
        ? json.signed_thumbnail_url
        : "";
      if (!path) {
        setError("Upload returned no storage path. Try again.");
        return;
      }
      onUploaded({ logo_storage_path: path, signed_thumbnail_url: signedUrl });
      clearDraft();
    } catch {
      setError("Network error during upload. Try again.");
    } finally {
      setUploading(false);
    }
  }

  const persistedThumbnailSrc =
    !draftPreviewUrl && currentSignedThumbnailUrl
      ? currentSignedThumbnailUrl
      : null;

  return (
    <div className="space-y-3">
      <div
        role="button"
        tabIndex={0}
        aria-label="Drop a logo file here, or press Enter to browse"
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={handleKeyDown}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed bg-card p-6 text-center transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isDragging
            ? "border-primary bg-muted"
            : "border-border hover:bg-muted",
        )}
      >
        {draftPreviewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={draftPreviewUrl}
            alt="Logo preview"
            className="max-h-24 max-w-full object-contain"
          />
        ) : persistedThumbnailSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={persistedThumbnailSrc}
            alt="Current logo"
            className="max-h-24 max-w-full object-contain"
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            Drag a logo here or click to browse (PNG, JPG, SVG, up to 500 KB)
          </p>
        )}
        {(draftPreviewUrl || persistedThumbnailSrc) && (
          <p className="text-[11px] text-muted-foreground">
            {draftPreviewUrl
              ? `Selected: ${draftFile?.name ?? "file"} — click Upload to save`
              : currentLogoPath
                ? "Current logo (signed URL — refreshes on next save)"
                : ""}
          </p>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_MIME}
          onChange={handleFileInput}
          className="sr-only"
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>

      {error && (
        <Banner tone="destructive" title="Upload error">
          {error}
        </Banner>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleUpload}
          disabled={!draftFile || uploading}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {uploading ? "Uploading…" : "Upload"}
        </button>
        {draftFile && !uploading && (
          <button
            type="button"
            onClick={clearDraft}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
          >
            Cancel selection
          </button>
        )}
        {currentLogoPath && !draftFile && (
          <button
            type="button"
            onClick={onRemove}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-destructive-fg hover:bg-destructive-muted"
          >
            Remove logo
          </button>
        )}
      </div>
    </div>
  );
}
