"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { RateSchedule, TierConfig } from "@/lib/types/domain";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Banner } from "@/components/ui/banner";
import { Input } from "@/components/ui/input";
import { Currency } from "@/components/format/currency";
import { EmptyState } from "@/components/ui/empty-state";
import { calculateTieredCost } from "@/lib/billing/calculations";

const SAMPLE_USAGE_KWH = 100;

export function TierEditor({
  microgridId,
  currency,
  initialSchedule,
  canManage = false,
}: {
  microgridId: string;
  currency: string;
  initialSchedule: RateSchedule | null;
  /** Whether the current user can manage the rate schedule. Defaults to false. */
  canManage?: boolean;
}) {
  const router = useRouter();

  const [tiers, setTiers] = useState<TierConfig[]>(
    initialSchedule?.tiers ?? []
  );
  const [serviceCharge, setServiceCharge] = useState<number>(
    initialSchedule?.service_charge ?? 0
  );
  const [taxRate, setTaxRate] = useState<number>(
    initialSchedule?.tax_rate ?? 0
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Last-tier warning dialog state
  const [lastTierDialogOpen, setLastTierDialogOpen] = useState(false);
  const [pendingRemoveIndex, setPendingRemoveIndex] = useState<number | null>(null);

  function updateTier(index: number, updates: Partial<TierConfig>) {
    setTiers((prev) =>
      prev.map((tier, i) => (i === index ? { ...tier, ...updates } : tier))
    );
  }

  function addTier() {
    setTiers((prev) => {
      const updated = [...prev];

      // If there are existing tiers, set the old last tier's max_kwh
      if (updated.length > 0) {
        const lastTier = updated[updated.length - 1];
        if (lastTier.max_kwh === null) {
          updated[updated.length - 1] = {
            ...lastTier,
            max_kwh: lastTier.min_kwh + 49,
          };
        }
      }

      const newMinKwh =
        updated.length > 0
          ? (updated[updated.length - 1].max_kwh ?? 0) + 1
          : 1;

      return [
        ...updated,
        {
          label: `Tier ${updated.length + 1}`,
          min_kwh: newMinKwh,
          max_kwh: null,
          rate_per_kwh: 0,
        },
      ];
    });
  }

  function removeTier(index: number) {
    if (tiers.length === 1) {
      setPendingRemoveIndex(index);
      setLastTierDialogOpen(true);
      return;
    }
    doRemoveTier(index);
  }

  async function handleLastTierConfirm() {
    if (pendingRemoveIndex !== null) {
      doRemoveTier(pendingRemoveIndex);
      setPendingRemoveIndex(null);
    }
  }

  function doRemoveTier(index: number) {
    setTiers((prev) => {
      const updated = prev.filter((_, i) => i !== index);
      // Ensure the new last tier has max_kwh = null
      if (updated.length > 0) {
        updated[updated.length - 1] = {
          ...updated[updated.length - 1],
          max_kwh: null,
        };
      }
      return updated;
    });
  }

  function validate(): string | null {
    if (tiers.length === 0) {
      return "At least one tier is required";
    }

    for (let i = 0; i < tiers.length; i++) {
      const tier = tiers[i];

      if (tier.rate_per_kwh <= 0) {
        return `${tier.label}: Rate per kWh must be greater than 0`;
      }

      if (tier.min_kwh <= 0) {
        return `${tier.label}: Min kWh must be greater than 0`;
      }

      const isLastTier = i === tiers.length - 1;

      if (!isLastTier && tier.max_kwh === null) {
        return `${tier.label}: Only the last tier can have unlimited max kWh`;
      }

      if (tier.max_kwh !== null && tier.max_kwh <= tier.min_kwh) {
        return `${tier.label}: Max kWh must be greater than Min kWh`;
      }

      // Check contiguity with previous tier
      if (i > 0) {
        const prevTier = tiers[i - 1];
        if (prevTier.max_kwh !== null && tier.min_kwh !== prevTier.max_kwh + 1) {
          return `${tier.label}: Min kWh must be ${prevTier.max_kwh! + 1} (contiguous with ${prevTier.label})`;
        }
      }
    }

    if (serviceCharge < 0) {
      return "Service charge must be 0 or greater";
    }

    if (taxRate < 0 || taxRate > 1) {
      return "Tax rate must be between 0% and 100%";
    }

    return null;
  }

  async function handleSave() {
    setError(null);
    setSuccess(null);

    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);

    const payload = {
      tiers,
      service_charge: serviceCharge,
      tax_rate: taxRate,
    };

    let savedSchedule: RateSchedule | null = null;
    let saveErrorMessage: string | null = null;

    if (initialSchedule?.id) {
      // PUT — update existing schedule via API route
      const res = await fetch(`/api/rate-schedules/${initialSchedule.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        savedSchedule = (await res.json()) as RateSchedule;
      } else {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        saveErrorMessage = (body as { error?: string }).error ?? "Failed to save";
      }
    } else {
      // POST — create new schedule via API route
      const res = await fetch("/api/rate-schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ microgrid_id: microgridId, ...payload }),
      });
      if (res.ok) {
        savedSchedule = (await res.json()) as RateSchedule;
      } else {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        saveErrorMessage = (body as { error?: string }).error ?? "Failed to save";
      }
    }

    setSaving(false);

    if (saveErrorMessage) {
      setError(saveErrorMessage);
      return;
    }

    // Re-seed state from the server-persisted values
    if (savedSchedule) {
      setTiers(savedSchedule.tiers);
      setServiceCharge(savedSchedule.service_charge);
      setTaxRate(savedSchedule.tax_rate);
    }

    setSuccess("Rate schedule saved successfully");
    setTimeout(() => setSuccess(null), 3000);
    router.refresh();
  }

  // Sample preview calculation — always safe with tiers=[]
  const preview = calculateTieredCost(SAMPLE_USAGE_KWH, tiers, serviceCharge, taxRate);

  return (
    <div className="space-y-6">
      {/* Mid-year amendment caveat banner */}
      <Banner tone="warn" title="Rate changes apply to future periods only.">
        {'Closed periods preserve their snapshotted rates; only open drafts re-price.'}
      </Banner>

      <div className="rounded-lg border border-border bg-card p-6">
        {/* Last-tier warning ConfirmDialog */}
        <ConfirmDialog
          open={lastTierDialogOpen}
          onOpenChange={setLastTierDialogOpen}
          title="Remove last tier?"
          description="Removing the last tier will leave an empty schedule. Continue?"
          confirmLabel="Remove"
          tone="neutral"
          onConfirm={handleLastTierConfirm}
        />

        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">Rate Schedule</h2>
          <button
            onClick={addTier}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
          >
            Add Tier
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-md bg-destructive-muted p-3 text-sm text-destructive-fg">
            {error}
          </div>
        )}

        {success && (
          <div className="mb-4 rounded-md bg-success-muted p-3 text-sm text-success-fg">
            {success}
          </div>
        )}

        {tiers.length === 0 ? (
          <div className="mb-6">
            <EmptyState
              tone="warn"
              eyebrow="Rate schedule"
              title="Set up the rate schedule"
              body={
                <>
                  Tiers define the kWh price bands — e.g. the first 50 kWh at
                  one rate, the next 100 at a higher rate. Without tiers, bills
                  come out zero.
                </>
              }
              cta={
                canManage ? (
                  <button
                    type="button"
                    onClick={addTier}
                    className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
                  >
                    + Add first tier
                  </button>
                ) : undefined
              }
              footnote={
                !canManage
                  ? "Ask a super admin to configure the rate schedule for this microgrid."
                  : undefined
              }
              className="border-0 shadow-none bg-transparent p-0"
            />
          </div>
        ) : (
          <div className="mb-6 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="pb-2 pr-4 font-medium text-muted-foreground">Label</th>
                  <th className="pb-2 pr-4 font-medium text-muted-foreground">
                    Min kWh
                  </th>
                  <th className="pb-2 pr-4 font-medium text-muted-foreground">
                    Max kWh
                  </th>
                  <th className="pb-2 pr-4 font-medium text-muted-foreground">
                    Rate per kWh ({currency})
                  </th>
                  <th className="pb-2 font-medium text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody>
                {tiers.map((tier, index) => {
                  const isLastTier = index === tiers.length - 1;
                  return (
                    <tr key={index} className="border-b border-border">
                      <td className="py-3 pr-4">
                        <Input
                          type="text"
                          value={tier.label}
                          onChange={(e) =>
                            updateTier(index, { label: e.target.value })
                          }
                          className="w-full"
                        />
                      </td>
                      <td className="py-3 pr-4">
                        <Input
                          type="number"
                          value={tier.min_kwh}
                          onChange={(e) =>
                            updateTier(index, {
                              min_kwh: parseFloat(e.target.value) || 0,
                            })
                          }
                          min={1}
                          className="w-24"
                        />
                      </td>
                      <td className="py-3 pr-4">
                        {isLastTier ? (
                          <span className="inline-block w-24 px-2 py-1 text-muted-foreground">
                            &infin;
                          </span>
                        ) : (
                          <Input
                            type="number"
                            value={tier.max_kwh ?? ""}
                            onChange={(e) =>
                              updateTier(index, {
                                max_kwh: e.target.value
                                  ? parseFloat(e.target.value)
                                  : null,
                              })
                            }
                            min={tier.min_kwh + 1}
                            className="w-24"
                          />
                        )}
                      </td>
                      <td className="py-3 pr-4">
                        <Input
                          type="number"
                          value={tier.rate_per_kwh}
                          onChange={(e) =>
                            updateTier(index, {
                              rate_per_kwh: parseFloat(e.target.value) || 0,
                            })
                          }
                          min={0}
                          step="any"
                          className="w-28"
                        />
                      </td>
                      <td className="py-3">
                        <button
                          onClick={() => removeTier(index)}
                          className="rounded-md px-2 py-1 text-sm text-destructive hover:bg-destructive-muted"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-foreground">
              Service Charge ({currency})
            </label>
            <Input
              type="number"
              value={serviceCharge}
              onChange={(e) => setServiceCharge(parseFloat(e.target.value) || 0)}
              min={0}
              step="any"
              className="mt-1"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground">
              Tax Rate (%)
            </label>
            <Input
              type="number"
              value={Math.round(taxRate * 100 * 100) / 100}
              onChange={(e) =>
                setTaxRate((parseFloat(e.target.value) || 0) / 100)
              }
              min={0}
              max={100}
              step="any"
              className="mt-1"
            />
          </div>
        </div>

        {/* Sample preview */}
        <div className="mb-6 rounded-md border border-border bg-muted p-4">
          <p className="mb-2 text-sm font-medium text-foreground">
            Example: {SAMPLE_USAGE_KWH} kWh &rarr;{" "}
            <Currency value={preview.totalAmount} className="font-semibold" />
          </p>
          {preview.tierBreakdown.length > 0 && (
            <table className="w-full text-left text-xs text-muted-foreground">
              <tbody>
                {preview.tierBreakdown.map((row, i) => (
                  <tr key={i}>
                    <td className="py-0.5 pr-4">{row.label}</td>
                    <td className="py-0.5 pr-4">{row.kwh} kWh</td>
                    <td className="py-0.5">
                      <Currency value={row.amount} />
                    </td>
                  </tr>
                ))}
                {preview.serviceCharge > 0 && (
                  <tr>
                    <td className="py-0.5 pr-4">Service charge</td>
                    <td className="py-0.5 pr-4"></td>
                    <td className="py-0.5">
                      <Currency value={preview.serviceCharge} />
                    </td>
                  </tr>
                )}
                {preview.taxAmount > 0 && (
                  <tr>
                    <td className="py-0.5 pr-4">Tax</td>
                    <td className="py-0.5 pr-4"></td>
                    <td className="py-0.5">
                      <Currency value={preview.taxAmount} />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
          {preview.tierBreakdown.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Service charge{preview.serviceCharge > 0 ? ": " : ""}{preview.serviceCharge > 0 ? "" : " only"}{" "}
              {preview.serviceCharge > 0 && (
                <Currency value={preview.serviceCharge} />
              )}
              {preview.taxAmount > 0 && (
                <> + tax: <Currency value={preview.taxAmount} /></>
              )}
            </p>
          )}
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save Rate Schedule"}
        </button>
      </div>
    </div>
  );
}
