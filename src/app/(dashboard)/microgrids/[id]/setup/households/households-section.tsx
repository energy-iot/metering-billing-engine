"use client";

import * as React from "react";
import type { Device, Household } from "@/lib/types/domain";
import { HouseholdTable, type BillingDeviceOption } from "@/components/HouseholdTable";
import {
  HouseholdWizard,
  type AvailableMeter,
} from "@/components/forms/HouseholdWizard";

// Setup > Households section (D2 / #53, upgraded in UX2 / #74).
//
// Composition:
//   - Renders the existing <HouseholdTable> (full edit/delete/assign flows).
//   - Wraps it with a "+ Add household" button that opens the 4-step wizard
//     (<HouseholdWizard>) — replaces the minimal modal from D2.
//
// The wizard captures all six household fields PLUS a mandatory
// primary_consumption_meter assignment (UX2 requirement) in a single
// atomic RPC call.

type WizardEdge = {
  id: string;
  name: string;
  openems_edge_id: string;
};

type Props = {
  microgridId: string;
  households: Household[];
  devices: Device[];
  primaryDeviceAssignments: Record<string, string>;
  availableMeters: AvailableMeter[];
  /** Enriched device list for the per-row billing-device <select>. */
  billingDevices?: BillingDeviceOption[];
  canManage?: boolean;
  /** #200: edges on this microgrid (used by the wizard's inline discovery). */
  edges?: WizardEdge[];
  /** #200: edges that have NO consumption_meter device yet. */
  edgeIdsWithoutConsumptionMeter?: string[];
};

export function HouseholdsSection({
  microgridId,
  households,
  devices,
  primaryDeviceAssignments,
  availableMeters,
  billingDevices,
  canManage = false,
  edges = [],
  edgeIdsWithoutConsumptionMeter = [],
}: Props) {
  const [wizardOpen, setWizardOpen] = React.useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Households
          </p>
          <h3 className="text-lg font-semibold text-foreground">
            {households.length} household{households.length === 1 ? "" : "s"}
          </h3>
        </div>
        <button
          type="button"
          onClick={() => setWizardOpen(true)}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          + Add household
        </button>
      </div>

      <HouseholdWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        microgridId={microgridId}
        availableMeters={availableMeters}
        edgesSetupHref={`/microgrids/${microgridId}/setup/edges`}
        edges={edges}
        edgeIdsWithoutConsumptionMeter={edgeIdsWithoutConsumptionMeter}
      />

      <HouseholdTable
        microgridId={microgridId}
        households={households}
        devices={devices}
        billingDevices={billingDevices}
        primaryDeviceAssignments={primaryDeviceAssignments}
        canManage={canManage}
        onAdd={() => setWizardOpen(true)}
        microgridEdgesSetupHref={`/microgrids/${microgridId}/setup/edges`}
      />
    </div>
  );
}
