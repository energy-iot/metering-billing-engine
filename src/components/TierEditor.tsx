"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { RateSchedule, TierConfig } from "@/lib/types/database";

export function TierEditor({
  microgridId,
  currency,
  initialSchedule,
}: {
  microgridId: string;
  currency: string;
  initialSchedule: RateSchedule | null;
}) {
  const router = useRouter();
  const supabase = createClient();

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
      if (!confirm("Removing the last tier will leave an empty schedule. Continue?")) {
        return;
      }
    }

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
      return null; // Empty schedule is valid (no tiers)
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

    let saveError;

    if (initialSchedule?.id) {
      const { error: updateError } = await supabase
        .from("rate_schedules")
        .update(payload)
        .eq("id", initialSchedule.id);
      saveError = updateError;
    } else {
      const { error: insertError } = await supabase
        .from("rate_schedules")
        .insert({
          microgrid_id: microgridId,
          ...payload,
        });
      saveError = insertError;
    }

    if (saveError) {
      setError(saveError.message);
      setSaving(false);
      return;
    }

    setSaving(false);
    setSuccess("Rate schedule saved successfully");
    setTimeout(() => setSuccess(null), 3000);
    router.refresh();
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Rate Schedule</h2>
        <button
          onClick={addTier}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
        >
          Add Tier
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {success && (
        <div className="mb-4 rounded-md bg-green-50 p-3 text-sm text-green-700">
          {success}
        </div>
      )}

      {tiers.length === 0 ? (
        <p className="mb-6 text-sm text-gray-500">
          No tiers configured. Add a tier to define the rate schedule.
        </p>
      ) : (
        <div className="mb-6 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="pb-2 pr-4 font-medium text-gray-700">Label</th>
                <th className="pb-2 pr-4 font-medium text-gray-700">
                  Min kWh
                </th>
                <th className="pb-2 pr-4 font-medium text-gray-700">
                  Max kWh
                </th>
                <th className="pb-2 pr-4 font-medium text-gray-700">
                  Rate per kWh ({currency})
                </th>
                <th className="pb-2 font-medium text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((tier, index) => {
                const isLastTier = index === tiers.length - 1;
                return (
                  <tr key={index} className="border-b border-gray-100">
                    <td className="py-3 pr-4">
                      <input
                        type="text"
                        value={tier.label}
                        onChange={(e) =>
                          updateTier(index, { label: e.target.value })
                        }
                        className="w-full rounded-md border border-gray-300 px-2 py-1 text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </td>
                    <td className="py-3 pr-4">
                      <input
                        type="number"
                        value={tier.min_kwh}
                        onChange={(e) =>
                          updateTier(index, {
                            min_kwh: parseFloat(e.target.value) || 0,
                          })
                        }
                        min={1}
                        className="w-24 rounded-md border border-gray-300 px-2 py-1 text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </td>
                    <td className="py-3 pr-4">
                      {isLastTier ? (
                        <span className="inline-block w-24 px-2 py-1 text-gray-500">
                          &infin;
                        </span>
                      ) : (
                        <input
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
                          className="w-24 rounded-md border border-gray-300 px-2 py-1 text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      <input
                        type="number"
                        value={tier.rate_per_kwh}
                        onChange={(e) =>
                          updateTier(index, {
                            rate_per_kwh: parseFloat(e.target.value) || 0,
                          })
                        }
                        min={0}
                        step="any"
                        className="w-28 rounded-md border border-gray-300 px-2 py-1 text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </td>
                    <td className="py-3">
                      <button
                        onClick={() => removeTier(index)}
                        className="rounded-md px-2 py-1 text-sm text-red-600 hover:bg-red-50 hover:text-red-700"
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
          <label className="block text-sm font-medium text-gray-700">
            Service Charge ({currency})
          </label>
          <input
            type="number"
            value={serviceCharge}
            onChange={(e) => setServiceCharge(parseFloat(e.target.value) || 0)}
            min={0}
            step="any"
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Tax Rate (%)
          </label>
          <input
            type="number"
            value={Math.round(taxRate * 100 * 100) / 100}
            onChange={(e) =>
              setTaxRate((parseFloat(e.target.value) || 0) / 100)
            }
            min={0}
            max={100}
            step="any"
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save Rate Schedule"}
      </button>
    </div>
  );
}
