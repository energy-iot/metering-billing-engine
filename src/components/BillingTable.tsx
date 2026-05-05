"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { CopyButton } from "@/components/CopyButton";
import { Currency } from "@/components/format/currency";
import { formatCurrency } from "@/components/format/currency";
import { Kwh } from "@/components/format/kwh";
import { formatKwh } from "@/components/format/kwh";
import { LocalDate } from "@/components/format/local-date";
import { useLocale } from "@/components/format/locale-context";
import { StatusChip } from "@/components/ui/status-chip";
import { CopyTable, type ColumnDef } from "@/components/ui/copy-table";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ClosePeriodDialog, type ClosePeriodSummaryRow } from "@/components/ui/close-period-dialog";
import { Banner } from "@/components/ui/banner";
import { RowActionsMenu } from "@/components/billing/row-actions-menu";
import {
  RowBannerStack,
  type RowBannerEntry,
} from "@/components/billing/row-banner-stack";
import { ManualUsageCell } from "@/components/billing/manual-usage-cell";
import {
  RegenerateRowDialog,
  type RegenerateRowMode,
} from "@/components/billing/regenerate-row-dialog";
import {
  RegenerateMultiDialog,
  type ParentBannerInput,
} from "@/components/billing/regenerate-multi-dialog";
import { PreflightPanel } from "@/components/billing/preflight-panel";
import { StickySelectionBar } from "@/components/billing/sticky-selection-bar";
import {
  buildMultiSelectColumn,
  HeaderCheckbox,
} from "@/components/billing/multi-select-column";
import type {
  BillingLineItem,
  BillingPeriod,
  Household,
  TierConfig,
} from "@/lib/types/domain";

const GATE_BANNER_ID = "payment-gate-banner";

export function BillingTable({
  microgridId,
  period,
  lineItems,
  households,
  tiers,
  currency,
  isPaymentConfigured = true,
  isSuperAdmin = false,
  communityId,
  edgeAvailableByHouseholdId,
  actorByLineItemId,
}: {
  microgridId: string;
  period: BillingPeriod;
  lineItems: BillingLineItem[];
  households: Household[];
  tiers: TierConfig[];
  currency: string;
  /** Whether the community has a payment provider configured. Default: true (no gate banner). */
  isPaymentConfigured?: boolean;
  /** Whether the current user is a super_admin. Controls gate banner copy. Default: false. */
  isSuperAdmin?: boolean;
  /** Community id — used for the super_admin "Go to Payment tab" link. */
  communityId?: string;
  /**
   * Whether each household has a primary_consumption_meter device on a
   * configured edge. Drives visibility of "Switch back to edge data" /
   * "Regenerate from edge data" in the row kebab menu (BC2 #174).
   * Defaults to `true` when a household id is missing from the map.
   */
  edgeAvailableByHouseholdId?: Record<string, boolean>;
  /**
   * Map of `billing_line_items.id → actor display name` resolved via the
   * `user_directory!entered_by_user_id` join in the page loader. Drives
   * the per-row "Updated by …" caption (BC2 #174 AC3). When the join
   * returns null (deleted user OR `entered_by_user_id IS NULL`) the
   * caption falls back to "Updated by a user".
   */
  actorByLineItemId?: Record<string, string | null>;
}) {
  const router = useRouter();
  const supabase = createClient();
  const { locale, currency: localeCurrency } = useLocale();

  // BC3 (#175 AC5): `generating` flag no longer toggled here — the
  // pre-flight panel owns its own submit state. Kept for the disabled-
  // state semantics on the header buttons.
  const [generating] = useState(false);
  const [closing, setClosing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generateErrors, setGenerateErrors] = useState<
    { householdName: string; error: string }[]
  >([]);

  // Dialog state
  const [closePeriodOpen, setClosePeriodOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Phase B (#157) — toast queue for IPN-driven paid transitions. Pollable
  // because Supabase Realtime is not yet wired into this repo; polling every
  // 30s is well under the pilot's traffic profile (Aaron + a handful of
  // households). Toast clears on dismiss or after 30s. Tracking by line-item
  // id avoids re-toasting for the same transition between polls.
  const [paidToasts, setPaidToasts] = useState<
    { lineItemId: string; householdName: string; total: number }[]
  >([]);
  const seenPaidRef = useRef<Set<string>>(new Set());

  const isDraft = period.status === "draft";

  // Build householdId -> lineItem map
  const lineItemMap = new Map<string, BillingLineItem>();
  for (const item of lineItems) {
    lineItemMap.set(item.household_id, item);
  }

  // BC2 (#174) — per-row transient banner queue. Pushed by <RowActionsMenu>
  // for stub regenerate handlers, payment-link failures, and IPN auto-close
  // notices. Rendered by <RowBannerStack> below the CopyTable as a sibling
  // of the rowErrors <ul>.
  const [rowBanners, setRowBanners] = useState<RowBannerEntry[]>([]);
  const pushRowBanner = React.useCallback((entry: RowBannerEntry) => {
    setRowBanners((prev) => [...prev, entry]);
  }, []);
  const dismissRowBanner = React.useCallback((id: string) => {
    setRowBanners((prev) => prev.filter((e) => e.id !== id));
  }, []);
  const getHouseholdNameForLineItem = React.useCallback(
    (lineItemId: string) => {
      const li = lineItems.find((x) => x.id === lineItemId);
      if (!li) return undefined;
      return households.find((h) => h.id === li.household_id)?.display_name;
    },
    [lineItems, households],
  );

  // BC3 (#175 AC1) — per-line-item flag for "Switch to manual entry…" on
  // a DRAFT-period metered row. While set, the cell becomes editable so
  // the operator can save the manual reading without leaving the table.
  // Cleared after a successful manual save (the row's prop renders with
  // reading_source='manual') OR after a successful regenerate that touches
  // the row OR on unmount (component re-mount).
  const [switchedToManual, setSwitchedToManual] = useState<Set<string>>(
    () => new Set(),
  );
  const clearSwitchedToManual = React.useCallback((lineItemId: string) => {
    setSwitchedToManual((prev) => {
      if (!prev.has(lineItemId)) return prev;
      const next = new Set(prev);
      next.delete(lineItemId);
      return next;
    });
  }, []);

  // BC3 (#175 AC3) — multi-select state. Keyed by household id so the
  // selection survives a server round-trip even if line item ids change.
  // Cleared on successful regenerate (any path), Esc inside the table,
  // and "Clear selection" in the sticky bar.
  const [selectedHouseholdIds, setSelectedHouseholdIds] = useState<Set<string>>(
    () => new Set(),
  );

  // BC3 (#175 AC5) — pre-flight panel open/close.
  const [preflightOpen, setPreflightOpen] = useState(false);

  // BC3 (#175 AC2) — per-row regenerate dialog state.
  const [regenerateRowDialog, setRegenerateRowDialog] = useState<
    | { open: false }
    | {
        open: true;
        lineItemId: string;
        householdId: string;
        mode: RegenerateRowMode;
      }
  >({ open: false });

  // BC3 (#175 AC4) — multi-select bulk regenerate dialog state.
  const [regenerateMultiOpen, setRegenerateMultiOpen] = useState(false);

  // BC3 (#175 AC4 / AC7) — parent-level banner stack for bulk-success /
  // bulk-failure surfaces. Per-line-item banners go through
  // <RowBannerStack>. Auto-dismiss after `durationMs`.
  const [parentBanners, setParentBanners] = useState<
    Array<{
      id: string;
      tone: "info" | "destructive";
      message: string;
      action?: { label: string; onClick: () => void };
      durationMs: number;
    }>
  >([]);
  const pushParentBanner = React.useCallback((entry: ParentBannerInput) => {
    const id = `parent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setParentBanners((prev) => [...prev, { ...entry, id }]);
  }, []);
  const dismissParentBanner = React.useCallback((id: string) => {
    setParentBanners((prev) => prev.filter((b) => b.id !== id));
  }, []);

  // #158: per-row error message surfaced from the inline-edit cells. Keyed
  // by line item id so a failure on one un-metered row doesn't clobber the
  // others. Cleared on next successful save or Esc-revert.
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const recordRowError = React.useCallback(
    (lineItemId: string, message: string | null) => {
      setRowErrors((prev) => {
        if (message === null) {
          if (!(lineItemId in prev)) return prev;
          const next = { ...prev };
          delete next[lineItemId];
          return next;
        }
        return { ...prev, [lineItemId]: message };
      });
    },
    []
  );

  // Pre-seed the "already paid" set with the snapshot we received on render
  // so we don't toast for line items that were already paid before the user
  // opened the page.
  useEffect(() => {
    for (const item of lineItems) {
      if (item.payment_status === "paid") {
        seenPaidRef.current.add(item.id);
      }
    }
    // We deliberately depend on the IDs+statuses array shape (a render-time
    // snapshot is fine for pre-seed). Re-seeding when lineItems prop changes
    // is the desired behavior — a refresh that pulls fresh server state
    // collapses the toast.
  }, [lineItems]);

  // Phase B polling — every 30s, ask the API which line items in this period
  // are now paid. Compare against the snapshot; emit a toast for each newly-
  // paid line item. This is intentionally simple (no realtime); upgradable.
  useEffect(() => {
    if (!period?.id) return;
    if (lineItems.length === 0) return;
    if (period.status !== "draft") return; // closed periods can't change

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll(): Promise<void> {
      try {
        // Read the same period's line items via the Supabase client (RLS
        // applies). Cheap query — same shape we already render.
        const { data, error } = await supabase
          .from("billing_line_items")
          .select("id, household_id, payment_status, total_amount")
          .eq("billing_period_id", period.id);
        if (cancelled || error || !data) return;

        const newlyPaid: typeof paidToasts = [];
        for (const row of data as Array<{
          id: string;
          household_id: string;
          payment_status: string;
          total_amount: number;
        }>) {
          if (
            row.payment_status === "paid" &&
            !seenPaidRef.current.has(row.id)
          ) {
            seenPaidRef.current.add(row.id);
            const hh = households.find((h) => h.id === row.household_id);
            newlyPaid.push({
              lineItemId: row.id,
              householdName: hh?.display_name ?? "Household",
              total: Number(row.total_amount),
            });
          }
        }

        if (newlyPaid.length > 0) {
          setPaidToasts((prev) => [...prev, ...newlyPaid]);
          // Pull a fresh server render so payment_status / paid_at land in
          // the visible row.
          router.refresh();
        }
      } catch {
        // ignore — next poll will retry
      } finally {
        if (!cancelled) timer = setTimeout(poll, 30_000);
      }
    }

    timer = setTimeout(poll, 30_000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [period?.id, period?.status, lineItems.length, supabase, router, households]);

  function dismissToast(lineItemId: string): void {
    setPaidToasts((prev) => prev.filter((t) => t.lineItemId !== lineItemId));
  }

  // Grand totals
  let grandTotalKwh = 0;
  let grandTotal = 0;
  const grandTierKwh: number[] = tiers.map(() => 0);
  const grandTierAmount: number[] = tiers.map(() => 0);

  for (const item of lineItems) {
    // #158: usage_kwh may be NULL on un-metered rows that haven't been
    // filled in yet. Treat NULL as 0 in the grand total — the row reads as
    // an em-dash in the per-cell display, but it shouldn't poison the sum.
    grandTotalKwh += item.usage_kwh ?? 0;
    grandTotal += item.total_amount;

    const breakdown = item.tier_breakdown as { label: string; kwh: number; amount: number }[];
    for (let i = 0; i < breakdown.length && i < tiers.length; i++) {
      grandTierKwh[i] += breakdown[i].kwh;
      grandTierAmount[i] += breakdown[i].amount;
    }
  }

  // BC3 (#175 AC5) — `handleGenerate` now opens the pre-flight panel
  // instead of firing the bulk POST. The actual /api/billing/generate
  // call lives inside <PreflightPanel> on submit.
  function handleGenerate() {
    setError(null);
    setGenerateErrors([]);
    setPreflightOpen(true);
  }

  // BC3 (#175 AC1) — auto-clear `switchedToManual` for a line item when
  // its server-confirmed `reading_source` becomes 'manual' (the persisted
  // state caught up with the local flag).
  useEffect(() => {
    if (switchedToManual.size === 0) return;
    setSwitchedToManual((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const item of lineItems) {
        if (next.has(item.id) && item.reading_source === "manual") {
          next.delete(item.id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [lineItems, switchedToManual.size]);

  // BC3 (#175 AC3 / AC7) — Esc inside the table clears the selection.
  useEffect(() => {
    if (selectedHouseholdIds.size === 0) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setSelectedHouseholdIds(new Set());
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedHouseholdIds.size]);

  // BC3 (#175 AC4 / AC7) — auto-dismiss parent banners.
  useEffect(() => {
    if (parentBanners.length === 0) return;
    const timers = parentBanners
      .filter((b) => b.durationMs > 0)
      .map((b) =>
        setTimeout(() => dismissParentBanner(b.id), b.durationMs),
      );
    return () => timers.forEach(clearTimeout);
  }, [parentBanners, dismissParentBanner]);

  async function handleDelete() {
    setError(null);
    setDeleting(true);
    const { error: deleteError } = await supabase
      .from("billing_periods")
      .delete()
      .eq("id", period.id);
    if (deleteError) {
      setDeleting(false);
      throw new Error(deleteError.message);
    }
    router.push(`/microgrids/${microgridId}/billing`);
  }

  async function handleClose() {
    setError(null);
    setClosing(true);

    const { error: updateError } = await supabase
      .from("billing_periods")
      .update({
        status: "closed",
        closed_at: new Date().toISOString(),
      })
      .eq("id", period.id);

    if (updateError) {
      setClosing(false);
      throw new Error(updateError.message);
    }

    setClosing(false);
    router.refresh();
  }

  // Build period label for ClosePeriodDialog
  const periodLabel =
    period.start_date === period.end_date
      ? period.start_date
      : `${period.start_date} – ${period.end_date}`;

  // #167 — derive the list of un-metered households whose `usage_kwh` is
  // still NULL. These are the rows that would silently lock in zero kWh /
  // zero amount on close. Surfaced to <ClosePeriodDialog> as a warning
  // banner; closing is still permitted (operator may genuinely intend to
  // bill nothing) but the gesture becomes more deliberate.
  const unfilledHouseholdNames = lineItems
    .filter(
      (item) =>
        item.device_id === null &&
        (item.usage_kwh === null || item.usage_kwh === undefined)
    )
    .map(
      (item) =>
        households.find((h) => h.id === item.household_id)?.display_name ??
        "Unknown household"
    );

  // Build summary rows for ClosePeriodDialog
  const closePeriodSummaryRows: ClosePeriodSummaryRow[] = [
    {
      label: "Households",
      value: String(lineItems.length),
    },
    {
      label: `Total (${currency})`,
      value: <Currency value={grandTotal} bareNumber />,
    },
    {
      label: "Total (kWh)",
      value: <Kwh value={grandTotalKwh} bareNumber />,
    },
  ];

  // CopyTable columns built from tiers
  // Format helpers (plain string, for CopyTable column defs)
  const kwhFormat = (v: number | string | null) =>
    formatKwh(v == null ? null : Number(v), locale, { bareNumber: true });
  const amountFormat = (v: number | string | null) =>
    formatCurrency(v == null ? null : Number(v), locale, localeCurrency, { bareNumber: true });

  // Households with line items for the CopyTable (only households that have data)
  const householdsWithItems = households.filter((h) => lineItemMap.has(h.id));

  // BC3 (#175 AC3) — leading checkbox column. Hidden while pre-flight is
  // open (the operator is generating, not regenerating).
  const visibleHouseholdIds = householdsWithItems.map((h) => h.id);
  const multiSelectColumn = buildMultiSelectColumn<Household>({
    getRowId: (h) => h.id,
    getRowName: (h) => h.display_name,
    selectedIds: selectedHouseholdIds,
    visibleIds: visibleHouseholdIds,
    onToggleRow: (id) =>
      setSelectedHouseholdIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    onSetAll: (ids) => setSelectedHouseholdIds(new Set(ids)),
    hidden: preflightOpen,
  });
  const headerSelectionState: "checked" | "unchecked" | "indeterminate" =
    selectedHouseholdIds.size === 0
      ? "unchecked"
      : selectedHouseholdIds.size === visibleHouseholdIds.length &&
          visibleHouseholdIds.length > 0
        ? "checked"
        : "indeterminate";

  const columns: ColumnDef<Household>[] = [
    ...(multiSelectColumn ? [multiSelectColumn] : []),
    {
      kind: "row-header",
      header: "Household",
      accessor: (h) => h.display_name,
    },
    {
      kind: "value",
      header: "Begin (kWh)",
      accessor: (h) => lineItemMap.get(h.id)?.start_kwh ?? null,
      format: (v) => (v == null ? "—" : kwhFormat(v)),
    },
    // #158: END (kWh) and USAGE (kWh) are inline-editable for un-metered
    // rows (lineItem.device_id == null). Metered rows render the same
    // visual as before via ManualUsageCell's read-only path. We render
    // these as `action` columns so the inline <input> doesn't fight the
    // CopyTable's keyboard nav grid; un-metered rows are operator-entry
    // surfaces, not URA-paste targets.
    {
      kind: "action",
      header: "End (kWh)",
      className: "text-right",
      render: (h) => {
        const item = lineItemMap.get(h.id);
        if (!item) return <span className="text-muted-foreground">—</span>;
        const isUnmetered = item.device_id == null;
        // BC3 (#175 AC1) — also editable when the operator picked
        // "Switch to manual entry…" from the kebab on a draft row.
        // Closed periods stay read-only (PATCH /usage 409s on closed).
        const editable =
          (isUnmetered || switchedToManual.has(item.id)) && isDraft;
        return (
          <ManualUsageCell
            lineItemId={item.id}
            field="end_kwh"
            value={item.end_kwh}
            format={(v) => (v == null ? "—" : kwhFormat(v))}
            editable={editable}
            onError={recordRowError}
          />
        );
      },
    },
    {
      kind: "action",
      header: "Usage (kWh)",
      className: "text-right",
      render: (h) => {
        const item = lineItemMap.get(h.id);
        if (!item) return <span className="text-muted-foreground">—</span>;
        const isUnmetered = item.device_id == null;
        // BC3 (#175 AC1) — same OR-branch as End (kWh) above.
        const editable =
          (isUnmetered || switchedToManual.has(item.id)) && isDraft;
        return (
          <ManualUsageCell
            lineItemId={item.id}
            field="usage_kwh"
            value={item.usage_kwh}
            format={(v) => (v == null ? "—" : kwhFormat(v))}
            editable={editable}
            onError={recordRowError}
          />
        );
      },
    },
    ...tiers.flatMap((tier, i): ColumnDef<Household>[] => [
      {
        kind: "value",
        header: `${tier.label} kWh`,
        accessor: (h) => {
          const bd = lineItemMap.get(h.id)?.tier_breakdown as { label: string; kwh: number; amount: number }[] | undefined;
          return bd?.[i]?.kwh ?? null;
        },
        format: (v) => (v == null ? "—" : kwhFormat(v)),
      },
      {
        kind: "value",
        header: `${tier.label} (${currency})`,
        accessor: (h) => {
          const bd = lineItemMap.get(h.id)?.tier_breakdown as { label: string; kwh: number; amount: number }[] | undefined;
          return bd?.[i]?.amount ?? null;
        },
        format: (v) => (v == null ? "—" : amountFormat(v)),
      },
    ]),
    {
      kind: "value",
      header: `Total (${currency})`,
      accessor: (h) => lineItemMap.get(h.id)?.total_amount ?? null,
      format: (v) => (v == null ? "—" : amountFormat(v)),
    },
    {
      kind: "action",
      header: "Status",
      render: (h) => {
        const item = lineItemMap.get(h.id);
        if (!item) return null;

        const edgeAvailable =
          edgeAvailableByHouseholdId?.[h.id] ?? true;
        const actorDisplayName =
          actorByLineItemId?.[item.id] ?? null;

        // Per AC3: caption suppressed when reading_source !== 'manual'
        // OR entered_at is null (legacy rows pre-BC1 are tolerated).
        const showCaption =
          item.reading_source === "manual" && item.entered_at != null;
        const captionLabel = actorDisplayName ?? "a user";

        return (
          <span className="inline-flex flex-col items-end gap-1">
            <RowActionsMenu
              microgridId={microgridId}
              lineItem={{
                id: item.id,
                payment_status: item.payment_status,
                reading_source: item.reading_source,
                total_amount: item.total_amount,
                // #221 — drives the Generate vs Regenerate menu signal.
                pesapal_redirect_url: item.pesapal_redirect_url,
              }}
              household={{ id: h.id, display_name: h.display_name }}
              period={{
                id: period.id,
                status: period.status,
                start_date: period.start_date,
                end_date: period.end_date,
              }}
              edgeAvailable={edgeAvailable}
              isPaymentConfigured={isPaymentConfigured}
              onRowBanner={pushRowBanner}
              onRequestRegenerate={(mode) =>
                setRegenerateRowDialog({
                  open: true,
                  lineItemId: item.id,
                  householdId: h.id,
                  mode,
                })
              }
              onRequestSwitchToManual={() => {
                // BC3 (#175 AC1) — On a CLOSED period, the kebab item
                // opens <RegenerateRowDialog mode='manual'> (the cell is
                // not editable on closed). On a DRAFT period, flip the
                // per-row flag so the cell becomes inline-editable.
                if (period.status === "closed") {
                  setRegenerateRowDialog({
                    open: true,
                    lineItemId: item.id,
                    householdId: h.id,
                    mode: "manual",
                  });
                } else {
                  setSwitchedToManual((prev) => {
                    const next = new Set(prev);
                    next.add(item.id);
                    return next;
                  });
                }
              }}
            />
            {showCaption && item.entered_at && (
              <p className="text-[11px] text-muted-foreground">
                Updated by {captionLabel} ·{" "}
                <LocalDate value={item.entered_at} relative />
              </p>
            )}
          </span>
        );
      },
    },
  ];

  return (
    <div className="space-y-4">
      {/* Delete Period Dialog */}
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete period?"
        description="This permanently removes the period and all its line items."
        confirmLabel="Delete"
        tone="destructive"
        onConfirm={handleDelete}
      />

      {/* Close Period Dialog */}
      <ClosePeriodDialog
        open={closePeriodOpen}
        onOpenChange={setClosePeriodOpen}
        periodLabel={periodLabel}
        summaryRows={closePeriodSummaryRows}
        grandTotal={grandTotal}
        onConfirm={handleClose}
        unfilledHouseholdNames={unfilledHouseholdNames}
      />

      {/* BC3 (#175 AC2) — per-row regenerate dialog. Mounts only when
          open so the immediate-fire path (edge unpaid) doesn't fire on
          mount of the parent. */}
      {regenerateRowDialog.open && (() => {
        const li = lineItems.find((x) => x.id === regenerateRowDialog.lineItemId);
        const hh = households.find((h) => h.id === regenerateRowDialog.householdId);
        if (!li || !hh) return null;
        return (
          <RegenerateRowDialog
            open
            onOpenChange={(o) => {
              if (!o) setRegenerateRowDialog({ open: false });
            }}
            mode={regenerateRowDialog.mode}
            household={{ id: hh.id, display_name: hh.display_name }}
            period={{
              id: period.id,
              status: period.status,
              start_date: period.start_date,
              end_date: period.end_date,
            }}
            lineItem={{ id: li.id, payment_status: li.payment_status }}
            pushBanner={pushRowBanner}
            dismissBanner={dismissRowBanner}
            onSuccess={(lineItemId) => {
              clearSwitchedToManual(lineItemId);
            }}
          />
        );
      })()}

      {/* BC3 (#175 AC4) — multi-select bulk regenerate dialog. */}
      <RegenerateMultiDialog
        open={regenerateMultiOpen}
        onOpenChange={setRegenerateMultiOpen}
        billingPeriodId={period.id}
        selectedHouseholdIds={Array.from(selectedHouseholdIds)}
        households={households}
        lineItemsByHouseholdId={lineItemMap}
        pushParentBanner={pushParentBanner}
        pushRowBanner={pushRowBanner}
        onSuccess={() => {
          setSelectedHouseholdIds(new Set());
        }}
      />

      {/* Header */}
      <div className="rounded-lg border border-border bg-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              {period.start_date === period.end_date ? (
                <LocalDate value={period.start_date + "T00:00:00"} />
              ) : (
                <>
                  <LocalDate value={period.start_date + "T00:00:00"} />
                  {" – "}
                  <LocalDate value={period.end_date + "T00:00:00"} />
                </>
              )}
            </h2>
            <span className="mt-1 inline-block">
              <StatusChip kind="billingPeriod" status={period.status} />
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* BC4 (#176): "View history" link — renders on draft AND closed
                periods (audit trail matters most after close). Always
                rendered even before any events exist; the destination
                page owns the empty-state pedagogy. */}
            <Link
              href={`/microgrids/${microgridId}/billing/${period.id}/history`}
              className="text-sm text-muted-foreground underline underline-offset-2 hover:opacity-80"
            >
              View history
            </Link>
            {isDraft && (
              <>
                <button
                  onClick={handleGenerate}
                  disabled={generating || closing || deleting}
                  className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {generating
                    ? "Generating..."
                    : lineItems.length > 0
                      ? "Refresh Readings"
                      : "Generate"}
                </button>
                <button
                  onClick={() => setClosePeriodOpen(true)}
                  disabled={generating || closing || deleting || lineItems.length === 0}
                  className="rounded-md border border-border bg-card px-4 py-2 text-sm text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {closing ? "Closing..." : "Close Period"}
                </button>
              </>
            )}
            <button
              onClick={() => setDeleteDialogOpen(true)}
              disabled={generating || closing || deleting}
              className="rounded-md border border-destructive bg-card px-4 py-2 text-sm text-destructive hover:bg-destructive-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {deleting ? "Deleting..." : "Delete"}
            </button>
          </div>
        </div>
      </div>

      {/* Errors */}
      {error && (
        <div className="rounded-md bg-destructive-muted p-3 text-sm text-destructive-fg">
          {error}
        </div>
      )}

      {/* Phase B (#157) — IPN-driven paid toasts. */}
      {paidToasts.length > 0 && (
        <div
          aria-live="polite"
          className="space-y-2"
          data-testid="payment-toast-stack"
        >
          {paidToasts.map((t) => (
            <div
              key={t.lineItemId}
              role="status"
              data-testid="payment-paid-toast"
              className="flex items-start justify-between gap-3 rounded-md border border-border bg-success-muted p-3 text-sm text-success-fg"
            >
              <span>
                Payment received: <strong>{t.householdName}</strong>,{" "}
                <Currency value={t.total} />
              </span>
              <button
                type="button"
                onClick={() => dismissToast(t.lineItemId)}
                className="text-success-fg underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Dismiss payment notification"
              >
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Generate warnings */}
      {generateErrors.length > 0 && (
        <div className="rounded-md bg-warning-muted p-3 text-sm text-warning-fg">
          <p className="font-medium">
            Some households could not be billed:
          </p>
          <ul className="mt-1 list-inside list-disc">
            {generateErrors.map((e, i) => (
              <li key={i}>
                {e.householdName}: {e.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* BC3 (#175 AC4 / AC7) — parent-level banners (bulk-success +
          bulk-failure). Per-line-item banners go through <RowBannerStack>
          below the table. Auto-dismissed by the effect above. */}
      {parentBanners.length > 0 && (
        <div
          aria-live="polite"
          className="space-y-2"
          data-testid="parent-banner-stack"
        >
          {parentBanners.map((b) => (
            <Banner
              key={b.id}
              tone={b.tone}
              title={b.message}
              action={
                <div className="flex items-center gap-2">
                  {b.action && (
                    <button
                      type="button"
                      onClick={b.action.onClick}
                      className="text-sm font-medium underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {b.action.label}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => dismissParentBanner(b.id)}
                    className="text-sm font-medium underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Dismiss
                  </button>
                </div>
              }
            >
              <span className="sr-only">{b.message}</span>
            </Banner>
          ))}
        </div>
      )}

      {/* BC3 (#175 AC5) — Pre-flight panel. Mounted under the header,
          above the CopyTable. Closed periods can't open it (the
          "Generate" / "Refresh Readings" button is hidden by the existing
          isDraft gate). */}
      {isDraft && (
        <PreflightPanel
          open={preflightOpen}
          onClose={() => setPreflightOpen(false)}
          billingPeriodId={period.id}
          households={households}
          edgeAvailableByHouseholdId={edgeAvailableByHouseholdId ?? {}}
        />
      )}

      {/* Billing Table */}
      <div className="rounded-lg border border-border bg-card p-6">
        {lineItems.length === 0 && households.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            No billing data yet.{" "}
            {isDraft
              ? 'Click "Generate" to fetch meter readings and calculate costs.'
              : ""}
          </p>
        ) : households.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No households configured for this microgrid.
          </p>
        ) : householdsWithItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No billing data yet.{" "}
            {isDraft
              ? 'Click "Generate" to fetch meter readings and calculate costs.'
              : ""}
          </p>
        ) : (
          <div className="space-y-4">
            {/* Gate banner: shown when community has no payment provider configured */}
            {!isPaymentConfigured && (
              <Banner
                id={GATE_BANNER_ID}
                tone="warn"
                title="No payment provider configured"
              >
                {isSuperAdmin ? (
                  <>
                    Connect a payment provider to generate payment links.{" "}
                    {communityId && (
                      <Link
                        href={`/communities/${communityId}/payment`}
                        className="text-sm font-medium text-warning-fg underline"
                      >
                        Go to Payment tab
                      </Link>
                    )}
                  </>
                ) : (
                  "Ask a super admin to configure Payment for this community."
                )}
              </Banner>
            )}

            {/* BC3 (#175 AC3) — Tri-state "Select all" header checkbox.
                Rendered ABOVE the table because <CopyTable>'s `header`
                prop only accepts strings. The action-column checkbox
                column header itself stays blank to pair visually. */}
            {!preflightOpen && (
              <div className="flex items-center justify-between gap-2">
                <HeaderCheckbox
                  state={headerSelectionState}
                  onToggle={() =>
                    setSelectedHouseholdIds((prev) =>
                      prev.size === visibleHouseholdIds.length &&
                      visibleHouseholdIds.length > 0
                        ? new Set()
                        : new Set(visibleHouseholdIds),
                    )
                  }
                  visibleCount={visibleHouseholdIds.length}
                />
              </div>
            )}

            <CopyTable
              rows={householdsWithItems}
              columns={columns}
              caption={`Billing table for period ${periodLabel} — ${householdsWithItems.length} household${householdsWithItems.length !== 1 ? "s" : ""}`}
              ariaLabel={`Billing data for ${periodLabel}`}
            />

            {/* BC2 (#174) — per-row transient banners (payment-link
                errors, IPN auto-close info, BC3 regenerate stubs). */}
            <RowBannerStack
              entries={rowBanners}
              onDismiss={dismissRowBanner}
              getHouseholdName={getHouseholdNameForLineItem}
            />

            {/* #158: surface per-row inline-edit errors below the grid so
                they aren't trapped inside the CopyTable's static markup.
                Cleared automatically when the user successfully retries or
                presses Esc on the cell. */}
            {Object.keys(rowErrors).length > 0 && (
              <ul className="space-y-1 rounded-md border border-destructive bg-destructive-muted p-3 text-xs text-destructive-fg">
                {Object.entries(rowErrors).map(([lineItemId, message]) => {
                  const item = lineItems.find((li) => li.id === lineItemId);
                  const householdName = households.find(
                    (h) => h.id === item?.household_id
                  )?.display_name;
                  return (
                    <li key={lineItemId} className="flex items-center justify-between gap-2">
                      <span>
                        {householdName ? `${householdName}: ` : ""}
                        Could not save: {message}
                      </span>
                      <button
                        type="button"
                        onClick={() => recordRowError(lineItemId, null)}
                        className="rounded-sm border border-destructive bg-card px-2 py-0.5 text-[11px] font-medium text-destructive-fg hover:bg-muted"
                      >
                        Dismiss
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Grand-total footer — rendered BELOW the CopyTable */}
            {lineItems.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t-2 border-border pt-3 text-sm font-medium text-foreground">
                <span className="w-32 text-foreground">Total</span>
                <span className="whitespace-nowrap">
                  <span className="text-xs text-muted-foreground mr-1">kWh</span>
                  <Kwh value={grandTotalKwh} bareNumber />
                  <CopyButton value={grandTotalKwh} />
                </span>
                {tiers.map((_, i) => (
                  <React.Fragment key={`grand-tier-${i}`}>
                    <span className="whitespace-nowrap">
                      <span className="text-xs text-muted-foreground mr-1">{tiers[i].label} kWh</span>
                      <Kwh value={grandTierKwh[i]} bareNumber />
                      <CopyButton value={grandTierKwh[i]} />
                    </span>
                    <span className="whitespace-nowrap">
                      <span className="text-xs text-muted-foreground mr-1">{tiers[i].label} ({currency})</span>
                      <Currency value={grandTierAmount[i]} bareNumber />
                      <CopyButton value={grandTierAmount[i]} />
                    </span>
                  </React.Fragment>
                ))}
                <span className="whitespace-nowrap">
                  <span className="text-xs text-muted-foreground mr-1">Total ({currency})</span>
                  <Currency value={grandTotal} bareNumber />
                  <CopyButton value={grandTotal} />
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* BC3 (#175 AC3 / AC6) — sticky selection bar. Mounted as the last
          child of the BillingTable container so document-flow layering is
          unambiguous. On a closed period the bar still renders (selection
          is allowed) but the regenerate button is disabled with the
          gating tooltip. */}
      <StickySelectionBar
        visibleCount={visibleHouseholdIds.length}
        selectedCount={selectedHouseholdIds.size}
        onRegenerate={() => setRegenerateMultiOpen(true)}
        onClear={() => setSelectedHouseholdIds(new Set())}
        disabled={!isDraft}
        disabledTooltip={
          !isDraft
            ? "Use per-row regenerate on a closed period — bulk regenerate is draft-only."
            : undefined
        }
      />
    </div>
  );
}
