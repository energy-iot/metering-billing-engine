"use client";

/**
 * PreflightPanel — pre-flight panel for "Generate all" (BC3 #175 AC5).
 *
 * Renders inline under the period header, between the action buttons and
 * the CopyTable (or empty-state). NOT a modal.
 *
 * Three sections:
 *   1. "Ready (edge data)" — collapsed by default; lists households whose
 *      `edgeAvailable` is true and have not been override-toggled to manual.
 *   2. "Needs manual entry" — expanded by default; lists households with
 *      `edgeAvailable === false`. Each row has start/end kWh inputs and an
 *      optional reason textarea.
 *   3. "Override available" — collapsed disclosure; lists edge-available
 *      households with a per-row toggle. Toggling expands inline kWh inputs.
 *
 * The Generate button is DISABLED until every needs-manual row AND every
 * toggled-override row has both start_kwh + end_kwh filled with valid
 * non-negative numbers AND endKwh >= startKwh (Q1=A, no skip-and-continue).
 *
 * On submit: single POST /api/billing/generate with the manualReadings
 * array and NO householdIds filter (the implicit-add semantic in
 * runGenerationFor processes everything).
 *
 * View-state machine (BC3 polish #182):
 *   - `view === 'form'`   → render the form section (default).
 *   - `view === 'result'` → render a result section showing per-household
 *     failures + a Close button. Switched into when the response has
 *     errors.length > 0 (partial OR full failure). Per AC2 the panel is
 *     NOT a Radix dialog — view-state mutation is applied to the inline
 *     <section> markup directly. The all-success branch still calls
 *     `onClose()` (existing behavior preserved).
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Banner } from "@/components/ui/banner";
import { StatusChip } from "@/components/ui/status-chip";
import {
  errorCodeCopy,
  type PartialFailureError,
} from "@/components/billing/error-code-copy";
import type { Household } from "@/lib/types/domain";

export interface PreflightPanelProps {
  open: boolean;
  onClose: () => void;
  billingPeriodId: string;
  households: Household[];
  /** Whether each household has a primary_consumption_meter on a configured edge. */
  edgeAvailableByHouseholdId: Record<string, boolean>;
}

interface RowFormState {
  startKwh: string;
  endKwh: string;
  reason: string;
  /** Only relevant for the override section. */
  overrideEnabled: boolean;
}

interface ResultState {
  errors: PartialFailureError[];
  successCount: number;
  attemptedCount: number;
}

const EMPTY_ROW: RowFormState = {
  startKwh: "",
  endKwh: "",
  reason: "",
  overrideEnabled: false,
};

const MAX_FAILURES_INLINE = 5;

function parseField(raw: string): { ok: true; value: number } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { ok: false };
  if (n < 0) return { ok: false };
  return { ok: true, value: n };
}

export function PreflightPanel(props: PreflightPanelProps) {
  const {
    open,
    onClose,
    billingPeriodId,
    households,
    edgeAvailableByHouseholdId,
  } = props;
  const router = useRouter();

  // Per-household form state. Keyed by household id.
  const [forms, setForms] = React.useState<Record<string, RowFormState>>({});
  const [submitting, setSubmitting] = React.useState(false);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [readyExpanded, setReadyExpanded] = React.useState(false);
  const [overrideExpanded, setOverrideExpanded] = React.useState(false);
  const [view, setView] = React.useState<"form" | "result">("form");
  const [result, setResult] = React.useState<ResultState | null>(null);

  // Reset state when the panel opens.
  React.useEffect(() => {
    if (open) {
      setForms({});
      setSubmitting(false);
      setErrorMsg(null);
      setReadyExpanded(false);
      setOverrideExpanded(false);
      setView("form");
      setResult(null);
    }
  }, [open]);

  if (!open) return null;

  function getRow(hid: string): RowFormState {
    return forms[hid] ?? EMPTY_ROW;
  }
  function setRow(hid: string, partial: Partial<RowFormState>) {
    setForms((prev) => ({
      ...prev,
      [hid]: { ...(prev[hid] ?? EMPTY_ROW), ...partial },
    }));
  }

  // Partition households by edge availability.
  const needsManual = households.filter(
    (h) => edgeAvailableByHouseholdId[h.id] === false,
  );
  const edgeReady = households.filter(
    (h) => edgeAvailableByHouseholdId[h.id] !== false,
  );

  // Validation — needs-manual + override-toggled rows must all be valid.
  const overrideRows = edgeReady.filter((h) => getRow(h.id).overrideEnabled);
  const requiredRows = [...needsManual, ...overrideRows];
  const allValid = requiredRows.every((h) => {
    const f = getRow(h.id);
    const s = parseField(f.startKwh);
    const e = parseField(f.endKwh);
    if (!s.ok || !e.ok) return false;
    return e.value >= s.value;
  });
  const totalCount = households.length;

  async function handleSubmit() {
    if (!allValid) return;
    setSubmitting(true);
    setErrorMsg(null);

    const manualReadings = requiredRows.map((h) => {
      const f = getRow(h.id);
      const s = parseField(f.startKwh);
      const e = parseField(f.endKwh);
      // Both ok per allValid invariant.
      return {
        householdId: h.id,
        startKwh: s.ok ? s.value : 0,
        endKwh: e.ok ? e.value : 0,
        ...(f.reason.trim() ? { reason: f.reason.trim() } : {}),
      };
    });

    try {
      const res = await fetch("/api/billing/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          billingPeriodId,
          manualReadings,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        lineItems?: number;
        error?: string;
        errors?: Array<{
          householdId: string;
          householdName: string;
          error: string;
          code?: string;
        }>;
      };
      if (!res.ok) {
        setErrorMsg(body.error ?? "Failed to generate");
        setSubmitting(false);
        return;
      }
      // Always refresh so partial successes appear on the next render.
      router.refresh();

      const respErrors = body.errors ?? [];
      if (respErrors.length > 0) {
        // Partial OR full failure — switch to result view (panel stays open).
        const successCount = body.lineItems ?? 0;
        setResult({
          errors: respErrors,
          successCount,
          attemptedCount: totalCount,
        });
        setView("result");
        setSubmitting(false);
        return;
      }

      // All-success path — close the panel (existing behavior preserved).
      setSubmitting(false);
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Network error");
      setSubmitting(false);
    }
  }

  // Result-view: replace the form section with the failure summary.
  if (view === "result" && result) {
    return (
      <ResultSection
        result={result}
        onClose={onClose}
      />
    );
  }

  return (
    <section
      data-testid="preflight-panel"
      className="rounded-lg border border-border bg-card p-4"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">
          Generate billing for this period
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-muted-foreground underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Cancel
        </button>
      </div>

      {errorMsg && (
        <div className="mb-3">
          <Banner tone="destructive" title="Could not generate">
            {errorMsg}
          </Banner>
        </div>
      )}

      <div className="space-y-3">
        {/* Section 1: Ready (edge data) — collapsed by default */}
        <Disclosure
          testId="preflight-ready-section"
          summary={`${edgeReady.length} household${edgeReady.length === 1 ? "" : "s"} will be billed using edge data.`}
          expanded={readyExpanded}
          onToggle={() => setReadyExpanded((e) => !e)}
        >
          {edgeReady.length === 0 ? (
            <p className="px-2 py-1 text-[12px] text-muted-foreground">
              No edge-ready households.
            </p>
          ) : (
            <ul className="space-y-1 px-2 py-1">
              {edgeReady.map((h) => (
                <li
                  key={h.id}
                  className="flex items-center gap-2 text-[13px]"
                >
                  <span className="font-medium text-foreground">
                    {h.display_name}
                  </span>
                  <StatusChip
                    kind="billingLineItemReadingSource"
                    status="edge"
                  />
                </li>
              ))}
            </ul>
          )}
        </Disclosure>

        {/* Section 2: Needs manual entry — expanded by default */}
        <section data-testid="preflight-needs-manual-section">
          <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
            Needs manual entry ({needsManual.length})
          </h4>
          {needsManual.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">
              All households have an edge configured.
            </p>
          ) : (
            <ul className="space-y-3">
              {needsManual.map((h) => (
                <ManualRow
                  key={h.id}
                  household={h}
                  row={getRow(h.id)}
                  onChange={(partial) => setRow(h.id, partial)}
                  testIdPrefix="preflight-needs-manual"
                />
              ))}
            </ul>
          )}
        </section>

        {/* Section 3: Override available — collapsed disclosure */}
        <Disclosure
          testId="preflight-override-section"
          summary={`Override available — ${edgeReady.length} edge-connected household${edgeReady.length === 1 ? "" : "s"}.`}
          expanded={overrideExpanded}
          onToggle={() => setOverrideExpanded((e) => !e)}
        >
          {edgeReady.length === 0 ? (
            <p className="px-2 py-1 text-[12px] text-muted-foreground">
              No edge-connected households to override.
            </p>
          ) : (
            <ul className="space-y-3 px-2 py-1">
              {edgeReady.map((h) => {
                const row = getRow(h.id);
                return (
                  <li
                    key={h.id}
                    className="rounded-md border border-border p-2"
                  >
                    <label className="flex items-center gap-2 text-[13px]">
                      <input
                        type="checkbox"
                        className="size-4 rounded border-border accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        checked={row.overrideEnabled}
                        onChange={(e) =>
                          setRow(h.id, { overrideEnabled: e.target.checked })
                        }
                        aria-label={`Use manual entry instead for ${h.display_name}`}
                      />
                      <span className="font-medium text-foreground">
                        {h.display_name}
                      </span>
                      <span className="text-muted-foreground">
                        — Use manual entry instead
                      </span>
                    </label>
                    {row.overrideEnabled && (
                      <div className="mt-2">
                        <ManualRow
                          household={h}
                          row={row}
                          onChange={(partial) => setRow(h.id, partial)}
                          testIdPrefix="preflight-override"
                          showHeader={false}
                          asDiv
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Disclosure>
      </div>

      <div className="mt-4 flex items-center justify-end gap-2 border-t border-border pt-3">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-8 items-center rounded-md px-3.5 text-[13px] font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="preflight-generate-button"
          onClick={() => void handleSubmit()}
          disabled={!allValid || submitting}
          title={!allValid ? "Fill in all required readings to enable Generate." : undefined}
          className={cn(
            "inline-flex h-8 items-center gap-2 rounded-md border border-primary bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          {submitting && (
            <svg
              aria-hidden="true"
              className="h-3.5 w-3.5 animate-spin"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
          )}
          Generate ({totalCount} household{totalCount === 1 ? "" : "s"})
        </button>
      </div>
    </section>
  );
}

/**
 * ResultSection — replaces the form section when view === 'result'.
 * Per AC2 the panel is not a Radix dialog, so this is just an inline
 * <section> swap. "Close" calls onClose() — does NOT need to re-fire
 * any success callback (partial successes already persisted server-side).
 */
function ResultSection(props: {
  result: ResultState;
  onClose: () => void;
}) {
  const { result, onClose } = props;
  const { errors, successCount, attemptedCount } = result;
  const isFullFailure = successCount === 0;
  const tone: "destructive" | "warn" = isFullFailure ? "destructive" : "warn";

  // Preserve API response order (AC7) — do not re-sort.
  const displayed = errors.slice(0, MAX_FAILURES_INLINE);
  const overflow = Math.max(0, errors.length - MAX_FAILURES_INLINE);

  const heading = isFullFailure
    ? `Could not generate ${attemptedCount} household${attemptedCount === 1 ? "" : "s"}`
    : `Generated ${successCount} of ${attemptedCount} household${attemptedCount === 1 ? "" : "s"}`;

  const bannerTitle = isFullFailure
    ? `${errors.length} failure${errors.length === 1 ? "" : "s"}`
    : `${errors.length} household${errors.length === 1 ? "" : "s"} could not be generated`;

  return (
    <section
      data-testid="preflight-panel-result"
      className="rounded-lg border border-border bg-card p-4"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{heading}</h3>
      </div>

      <Banner tone={tone} title={bannerTitle}>
        <ul
          data-testid="preflight-result-failure-list"
          className="mt-1 list-disc space-y-1 pl-5"
        >
          {displayed.map((err) => (
            <li key={err.householdId}>{errorCodeCopy(err)}</li>
          ))}
          {overflow > 0 && (
            <li
              data-testid="preflight-result-failure-overflow"
              className="font-medium"
            >
              + {overflow} more
            </li>
          )}
        </ul>
      </Banner>

      <div className="mt-4 flex items-center justify-end gap-2 border-t border-border pt-3">
        <button
          type="button"
          data-testid="preflight-result-close"
          onClick={onClose}
          className="inline-flex h-8 items-center rounded-md border border-primary bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Close
        </button>
      </div>
    </section>
  );
}

function Disclosure(props: {
  testId: string;
  summary: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const { testId, summary, expanded, onToggle, children } = props;
  return (
    <div
      data-testid={testId}
      className="rounded-md border border-border"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-[13px] text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span>{summary}</span>
        <span aria-hidden="true" className="text-muted-foreground">
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && <div className="border-t border-border">{children}</div>}
    </div>
  );
}

function ManualRow(props: {
  household: Household;
  row: RowFormState;
  onChange: (partial: Partial<RowFormState>) => void;
  testIdPrefix: string;
  showHeader?: boolean;
  /** When true, render as a plain <div> instead of <li> (avoids
   *  nested-<li> when the row sits inside an override section's <li>). */
  asDiv?: boolean;
}) {
  const { household, row, onChange, testIdPrefix, showHeader = true, asDiv = false } = props;
  const startId = React.useId();
  const endId = React.useId();
  const reasonId = React.useId();

  const sParsed = parseField(row.startKwh);
  const eParsed = parseField(row.endKwh);
  const orderError =
    sParsed.ok && eParsed.ok && eParsed.value < sParsed.value
      ? "End must be ≥ Start"
      : null;

  const Wrapper = asDiv ? "div" : "li";
  return (
    <Wrapper
      data-testid={`${testIdPrefix}-row-${household.id}`}
      className="space-y-2"
    >
      {showHeader && (
        <p className="text-[13px] font-medium text-foreground">
          {household.display_name}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label
            htmlFor={startId}
            className="mb-1 block text-[11px] font-medium text-muted-foreground"
          >
            Start (kWh)
          </label>
          <input
            id={startId}
            type="number"
            step="0.001"
            min="0"
            inputMode="decimal"
            value={row.startKwh}
            onChange={(e) => onChange({ startKwh: e.target.value })}
            aria-label={`Start kWh for ${household.display_name}`}
            className="block w-full rounded-md border border-border bg-card px-2 py-1 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div>
          <label
            htmlFor={endId}
            className="mb-1 block text-[11px] font-medium text-muted-foreground"
          >
            End (kWh)
          </label>
          <input
            id={endId}
            type="number"
            step="0.001"
            min="0"
            inputMode="decimal"
            value={row.endKwh}
            onChange={(e) => onChange({ endKwh: e.target.value })}
            aria-label={`End kWh for ${household.display_name}`}
            aria-invalid={orderError !== null}
            className="block w-full rounded-md border border-border bg-card px-2 py-1 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
      </div>
      {orderError && (
        <p className="text-[11px] text-destructive-fg">{orderError}</p>
      )}
      <div>
        <label
          htmlFor={reasonId}
          className="mb-1 block text-[11px] font-medium text-muted-foreground"
        >
          Reason{" "}
          <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <textarea
          id={reasonId}
          value={row.reason}
          onChange={(e) => onChange({ reason: e.target.value })}
          maxLength={500}
          rows={1}
          aria-label={`Manual entry reason for ${household.display_name} (optional, max 500 characters)`}
          className="block w-full resize-none rounded-md border border-border bg-card px-2 py-1 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
    </Wrapper>
  );
}
