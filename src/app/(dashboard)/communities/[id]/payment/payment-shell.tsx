"use client";

// PaymentShell — client shell for the community Payment tab (#119).
//
// Owns:
//   - mode state (empty | configured | editing)
//   - form state (consumer_key + consumer_secret + sandbox toggle)
//   - Save & test promise + result banner state
//
// Data flow:
//   Server component passes (community, health, secretLast4, isSuperAdmin).
//   On Save/Test success → router.refresh() so the layout + page re-fetch
//   health + last-configured timestamp.
//
// Mirrors `openems-backend-shell.tsx` pattern; SKIPS the mid-period guard
// and typed-confirm dialog branches per #119 refinement-locked decision E.
//
// Secret handling: the server NEVER ships the plaintext secret to the
// client. The reconfigure form's secret input initializes blank with a
// helper "Leave blank to keep the current secret"; submitting a blank
// secret triggers the PUT route's secret-preserve gate.

import * as React from "react";
import { useRouter } from "next/navigation";
import { StatusChip } from "@/components/ui/status-chip";
import { Banner } from "@/components/ui/banner";
import { Input } from "@/components/ui/input";
import { LocalDate } from "@/components/format/local-date";
import type { PaymentHealth } from "./health";

type CommunityProps = {
  id: string;
  name: string;
  payment_provider: "pesapal" | null;
  payment_last_configured_at: string | null;
  config: {
    consumer_key: string;
    base_url: string;
    sandbox: boolean;
  };
};

export type PaymentShellProps = {
  community: CommunityProps;
  health: PaymentHealth;
  secretLast4: string | null;
  isSuperAdmin: boolean;
};

type SaveOutcome =
  | { kind: "success"; message: string }
  | { kind: "auth_failed"; message: string }
  | { kind: "unreachable"; message: string }
  | { kind: "invalid_config"; message: string }
  | { kind: "permission_denied"; message: string }
  | { kind: "generic_error"; message: string };

export function PaymentShell(props: PaymentShellProps) {
  const { community, health, secretLast4, isSuperAdmin } = props;
  const router = useRouter();

  const initialMode: "empty" | "configured" =
    community.payment_provider == null ? "empty" : "configured";
  const [mode] = React.useState<"empty" | "configured">(initialMode);
  const [isEditing, setIsEditing] = React.useState(false);

  const [consumerKey, setConsumerKey] = React.useState<string>(
    community.config.consumer_key,
  );
  const [consumerSecret, setConsumerSecret] = React.useState<string>("");
  const [sandbox, setSandbox] = React.useState<boolean>(
    community.config.sandbox,
  );

  const [outcome, setOutcome] = React.useState<SaveOutcome | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [testingAgain, setTestingAgain] = React.useState(false);

  const putUrl = `/api/communities/${community.id}/payment`;

  // ── Connect / Reconfigure click flow ───────────────────────────────────
  function handleConnectClick() {
    setOutcome(null);
    setConsumerKey("");
    setConsumerSecret("");
    setSandbox(false);
    setIsEditing(true);
  }

  function handleReconfigureClick() {
    setOutcome(null);
    setConsumerKey(community.config.consumer_key);
    setConsumerSecret(""); // Always blank on Reconfigure — secret-preserve.
    setSandbox(community.config.sandbox);
    setIsEditing(true);
  }

  function handleCancel() {
    setIsEditing(false);
    setOutcome(null);
  }

  // ── Build PUT payload from form state ──────────────────────────────────
  function buildPayload(options: { preserveSecret: boolean }): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      provider: "pesapal",
      config: {
        consumer_key: consumerKey,
        sandbox,
      },
    };
    if (!options.preserveSecret && consumerSecret.length > 0) {
      payload.secret_access_key = consumerSecret;
    }
    return payload;
  }

  async function submit(payload: Record<string, unknown>, kind: "save" | "test") {
    if (kind === "save") setSaving(true);
    else setTestingAgain(true);
    setOutcome(null);
    try {
      const res = await fetch(putUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      if (res.status === 403) {
        setOutcome({
          kind: "permission_denied",
          message:
            (typeof json.error === "string" && json.error) ||
            "You do not have permission to update this payment configuration.",
        });
        return;
      }
      if (res.status === 400) {
        setOutcome({
          kind: "invalid_config",
          message:
            (typeof json.error === "string" && json.error) ||
            "The request was rejected.",
        });
        return;
      }
      if (res.status === 503) {
        const reason =
          typeof json.reason === "string" ? json.reason : "unknown_error";
        if (reason === "auth_failed") {
          setOutcome({
            kind: "auth_failed",
            message:
              (typeof json.error === "string" && json.error) ||
              "Authentication failed. Verify the consumer key and consumer secret on your Pesapal dashboard.",
          });
        } else if (reason === "unreachable") {
          setOutcome({
            kind: "unreachable",
            message:
              (typeof json.error === "string" && json.error) ||
              "Could not reach Pesapal. Check your network and try again.",
          });
        } else {
          setOutcome({
            kind: "generic_error",
            message:
              (typeof json.error === "string" && json.error) ||
              "Pesapal returned an unexpected error. Check server logs.",
          });
        }
        return;
      }
      if (!res.ok) {
        setOutcome({
          kind: "generic_error",
          message:
            (typeof json.error === "string" && json.error) ||
            "Something went wrong saving the configuration.",
        });
        return;
      }

      const message = typeof json.message === "string" ? json.message : "";
      setOutcome({ kind: "success", message: message || "Connected." });

      if (kind === "save") {
        // Collapse back to summary after 1.5s.
        setTimeout(() => {
          setIsEditing(false);
          router.refresh();
        }, 1500);
      } else {
        router.refresh();
      }
    } catch {
      setOutcome({
        kind: "generic_error",
        message: "Network error — please try again.",
      });
    } finally {
      if (kind === "save") setSaving(false);
      else setTestingAgain(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload = buildPayload({ preserveSecret: false });
    await submit(payload, "save");
  }

  async function handleTestAgain() {
    // "Test again" reuses the stored config by sending the same-shape payload
    // with an empty secret → triggers the server's secret-preserve path + a
    // fresh auth validation against Pesapal.
    const payload = {
      provider: "pesapal",
      config: {
        consumer_key: community.config.consumer_key,
        sandbox: community.config.sandbox,
      },
    };
    await submit(payload, "test");
  }

  // ── Render ─────────────────────────────────────────────────────────────
  const header = (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Payment
      </p>
      <h3 className="text-lg font-semibold text-foreground">
        Connect this community to a payment provider
      </h3>
    </div>
  );

  // Empty state
  if (mode === "empty" && !isEditing) {
    if (!isSuperAdmin) {
      return (
        <div className="space-y-4">
          {header}
          <Banner tone="info" title="Not configured yet">
            This community hasn&apos;t been connected to a payment provider yet.
            Ask a super admin to configure it.
          </Banner>
        </div>
      );
    }
    return (
      <div className="space-y-4">
        {header}
        <div className="mx-auto max-w-[560px] rounded-md border border-border bg-card p-6 shadow-elev-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Provider
          </p>
          <h4 className="mt-1 text-lg font-semibold text-foreground">
            Connect Pesapal
          </h4>
          <p className="mt-2 text-sm text-muted-foreground">
            Pesapal handles mobile-money and card collection for households in
            Uganda and Kenya. MBE generates one payment link per billing line
            item and records the redirect URL.
          </p>
          <div className="mt-4">
            <button
              type="button"
              onClick={handleConnectClick}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Connect Pesapal
            </button>
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            More providers (Stripe, Flutterwave, M-Pesa direct) coming soon.
          </p>
        </div>
      </div>
    );
  }

  // Summary card (configured)
  const summaryCard =
    community.payment_provider != null ? (
      <div className="rounded-md border border-border bg-card p-5 shadow-elev-1">
        <div className="grid gap-6 md:grid-cols-2">
          {/* Left column */}
          <div className="space-y-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Provider
              </p>
              <p className="mt-1 text-sm font-medium text-foreground">
                Pesapal
              </p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Environment
              </p>
              <p className="mt-1 text-sm font-medium text-foreground">
                {community.config.sandbox ? "Sandbox" : "Live"}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Consumer key
              </p>
              <p className="mt-1 break-all font-mono text-xs text-foreground">
                {community.config.consumer_key || "—"}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Consumer secret
              </p>
              <p className="mt-1 font-mono text-xs text-foreground">
                {secretLast4 ? `••••••••${secretLast4}` : "—"}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Base URL
              </p>
              <p className="mt-1 break-all font-mono text-xs text-foreground">
                {community.config.base_url || "—"}
              </p>
            </div>
          </div>

          {/* Right column */}
          <div className="flex flex-col items-start gap-3">
            <StatusChip kind="paymentHealth" status={health} />
            {community.payment_last_configured_at ? (
              <p className="text-xs text-muted-foreground">
                Last test:{" "}
                <LocalDate
                  value={community.payment_last_configured_at}
                  relative
                />
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                No Save & test has run yet.
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
  const form = isEditing ? (
    <form
      onSubmit={handleSubmit}
      className="rounded-md border border-border bg-card p-5 shadow-elev-1 space-y-5"
    >
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {initialMode === "empty" ? "New connection" : "Reconfigure connection"}
        </p>
        <h4 className="mt-1 text-lg font-semibold text-foreground">Pesapal</h4>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Credentials
        </legend>
        <div>
          <label
            htmlFor="pesapal-consumer-key"
            className="mb-1 block text-xs font-medium text-foreground"
          >
            Consumer key
          </label>
          <Input
            id="pesapal-consumer-key"
            type="text"
            value={consumerKey}
            onChange={(e) => setConsumerKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
            className="font-mono text-xs"
          />
        </div>
        <div>
          <label
            htmlFor="pesapal-consumer-secret"
            className="mb-1 block text-xs font-medium text-foreground"
          >
            Consumer secret
          </label>
          <Input
            id="pesapal-consumer-secret"
            type="password"
            value={consumerSecret}
            onChange={(e) => setConsumerSecret(e.target.value)}
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

      <div>
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={sandbox}
            onChange={(e) => setSandbox(e.target.checked)}
            className="h-4 w-4 rounded border-border text-primary focus-visible:ring-2 focus-visible:ring-ring"
          />
          <span className="text-xs text-foreground">
            Use sandbox environment
          </span>
        </label>
        <p className="mt-1 text-[11px] text-muted-foreground">
          When enabled, MBE talks to Pesapal&apos;s test environment at{" "}
          <span className="font-mono">cybqa.pesapal.com</span>. Leave unchecked
          for live collections.
        </p>
      </div>

      {outcome && <OutcomeBanner outcome={outcome} />}

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
          aria-busy={saving}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? (
            <>
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-primary-foreground border-r-transparent"
              />
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
          Only super admins can update Payment credentials. Contact your
          administrator to request changes.
        </Banner>
      )}

      {summaryCard}

      {/* In configured mode, surface Test-again outcome above the card so it
          doesn't disappear when the form is hidden. */}
      {!isEditing && outcome && <OutcomeBanner outcome={outcome} />}

      {form}
    </div>
  );
}

function OutcomeBanner({ outcome }: { outcome: SaveOutcome }) {
  if (outcome.kind === "success") {
    return (
      <Banner tone="success" title="Connected">
        {outcome.message || "Connected. Pesapal authentication succeeded."}
      </Banner>
    );
  }
  if (outcome.kind === "auth_failed") {
    return (
      <Banner tone="destructive" title="Authentication failed">
        {outcome.message}
      </Banner>
    );
  }
  if (outcome.kind === "unreachable") {
    return (
      <Banner tone="destructive" title="Pesapal unreachable">
        {outcome.message}
      </Banner>
    );
  }
  if (outcome.kind === "invalid_config") {
    return (
      <Banner tone="warn" title="Invalid configuration">
        {outcome.message}
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
