"use client";

import * as React from "react";
import type { Device, Household } from "@/lib/types/domain";
import { HouseholdTable } from "@/components/HouseholdTable";
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

type Props = {
  microgridId: string;
  households: Household[];
  devices: Device[];
  primaryDeviceAssignments: Record<string, string>;
  availableMeters: AvailableMeter[];
  canManage?: boolean;
};

export function HouseholdsSection({
  microgridId,
  households,
  devices,
  primaryDeviceAssignments,
  availableMeters,
  canManage = false,
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
      />

      <HouseholdTable
        microgridId={microgridId}
        households={households}
        devices={devices}
        primaryDeviceAssignments={primaryDeviceAssignments}
        canManage={canManage}
        onAdd={() => setWizardOpen(true)}
      />
    </div>
  );
}
