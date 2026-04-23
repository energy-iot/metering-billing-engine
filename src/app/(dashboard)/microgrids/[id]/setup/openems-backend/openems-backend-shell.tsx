"use client";

// OpenemsBackendShell — client shell for the OpenEMS Backend setup tab (#102).
//
// Owns:
//   - mode state (empty | configured | editing)
//   - form state (type + fields)
//   - Save & test promise + result banner state
//   - Test-again promise
//   - typed-confirm dialog state (closed-period bypass)
//
// Data flow:
//   Server component passes (microgrid, health, counts, secretLast4, isSuperAdmin).
//   On Save/Test/Dialog-confirm success → router.refresh() so the server
//   component re-fetches health + counts.

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatusChip } from "@/components/ui/status-chip";
import { Banner } from "@/components/ui/banner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LocalDate } from "@/components/format/local-date";
import type { OpenemsBackendHealth } from "./health";

type MicrogridProps = {
  id: string;
  name: string;
  ems_type: "cloud_aws" | "direct_url" | null;
  ems_backend_url: string | null;
  ems_aws_region: string | null;
  ems_aws_access_key_id: string | null;
  ems_last_discover_at: string | null;
  ems_last_discover_status: string | null;
  ems_last_discover_error: string | null;
  ems_last_discover_count: number | null;
};

export type OpenemsBackendShellProps = {
  microgrid: MicrogridProps;
  health: OpenemsBackendHealth;
  draftPeriodsCount: number;
  closedPeriodsCount: number;
  secretLast4: string | null;
  isSuperAdmin: boolean;
};

type FormType = "cloud_aws" | "direct_url";

type SaveOutcome =
  | { kind: "success"; edgeCount: number; message: string }
  | { kind: "zero_edges"; message: string }
  | { kind: "auth_failed"; message: string }
  | { kind: "unreachable"; message: string }
  | { kind: "unknown_error"; message: string }
  | { kind: "permission_denied"; message: string }
  | { kind: "generic_error"; message: string };

const AWS_REGIONS = [
  "us-east-1",
  "us-west-2",
  "eu-west-1",
  "ap-southeast-1",
] as const;

export function OpenemsBackendShell(props: OpenemsBackendShellProps) {
  const {
    microgrid,
    health,
    draftPeriodsCount,
    closedPeriodsCount,
    secretLast4,
    isSuperAdmin,
  } = props;

  const router = useRouter();

  // Mode: "empty" if not configured, else "configured". Editing overlays.
  // The mode is derived from server-fetched props and never toggled at runtime;
  // any transition (Save success) flows through router.refresh() which re-
  // renders the server component. We memoize via useState purely to stabilize
  // the value across renders of children that might (in a follow-up) rely on
  // referential equality.
  const initialMode: "empty" | "configured" =
    microgrid.ems_type == null ? "empty" : "configured";
  const [mode] = React.useState<"empty" | "configured">(initialMode);
  const [isEditing, setIsEditing] = React.useState(false);

  // Form state — initialize from the saved microgrid record when editing.
  const [formType, setFormType] = React.useState<FormType | null>(
    microgrid.ems_type
  );
  const [backendUrl, setBackendUrl] = React.useState<string>(
    microgrid.ems_backend_url ?? ""
  );
  const [region, setRegion] = React.useState<string>(
    microgrid.ems_aws_region ?? "us-east-1"
  );
  const [accessKeyId, setAccessKeyId] = React.useState<string>(
    microgrid.ems_aws_access_key_id ?? ""
  );
  const [secretAccessKey, setSecretAccessKey] = React.useState<string>("");

  // Mid-period guard banner visibility (derived from draftPeriodsCount +
  // "user clicked Reconfigure"). Distinct from the form-visible flag so
  // that dismissing the banner never opens the form; the user must click
  // Reconfigure again after resolving the draft.
  const [showMidPeriodBanner, setShowMidPeriodBanner] = React.useState(false);

  // Save & test outcome (null = no submit since last edit).
  const [outcome, setOutcome] = React.useState<SaveOutcome | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [testingAgain, setTestingAgain] = React.useState(false);

  // Type-to-confirm dialog (closed-period bypass).
  const [typedConfirmOpen, setTypedConfirmOpen] = React.useState(false);
  const [pendingPayload, setPendingPayload] =
    React.useState<Record<string, unknown> | null>(null);

  const putUrl = `/api/microgrids/${microgrid.id}/openems-backend`;
  const discoverUrl = `/api/microgrids/${microgrid.id}/openems-backend/discover`;

  // ── Reconfigure click flow ─────────────────────────────────────────────
  function handleReconfigureClick() {
    setOutcome(null);
    setShowMidPeriodBanner(false);
    if (draftPeriodsCount > 0) {
      setShowMidPeriodBanner(true);
      return;
    }
    // Initialize form from the current config. Secret is intentionally blank.
    setFormType(microgrid.ems_type);
    setBackendUrl(microgrid.ems_backend_url ?? "");
    setRegion(microgrid.ems_aws_region ?? "us-east-1");
    setAccessKeyId(microgrid.ems_aws_access_key_id ?? "");
    setSecretAccessKey("");
    setIsEditing(true);
  }

  function handleCancel() {
    setIsEditing(false);
    setOutcome(null);
    setShowMidPeriodBanner(false);
    if (initialMode === "empty") {
      setFormType(null);
    }
  }

  // ── Build PUT payload from form state ──────────────────────────────────
  function buildPayload(): Record<string, unknown> | null {
    if (!formType) return null;
    if (formType === "direct_url") {
      return { type: "direct_url", backendUrl };
    }
    const base: Record<string, unknown> = {
      type: "cloud_aws",
      backendUrl,
      region,
      accessKeyId,
    };
    // Only include secretAccessKey when the user actually typed one — an empty
    // string signals "preserve the existing secret" to the server (#102
    // AC-SECRET-PRESERVE, enforced by the PUT handler).
    if (secretAccessKey && secretAccessKey.length > 0) {
      base.secretAccessKey = secretAccessKey;
    }
    return base;
  }

  async function submit(payload: Record<string, unknown>) {
    setSaving(true);
    setOutcome(null);
    try {
      const res = await fetch(putUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as Record<string, unknown>;

      if (res.status === 409) {
        // Branch (a) draft exists, or branch (b) requires_typed_confirmation.
        if (
          typeof json.requires_typed_confirmation === "object" &&
          json.requires_typed_confirmation !== null
        ) {
          setPendingPayload(payload);
          setTypedConfirmOpen(true);
          return;
        }
        // Draft-exists 409 (stale cache — server wins). Render mid-period banner.
        setShowMidPeriodBanner(true);
        setIsEditing(false);
        return;
      }

      if (res.status === 403) {
        setOutcome({
          kind: "permission_denied",
          message:
            (typeof json.error === "string"
              ? json.error
              : "") ||
            "You do not have permission to configure this microgrid.",
        });
        return;
      }

      if (res.status === 400) {
        setOutcome({
          kind: "generic_error",
          message:
            (typeof json.error === "string"
              ? json.error
              : "") || "The request was rejected.",
        });
        return;
      }

      if (!res.ok) {
        setOutcome({
          kind: "generic_error",
          message:
            (typeof json.error === "string"
              ? json.error
              : "") || "Something went wrong saving the configuration.",
        });
        return;
      }

      const status = typeof json.status === "string" ? json.status : "unknown";
      const message = typeof json.message === "string" ? json.message : "";
      const edgeCount =
        typeof json.edgeCount === "number" ? json.edgeCount : 0;

      if (status === "success") {
        setOutcome({ kind: "success", edgeCount, message });
        // Collapse back to summary after 1.5s.
        setTimeout(() => {
          setIsEditing(false);
          router.refresh();
        }, 1500);
        return;
      }
      if (status === "zero_edges") {
        setOutcome({ kind: "zero_edges", message });
        router.refresh();
        return;
      }
      if (status === "auth_failed") {
        setOutcome({ kind: "auth_failed", message });
        return;
      }
      if (status === "unreachable") {
        setOutcome({ kind: "unreachable", message });
        return;
      }
      setOutcome({ kind: "unknown_error", message });
    } catch {
      setOutcome({
        kind: "generic_error",
        message: "Network error — please try again.",
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload = buildPayload();
    if (!payload) return;
    await submit(payload);
  }

  async function handleTypedConfirm(): Promise<void> {
    if (!pendingPayload) return;
    // The ConfirmDialog's typed-input value lives inside the dialog; we'd
    // normally pass it back through the onConfirm callback. We use the
    // expected microgrid name because the dialog only fires onConfirm when
    // the typed input MATCHES expected — so at this point the typed value
    // IS the microgrid name.
    const retry = {
      ...pendingPayload,
      confirmed_name: microgrid.name,
    };
    const res = await fetch(putUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(retry),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const msg =
        (typeof json.error === "string" && json.error) ||
        "The request was rejected.";
      // Dialog stays open on throw.
      throw new Error(msg);
    }
    // Success path — fold back into the main outcome banner.
    const status = typeof json.status === "string" ? json.status : "unknown";
    const message = typeof json.message === "string" ? json.message : "";
    const edgeCount = typeof json.edgeCount === "number" ? json.edgeCount : 0;
    if (status === "success") {
      setOutcome({ kind: "success", edgeCount, message });
      setTimeout(() => {
        setIsEditing(false);
        router.refresh();
      }, 1500);
    } else if (status === "zero_edges") {
      setOutcome({ kind: "zero_edges", message });
      router.refresh();
    } else if (status === "auth_failed") {
      setOutcome({ kind: "auth_failed", message });
    } else if (status === "unreachable") {
      setOutcome({ kind: "unreachable", message });
    } else {
      setOutcome({ kind: "unknown_error", message });
    }
    setTypedConfirmOpen(false);
    setPendingPayload(null);
  }

  async function handleTestAgain() {
    setTestingAgain(true);
    setOutcome(null);
    try {
      const res = await fetch(discoverUrl, { method: "POST" });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        const msg =
          (typeof json.error === "string" && json.error) ||
          "Test failed. See server logs.";
        setOutcome({ kind: "generic_error", message: msg });
        return;
      }
      const status = typeof json.status === "string" ? json.status : "unknown";
      const message = typeof json.message === "string" ? json.message : "";
      const edgeCount = Array.isArray(json.edges) ? json.edges.length : 0;
      if (status === "success")
        setOutcome({ kind: "success", edgeCount, message });
      else if (status === "zero_edges")
        setOutcome({ kind: "zero_edges", message });
      else if (status === "auth_failed")
        setOutcome({ kind: "auth_failed", message });
      else if (status === "unreachable")
        setOutcome({ kind: "unreachable", message });
      else setOutcome({ kind: "unknown_error", message });
      router.refresh();
    } catch {
      setOutcome({
        kind: "generic_error",
        message: "Network error — please try again.",
      });
    } finally {
      setTestingAgain(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────

  const header = (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        OpenEMS Backend
      </p>
      <h3 className="text-lg font-semibold text-foreground">
        Connect this microgrid to OpenEMS
      </h3>
    </div>
  );

  // Empty state
  if (mode === "empty" && !isEditing) {
    if (!isSuperAdmin) {
      return (
        <div className="space-y-4">
          {header}
          <Banner tone="info" title="Not connected yet">
            This microgrid hasn&apos;t been connected to OpenEMS yet. Ask a
            super admin to configure it.
          </Banner>
        </div>
      );
    }
    return (
      <div className="space-y-4">
        {header}
        <div className="mx-auto max-w-[560px] rounded-md border border-border bg-card p-6 shadow-elev-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Connection
          </p>
          <h4 className="mt-1 text-lg font-semibold text-foreground">
            Connect OpenEMS
          </h4>
          <p className="mt-2 text-sm text-muted-foreground">
            Connect this microgrid to its OpenEMS backend. MBE pulls meter
            data from OpenEMS. Choose how to connect:
          </p>
          <div className="mt-4 inline-flex gap-2 rounded-md bg-muted p-1" role="group" aria-label="Connection type">
            <button
              type="button"
              onClick={() => {
                setFormType("cloud_aws");
                setIsEditing(true);
              }}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-foreground hover:bg-card"
            >
              Cloud (AWS)
            </button>
            <button
              type="button"
              onClick={() => {
                setFormType("direct_url");
                setIsEditing(true);
              }}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-foreground hover:bg-card"
            >
              Direct URL
            </button>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            You can change this later. Changing it requires rediscovering
            devices.
          </p>
        </div>
      </div>
    );
  }

  // Configured summary card (also rendered as a read-only header when editing).
  const summaryCard =
    microgrid.ems_type != null ? (
      <div className="rounded-md border border-border bg-card p-5 shadow-elev-1">
        <div className="grid gap-6 md:grid-cols-2">
          {/* Left column */}
          <div className="space-y-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Connection type
              </p>
              <p className="mt-1 text-sm font-medium text-foreground">
                {microgrid.ems_type === "cloud_aws"
                  ? "Cloud (AWS)"
                  : "Direct URL"}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {microgrid.ems_type === "cloud_aws"
                  ? "Lambda function URL"
                  : "Backend URL"}
              </p>
              <p className="mt-1 break-all font-mono text-xs text-foreground">
                {microgrid.ems_backend_url ?? "—"}
              </p>
            </div>
            {microgrid.ems_type === "cloud_aws" && (
              <>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Region
                  </p>
                  <p className="mt-1 font-mono text-xs text-foreground">
                    {microgrid.ems_aws_region ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Access key ID
                  </p>
                  <p className="mt-1 break-all font-mono text-xs text-foreground">
                    {microgrid.ems_aws_access_key_id ?? "—"}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Secret access key
                  </p>
                  <p className="mt-1 font-mono text-xs text-foreground">
                    {secretLast4 ? `••••••••${secretLast4}` : "—"}
                  </p>
                </div>
              </>
            )}
          </div>

          {/* Right column */}
          <div className="flex flex-col items-start gap-3">
            <StatusChip kind="openemsBackendHealth" status={health} />
            {microgrid.ems_last_discover_at ? (
              <p className="text-xs text-muted-foreground">
                Last successful discovery:{" "}
                <LocalDate value={microgrid.ems_last_discover_at} relative />
                {typeof microgrid.ems_last_discover_count === "number" && (
                  <> · {microgrid.ems_last_discover_count} edge{microgrid.ems_last_discover_count === 1 ? "" : "s"} found</>
                )}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                No discovery has run yet.
              </p>
            )}
            {isSuperAdmin && (
              <button
                type="button"
                onClick={handleTestAgain}
                disabled={testingAgain}
                className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                {testingAgain ? "Testing…" : "Test again"}
              </button>
            )}
          </div>
        </div>

        {isSuperAdmin && !isEditing && (
          <div className="mt-5 flex justify-end">
            <button
              type="button"
              onClick={handleReconfigureClick}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Reconfigure
            </button>
          </div>
        )}
      </div>
    ) : null;

  // Form (visible when editing)
  const form = isEditing && formType ? (
    <form onSubmit={handleSubmit} className="rounded-md border border-border bg-card p-5 shadow-elev-1 space-y-5">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {initialMode === "empty" ? "New connection" : "Reconfigure connection"}
        </p>
        <h4 className="mt-1 text-lg font-semibold text-foreground">
          {formType === "cloud_aws" ? "Cloud (AWS)" : "Direct URL"}
        </h4>
      </div>

      {formType === "cloud_aws" ? (
        <>
          <fieldset className="space-y-3">
            <legend className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Endpoint
            </legend>
            <div>
              <label htmlFor="lambda-url" className="mb-1 block text-xs font-medium text-foreground">
                Lambda function URL
              </label>
              <Input
                id="lambda-url"
                type="url"
                value={backendUrl}
                onChange={(e) => setBackendUrl(e.target.value)}
                placeholder="https://<id>.lambda-url.<region>.on.aws/"
                required
                className="font-mono text-xs"
              />
            </div>
            <div>
              <label htmlFor="aws-region" className="mb-1 block text-xs font-medium text-foreground">
                AWS region
              </label>
              <Select value={region} onValueChange={setRegion}>
                <SelectTrigger id="aws-region">
                  <SelectValue placeholder="us-east-1" />
                </SelectTrigger>
                <SelectContent>
                  {AWS_REGIONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Credentials
            </legend>
            <div>
              <label htmlFor="access-key-id" className="mb-1 block text-xs font-medium text-foreground">
                Access key ID
              </label>
              <Input
                id="access-key-id"
                type="text"
                value={accessKeyId}
                onChange={(e) => setAccessKeyId(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
                className="font-mono text-xs"
              />
            </div>
            <div>
              <label htmlFor="secret-access-key" className="mb-1 block text-xs font-medium text-foreground">
                Secret access key
              </label>
              <Input
                id="secret-access-key"
                type="password"
                value={secretAccessKey}
                onChange={(e) => setSecretAccessKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  initialMode === "configured"
                    ? "Leave blank to keep the current secret"
                    : ""
                }
                className="font-mono text-xs"
              />
              {initialMode === "configured" && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Leave blank to keep the current secret.
                </p>
              )}
            </div>
          </fieldset>
        </>
      ) : (
        <div>
          <label htmlFor="backend-url" className="mb-1 block text-xs font-medium text-foreground">
            Backend URL
          </label>
          <Input
            id="backend-url"
            type="url"
            value={backendUrl}
            onChange={(e) => setBackendUrl(e.target.value)}
            placeholder="http://localhost:8082"
            required
            className="font-mono text-xs"
          />
        </div>
      )}

      {outcome && (
        <OutcomeBanner outcome={outcome} />
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={handleCancel}
          className="rounded-md px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? (
            <>
              <span aria-hidden="true" className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-primary-foreground border-r-transparent" />
              Testing connection…
            </>
          ) : (
            "Save & test connection"
          )}
        </button>
      </div>
    </form>
  ) : null;

  return (
    <div className="space-y-4">
      {header}

      {!isSuperAdmin && mode === "configured" && (
        <Banner tone="info" title="Read-only view">
          Only super admins can update OpenEMS credentials. Contact your
          administrator to request changes.
        </Banner>
      )}

      {summaryCard}

      {showMidPeriodBanner && (
        <Banner
          tone="warn"
          title="There's an open billing period"
          action={
            <Link
              href={`/microgrids/${microgrid.id}/billing`}
              className="text-sm font-medium text-warning-fg underline"
            >
              Open billing periods →
            </Link>
          }
        >
          Close or delete the draft period first — changing the OpenEMS
          backend requires rediscovering devices and would invalidate
          readings from the current period.
        </Banner>
      )}

      {/* In configured mode, surface Test-again outcome above the card so it
          doesn't disappear when the form is hidden. */}
      {!isEditing && outcome && <OutcomeBanner outcome={outcome} />}

      {form}

      <ConfirmDialog
        open={typedConfirmOpen}
        onOpenChange={(next) => {
          setTypedConfirmOpen(next);
          if (!next) setPendingPayload(null);
        }}
        tone="neutral"
        title="Confirm backend change"
        description={`This microgrid has ${closedPeriodsCount} closed billing period${closedPeriodsCount === 1 ? "" : "s"}. Changing the OpenEMS backend may affect historical invoice verification if edge IDs differ after rediscovery.`}
        confirmLabel="Save & test"
        requireTypedConfirmation={{
          label: "Type the microgrid name to confirm",
          expected: microgrid.name,
        }}
        onConfirm={handleTypedConfirm}
      />
    </div>
  );
}

function OutcomeBanner({ outcome }: { outcome: SaveOutcome }) {
  if (outcome.kind === "success") {
    return (
      <Banner tone="success" title="Connected">
        Connected. Found {outcome.edgeCount} edge
        {outcome.edgeCount === 1 ? "" : "s"}.
      </Banner>
    );
  }
  if (outcome.kind === "zero_edges") {
    return (
      <Banner tone="warn" title="Zero edges discovered">
        {outcome.message || "The OpenEMS Backend returned zero edges."}
      </Banner>
    );
  }
  if (outcome.kind === "auth_failed") {
    return (
      <Banner tone="destructive" title="Authentication failed">
        {outcome.message ||
          "Verify your AWS credentials and region (common cause: rotated access key)."}
      </Banner>
    );
  }
  if (outcome.kind === "unreachable") {
    return (
      <Banner tone="destructive" title="Backend unreachable">
        {outcome.message ||
          "Could not reach the OpenEMS Backend. Check the URL and that the host is reachable from Vercel."}
      </Banner>
    );
  }
  if (outcome.kind === "permission_denied") {
    return (
      <Banner tone="destructive" title="Permission denied">
        {outcome.message}
      </Banner>
    );
  }
  return (
    <Banner tone="destructive" title="Something went wrong">
      {outcome.message}
    </Banner>
  );
}
