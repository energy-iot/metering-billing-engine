"use client";

/**
 * RegenerateMultiDialog — multi-select bulk regenerate (BC3 #175 AC4).
 *
 * Triggered by the sticky selection bar's "Regenerate selected" button.
 * Displays the selected households grouped into:
 *   - "Will be regenerated" (current reading_source = 'edge'),
 *   - "Will be skipped" (current reading_source = 'manual') — Q5=B: manual
 *     rows are per-row only inside this multi-flow.
 *
 * On confirm: single POST /api/billing/generate with the edge-only set as
 * householdIds (NO manualReadings). Renders inline destructive banner on
 * non-2xx OR if errors[] is non-empty (top-level + per-row banners pushed
 * via parent callbacks).
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Currency } from "@/components/format/currency";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { StatusChip } from "@/components/ui/status-chip";
import type { RowBannerEntry } from "@/components/billing/row-banner-stack";
import type {
  BillingLineItem,
  Household,
  ReadingSource,
} from "@/lib/types/domain";

export type ParentBannerTone = "info" | "destructive";

export interface ParentBannerInput {
  tone: ParentBannerTone;
  message: string;
  action?: { label: string; onClick: () => void };
  durationMs: number;
}

export interface RegenerateMultiDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  billingPeriodId: string;
  /** Selected household IDs (parent owns the Set). */
  selectedHouseholdIds: string[];
  /** Households indexed by id. */
  households: Household[];
  /** Line items for the current period, indexed by household_id. */
  lineItemsByHouseholdId: Map<string, BillingLineItem>;
  /** Push a parent-level banner (sibling of paidToasts). */
  pushParentBanner: (entry: ParentBannerInput) => void;
  /** Push a per-row destructive banner via <RowBannerStack>. */
  pushRowBanner: (entry: RowBannerEntry) => void;
  /** Called after a successful regenerate so the parent can clear the selection set. */
  onSuccess?: () => void;
}

const ERROR_BANNER_DURATION_MS = 8000;
const INFO_BANNER_DURATION_MS = 5000;

export function RegenerateMultiDialog(props: RegenerateMultiDialogProps) {
  const {
    open,
    onOpenChange,
    billingPeriodId,
    selectedHouseholdIds,
    households,
    lineItemsByHouseholdId,
    pushParentBanner,
    pushRowBanner,
    onSuccess,
  } = props;
  const router = useRouter();

  // Build the partition — pure derivation from props.
  type Row = {
    householdId: string;
    householdName: string;
    lineItemId: string | null;
    readingSource: ReadingSource | null;
    totalAmount: number | null;
  };

  const householdsById = React.useMemo(() => {
    const m = new Map<string, Household>();
    for (const h of households) m.set(h.id, h);
    return m;
  }, [households]);

  const rows: Row[] = selectedHouseholdIds.map((hid) => {
    const h = householdsById.get(hid);
    const li = lineItemsByHouseholdId.get(hid) ?? null;
    return {
      householdId: hid,
      householdName: h?.display_name ?? "Unknown",
      lineItemId: li?.id ?? null,
      readingSource: li?.reading_source ?? null,
      totalAmount: li?.total_amount ?? null,
    };
  });

  const edgeRows = rows.filter((r) => r.readingSource !== "manual");
  const manualRows = rows.filter((r) => r.readingSource === "manual");
  const allSelectedAreManual = rows.length > 0 && edgeRows.length === 0;

  // Hold the latest values in a ref so the confirm handler can read them
  // without manual memoization (React Compiler handles its own caching;
  // a useCallback whose deps include derived arrays cannot be preserved).
  const stateRef = React.useRef({
    edgeIds: edgeRows.map((r) => r.householdId),
    billingPeriodId,
    pushParentBanner,
    pushRowBanner,
    lineItemsByHouseholdId,
    onSuccess,
    router,
  });
  React.useEffect(() => {
    stateRef.current = {
      edgeIds: edgeRows.map((r) => r.householdId),
      billingPeriodId,
      pushParentBanner,
      pushRowBanner,
      lineItemsByHouseholdId,
      onSuccess,
      router,
    };
  });

  async function handleConfirm() {
    const s = stateRef.current;
    if (s.edgeIds.length === 0) {
      throw new Error("All selected rows are manual — nothing to regenerate.");
    }
    const res = await fetch("/api/billing/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        billingPeriodId: s.billingPeriodId,
        householdIds: s.edgeIds,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      lineItems?: number;
      errors?: Array<{ householdId: string; error: string; code?: string }>;
      error?: string;
    };
    if (!res.ok) {
      // Top-level failure — surface a parent-level destructive banner.
      const message = body.error ?? "Failed to regenerate";
      s.pushParentBanner({
        tone: "destructive",
        message,
        durationMs: ERROR_BANNER_DURATION_MS,
      });
      throw new Error(message);
    }

    const respErrors = body.errors ?? [];
    // Push per-row destructive banners for failures.
    const stamp = Date.now();
    for (const err of respErrors) {
      const li = s.lineItemsByHouseholdId.get(err.householdId);
      if (!li) continue;
      s.pushRowBanner({
        id: `${li.id}-multi-regen-err-${stamp}-${err.householdId}`,
        lineItemId: li.id,
        tone: "destructive",
        message: err.error,
        durationMs: ERROR_BANNER_DURATION_MS,
      });
    }

    // Success info banner — N is the number of edge-only-selected rows
    // minus rows that came back as errors.
    const successCount = s.edgeIds.length - respErrors.length;
    if (successCount > 0) {
      s.pushParentBanner({
        tone: "info",
        message: `Regenerated ${successCount} household${successCount === 1 ? "" : "s"}`,
        durationMs: INFO_BANNER_DURATION_MS,
      });
    }

    s.onSuccess?.();
    s.router.refresh();
  }

  const confirmLabel = `Regenerate ${edgeRows.length} household${edgeRows.length === 1 ? "" : "s"}`;

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Regenerate selected bills?"
      tone="neutral"
      confirmLabel={
        allSelectedAreManual
          ? "Regenerate"
          : confirmLabel
      }
      onConfirm={
        allSelectedAreManual
          ? async () => {
              throw new Error(
                "All selected rows are manual — nothing to regenerate.",
              );
            }
          : handleConfirm
      }
      body={
        <div className="space-y-3">
          {edgeRows.length > 0 && (
            <section data-testid="regen-multi-edge-section">
              <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                Will be regenerated ({edgeRows.length})
              </h4>
              <ul className="space-y-1">
                {edgeRows.map((r) => (
                  <li
                    key={r.householdId}
                    className="flex items-center justify-between gap-2 text-[13px]"
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-medium text-foreground">
                        {r.householdName}
                      </span>
                      {r.readingSource && (
                        <StatusChip
                          kind="billingLineItemReadingSource"
                          status={r.readingSource}
                        />
                      )}
                    </span>
                    {r.totalAmount != null && (
                      <span className="text-muted-foreground">
                        <Currency value={r.totalAmount} bareNumber />
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {manualRows.length > 0 && (
            <section data-testid="regen-multi-skip-section">
              <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                Will be skipped ({manualRows.length})
              </h4>
              <p className="mb-1 text-[12px] text-muted-foreground">
                Manual readings are per-row only — close this and use the row
                menu to regenerate.
              </p>
              <ul className="space-y-1">
                {manualRows.map((r) => (
                  <li
                    key={r.householdId}
                    className="flex items-center justify-between gap-2 text-[13px]"
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-medium text-foreground">
                        {r.householdName}
                      </span>
                      <StatusChip
                        kind="billingLineItemReadingSource"
                        status="manual"
                      />
                    </span>
                    {r.totalAmount != null && (
                      <span className="text-muted-foreground">
                        <Currency value={r.totalAmount} bareNumber />
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {allSelectedAreManual && (
            <p
              data-testid="regen-multi-all-manual-notice"
              className="text-[12px] text-muted-foreground"
            >
              All selected rows are manual — nothing to regenerate.
            </p>
          )}

          <p className="text-[12px] text-muted-foreground">
            Edge-only — to regenerate manual rows, use the row menu.
          </p>
        </div>
      }
    />
  );
}
