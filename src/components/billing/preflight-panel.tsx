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
  /** #339 — households whose meter has no prior MBE reading. */
  seedNeededByHouseholdId?: Record<string, boolean>;
  /** #339 — the household's last recorded end_kwh. Hint text only; never
   *  prefilled, because it is a household figure rather than a reading of
   *  this meter and a plausible prefill is confirmed by inertia. */
  priorHintByHouseholdId?: Record<string, number | null>;
  /** #339 — primary consumption meter per household. */
  deviceIdByHouseholdId?: Record<string, string>;
  /** #339 — period start, the lower bound of the elapsed-usage query. */
  periodStartDate?: string;
}

interface RowFormState {
  startKwh: string;
  endKwh: string;
  reason: string;
  /** #339 — what the operator read on the dial. */
  dialReading: string;
  /**
   * #343 — the DATE the dial was read, `YYYY-MM-DD`, local to the operator.
   *
   * Empty means "not yet touched", and the control shows `todayLocalDate()`
   * in that case. Read `readAtDate` only through `readDateFor()` so the
   * default is resolved in exactly one place.
   *
   * #339 shipped a `readAt` field here that nothing ever wrote, so both of its
   * consumers silently fell back to `new Date()` and the subtraction always
   * ran to the entry date instead of the reading date (#343). A date, not a
   * timestamp: the elapsed-usage query is day-granular, so a time input would
   * collect precision the answer cannot use.
   */
  readAtDate: string;
  /** #339 — usage from period start to the read date, fetched from OpenEMS. */
  elapsedKwh: number | null;
  elapsedState: "idle" | "loading" | "error";
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
  dialReading: "",
  readAtDate: "",
  elapsedKwh: null,
  elapsedState: "idle",
  overrideEnabled: false,
};

const MAX_FAILURES_INLINE = 5;

/**
 * Today, as the operator's calendar sees it (#343).
 *
 * Built from local getters rather than `toISOString().slice(0, 10)`, which
 * names the UTC day: at UTC−5 an evening entry is already tomorrow in UTC, so
 * the slice would default the control to a date the operator has not reached
 * and query usage through it.
 */
function todayLocalDate(): string {
  const d = new Date();
  const month = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * The `readAt` timestamp sent to the route for a chosen read date (#343).
 *
 * Only the date is collected, so the two branches say what is actually known
 * rather than inventing a time. Today: the instant is real, send it. An
 * earlier date: the day is known and the moment is not, so send local noon —
 * far enough from either boundary that no timezone shifts it onto an adjacent
 * day, which midnight would.
 */
function readAtIsoFor(dateStr: string): string {
  if (dateStr === todayLocalDate()) return new Date().toISOString();
  return new Date(`${dateStr}T12:00:00`).toISOString();
}

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
    seedNeededByHouseholdId = {},
    priorHintByHouseholdId = {},
    deviceIdByHouseholdId = {},
    periodStartDate,
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
  /**
   * The read date in force for a row — the operator's choice, or today (#343).
   *
   * The single resolution point for the default. #339's equivalent fallback
   * was written inline at both consumers, where nothing rendered it, so a
   * field that was never set looked deliberate at each site. This one is
   * resolved once and the control below displays its result, which is what
   * makes a wrong default visible instead of inferable.
   */
  function readDateFor(hid: string): string {
    return getRow(hid).readAtDate || todayLocalDate();
  }

  // Partition households by edge availability.
  const needsManual = households.filter(
    (h) => edgeAvailableByHouseholdId[h.id] === false,
  );
  const edgeReady = households.filter(
    (h) => edgeAvailableByHouseholdId[h.id] !== false,
  );

  // #339 — households whose meter has no prior reading. Disjoint from
  // needsManual by construction: a seed is only meaningful for an
  // edge-available device, and needsManual is exactly the not-available set.
  const needsSeed = households.filter(
    (h) => seedNeededByHouseholdId[h.id] === true,
  );

  /**
   * The derived starting reading.
   *
   *     startKwh = dialReading − usage(period start → read date)
   *
   * The operator is asked the answerable question ("what does the dial say?")
   * rather than the unanswerable one ("what did it read on the 1st?"), and the
   * subtraction is over the interval that actually elapsed rather than to now.
   *
   * That second clause was false from #339 until #343: the read date had no
   * control, so it was always the entry date. It is true now because
   * `readDateFor()` is what the visible input writes and what `loadElapsed()`
   * queries. If the control is ever removed, delete this sentence with it.
   *
   * Returns null while the elapsed usage is unknown, which is what keeps the
   * Generate button disabled rather than letting a half-resolved row through.
   */
  function derivedSeed(hid: string): number | null {
    const f = getRow(hid);
    const dial = parseField(f.dialReading);
    if (!dial.ok || f.elapsedKwh == null) return null;
    const v = dial.value - f.elapsedKwh;
    return Number.isFinite(v) ? v : null;
  }

  /**
   * Fetch usage(period start → read date) for this household's meter.
   *
   * Takes the `YYYY-MM-DD` date directly (#343). It previously took an ISO
   * timestamp and sliced the first ten characters, which names the UTC day —
   * a west-of-UTC evening entry would have queried through tomorrow.
   */
  async function loadElapsed(hid: string, readDate: string) {
    const deviceId = deviceIdByHouseholdId[hid];
    if (!deviceId || !periodStartDate) return;
    setRow(hid, { elapsedState: "loading", elapsedKwh: null });
    try {
      const res = await fetch("/api/openems/energy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceIds: [deviceId],
          fromDate: periodStartDate,
          toDate: readDate,
        }),
      });
      if (!res.ok) {
        setRow(hid, { elapsedState: "error", elapsedKwh: null });
        return;
      }
      const body = (await res.json()) as {
        results?: Array<{ deviceId: string; totalKwh: number | null }>;
      };
      const hit = (body.results ?? []).find((r) => r.deviceId === deviceId);
      if (!hit || hit.totalKwh == null) {
        setRow(hid, { elapsedState: "error", elapsedKwh: null });
        return;
      }
      setRow(hid, { elapsedState: "idle", elapsedKwh: hit.totalKwh });
    } catch {
      setRow(hid, { elapsedState: "error", elapsedKwh: null });
    }
  }

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
  // #339 — every seed row must resolve to a non-negative number before
  // Generate is offered. A negative derived value means the dial reads below
  // the period's own usage, which is a mistyped digit rather than a meter that
  // ran backwards.
  const allSeedsValid = needsSeed.every((h) => {
    const v = derivedSeed(h.id);
    return v != null && v >= 0 && readDateProblem(h.id) == null;
  });

  /**
   * Why this row's read date is unusable, or null (#343).
   *
   * Adding the control added two states the panel could not previously reach,
   * so it owes them both an answer. `min`/`max` on the input are a hint the
   * browser may enforce and a typed or pasted value can bypass; this is the
   * check that actually gates Generate.
   */
  function readDateProblem(hid: string): string | null {
    const date = readDateFor(hid);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "Enter the date as YYYY-MM-DD.";
    // String comparison is correct for zero-padded ISO dates and avoids
    // parsing either side into an instant, which is where timezones get in.
    if (periodStartDate && date < periodStartDate) {
      return "That is before this period started — the usage since then cannot be worked out from a reading taken earlier.";
    }
    if (date > todayLocalDate()) return "That date has not happened yet.";
    return null;
  }

  const totalCount = households.length;

  async function handleSubmit() {
    // BOTH gates, not just the manual one. The button is disabled on
    // `!allValid || !allSeedsValid`, but the button is not the only way in:
    // any second caller reaching handleSubmit with an unresolved seed row
    // would send `startKwh: derivedSeed() ?? 0`, and #341's route accepts it
    // because 0 <= dialReading satisfies the ordering bound. That bills from
    // zero — the exact invoice this panel exists to prevent, arriving through
    // the panel built to prevent it.
    //
    // The `?? 0` below stays as a type-level floor; this makes it dead behind
    // two independent checks rather than merely unreachable behind one.
    if (!allValid || !allSeedsValid) return;
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
          // #339. Inputs travel with the derived value: the route recomputes
          // and rejects a mismatch, and a wrong seed stays diagnosable.
          ...(needsSeed.length > 0
            ? {
                seedReadings: needsSeed.map((h) => {
                  const f = getRow(h.id);
                  const dial = parseField(f.dialReading);
                  return {
                    deviceId: deviceIdByHouseholdId[h.id],
                    dialReadingKwh: dial.ok ? dial.value : 0,
                    readAt: readAtIsoFor(readDateFor(h.id)),
                    startKwh: derivedSeed(h.id) ?? 0,
                  };
                }),
              }
            : {}),
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

        {/* Section 0 (#339): meters with no prior reading. Above "Needs
            manual entry" because it blocks the same button and is rarer.
            Absent entirely when nothing needs a seed, which is what keeps
            this from becoming another optional field. */}
        {needsSeed.length > 0 && (
          <section data-testid="preflight-needs-seed-section">
            <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
              Needs a starting reading ({needsSeed.length})
            </h4>
            {/* One string, no branch. The CAUSE is a per-household fact and
                belongs on the row: a microgrid with history can be adding a
                brand-new household today, so a section-level "these were
                billed before they were connected" is false for that row while
                true for its neighbour. Stating an unestablished cause is
                #335's defect, and this section would have reproduced it. */}
            <p className="mb-2 text-[12px] text-muted-foreground">
              MBE has no starting reading for these meters, so it cannot work
              out what to print as the previous reading on the invoice. Enter
              what each meter reads, and the day you read it.
            </p>
            <ul className="space-y-3">
              {needsSeed.map((h) => {
                const f = getRow(h.id);
                const derived = derivedSeed(h.id);
                const hint = priorHintByHouseholdId[h.id];
                const readDate = readDateFor(h.id);
                const dateProblem = readDateProblem(h.id);
                return (
                  <li
                    key={h.id}
                    data-testid={`preflight-seed-row-${h.id}`}
                    className="rounded-md border border-border p-2"
                  >
                    <div className="text-[12px] font-medium text-foreground">
                      {h.display_name}
                    </div>
                    <label
                      htmlFor={`seed-dial-${h.id}`}
                      className="mt-1 block text-[11px] text-muted-foreground"
                    >
                      Reading on the meter (kWh)
                    </label>
                    <input
                      id={`seed-dial-${h.id}`}
                      data-testid={`preflight-seed-dial-${h.id}`}
                      type="number"
                      inputMode="decimal"
                      className="w-40 rounded-md border border-border bg-card px-2 py-1 font-mono text-xs"
                      value={f.dialReading}
                      onChange={(e) => {
                        const v = e.target.value;
                        setRow(h.id, { dialReading: v });
                        if (f.elapsedKwh == null && f.elapsedState !== "loading") {
                          void loadElapsed(h.id, readDateFor(h.id));
                        }
                      }}
                    />
                    {/* #343 — the date the reading was taken.
                        Day granularity because the usage query is day-granular
                        and because it is what the operator can answer: they
                        remember walking the site on Tuesday, not that it was
                        14:20. Defaults to today so same-day entry — the common
                        path — stays a single field, and deferred entry costs
                        one tap rather than being silently wrong. */}
                    <label
                      htmlFor={`seed-read-date-${h.id}`}
                      className="mt-2 block text-[11px] text-muted-foreground"
                    >
                      Day this reading was taken
                    </label>
                    <input
                      id={`seed-read-date-${h.id}`}
                      data-testid={`preflight-seed-read-date-${h.id}`}
                      type="date"
                      className="w-40 rounded-md border border-border bg-card px-2 py-1 font-mono text-xs"
                      value={readDate}
                      min={periodStartDate}
                      max={todayLocalDate()}
                      onChange={(e) => {
                        const date = e.target.value;
                        setRow(h.id, { readAtDate: date });
                        // The elapsed figure belongs to the old date, so it is
                        // cleared rather than left on screen next to a new one.
                        // Refetching needs a dial value to be worth showing,
                        // but the query does not depend on it — so refetch
                        // whenever the row has one.
                        if (parseField(f.dialReading).ok) {
                          void loadElapsed(h.id, date);
                        } else {
                          setRow(h.id, { elapsedKwh: null, elapsedState: "idle" });
                        }
                      }}
                    />
                    {dateProblem && (
                      <p
                        className="mt-1 text-[11px] text-destructive-fg"
                        data-testid={`preflight-seed-date-problem-${h.id}`}
                      >
                        {dateProblem}
                      </p>
                    )}
                    {/* Per-row cause. `hint` is this household's own last
                        recorded end_kwh, so its presence IS the per-row
                        signal: non-null means this household has been billed
                        here before, null means it has not — whether because
                        the household is new or the microgrid is. Those are the
                        same situation from the operator's side and take the
                        same sentence. */}
                    <p
                      className="mt-1 text-[11px] text-muted-foreground"
                      data-testid={`preflight-seed-cause-${h.id}`}
                    >
                      {hint != null
                        ? `Billed manually until now — the last manual bill ended at ${hint.toLocaleString()} kWh.`
                        : "No earlier reading on record. If this meter was installed for this period and started at zero, enter zero — that is a real reading, not a placeholder."}
                    </p>

                    {/* The subtraction is on screen rather than behind the
                        field: the operator types one number and a different
                        one is stored, so a wrong result has to be traceable to
                        which input was wrong. */}
                    <div className="mt-2 text-[11px] text-muted-foreground">
                      {f.elapsedState === "loading" && <span>Fetching usage since period start…</span>}
                      {f.elapsedState === "error" && (
                        <span className="text-destructive-fg">
                          Could not read usage since period start from OpenEMS.
                        </span>
                      )}
                      {f.elapsedState === "idle" && f.elapsedKwh != null && (
                        <span data-testid={`preflight-seed-math-${h.id}`}>
                          {/* #343 — the window is named, not implied. The
                              operator can only catch a wrong read date if the
                              interval it produced is on screen next to the
                              number it changed. */}
                          Used from period start to {readDate} −
                          {f.elapsedKwh.toLocaleString()} kWh
                          {derived != null && (
                            <>
                              {" "}· Starting reading{" "}
                              <strong className="text-foreground">
                                {derived.toLocaleString()} kWh
                              </strong>
                            </>
                          )}
                        </span>
                      )}
                      {derived != null && derived < 0 && (
                        <span className="ml-1 text-destructive-fg">
                          — that is below the usage already recorded this
                          period; check the reading.
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

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
          disabled={!allValid || !allSeedsValid || submitting}
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
