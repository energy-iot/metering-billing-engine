"use client";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Device, Household } from "@/lib/types/domain";
import { HouseholdTable } from "@/components/HouseholdTable";
import { cn } from "@/lib/utils";

// Setup > Households section (D2 / #53).
//
// Composition:
//   - Renders the existing <HouseholdTable> (full edit/delete/assign flows).
//   - Wraps it with a richer "+ Add household" button that opens a modal
//     with all six AB fields, not just the inline add-row form in
//     HouseholdTable (which only collects name/phone/email).
//
// AB household fields (supabase/migrations/00001_schema.sql:170):
//   display_name, primary_phone, primary_email,
//   address_line1, address_line2, unit_label.
//
// The Wizard pattern (4-step, meter assignment) is deferred to a future
// ticket per the Out-of-Scope line in this ticket.

type Props = {
  microgridId: string;
  households: Household[];
  devices: Device[];
  primaryDeviceAssignments: Record<string, string>;
};

export function HouseholdsSection({
  microgridId,
  households,
  devices,
  primaryDeviceAssignments,
}: Props) {
  const router = useRouter();
  const supabase = createClient();
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [displayName, setDisplayName] = React.useState("");
  const [primaryPhone, setPrimaryPhone] = React.useState("");
  const [primaryEmail, setPrimaryEmail] = React.useState("");
  const [addressLine1, setAddressLine1] = React.useState("");
  const [addressLine2, setAddressLine2] = React.useState("");
  const [unitLabel, setUnitLabel] = React.useState("");

  function resetForm() {
    setDisplayName("");
    setPrimaryPhone("");
    setPrimaryEmail("");
    setAddressLine1("");
    setAddressLine2("");
    setUnitLabel("");
    setError(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!displayName.trim()) {
      setError("Display name is required");
      return;
    }

    setSaving(true);
    const { error: insertError } = await supabase.from("households").insert({
      microgrid_id: microgridId,
      display_name: displayName.trim(),
      primary_phone: primaryPhone.trim() || null,
      primary_email: primaryEmail.trim() || null,
      address_line1: addressLine1.trim() || null,
      address_line2: addressLine2.trim() || null,
      unit_label: unitLabel.trim() || null,
    });
    setSaving(false);

    if (insertError) {
      setError(insertError.message);
      return;
    }

    resetForm();
    setOpen(false);
    router.refresh();
  }

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
        <Dialog.Root
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) resetForm();
          }}
        >
          <Dialog.Trigger asChild>
            <button className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90">
              + Add household
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/55 data-[state=open]:animate-in data-[state=closed]:animate-out" />
            <Dialog.Content
              aria-modal
              className={cn(
                "fixed left-1/2 top-1/2 z-50 w-[520px] max-w-[94%] -translate-x-1/2 -translate-y-1/2",
                "overflow-hidden rounded-md border border-border bg-card shadow-elev-3 outline-none",
              )}
            >
              <div aria-hidden="true" className="h-[6px] bg-primary" />
              <div className="space-y-4 px-6 pb-5 pt-5">
                <div>
                  <Dialog.Title className="text-base font-semibold text-foreground">
                    Add household
                  </Dialog.Title>
                  <Dialog.Description className="mt-1 text-xs text-muted-foreground">
                    Basic contact + address details. Primary meter assignment
                    happens from the household row once it&apos;s created.
                  </Dialog.Description>
                </div>

                {error && (
                  <div
                    role="alert"
                    className="rounded-md bg-destructive-muted p-3 text-sm text-destructive-fg"
                  >
                    {error}
                  </div>
                )}

                <form onSubmit={handleSave} className="space-y-3">
                  <Field
                    label="Display name"
                    required
                    value={displayName}
                    onChange={setDisplayName}
                    placeholder="Block A, Unit 1"
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <Field
                      label="Primary phone"
                      value={primaryPhone}
                      onChange={setPrimaryPhone}
                      placeholder="+256 …"
                    />
                    <Field
                      label="Primary email"
                      value={primaryEmail}
                      onChange={setPrimaryEmail}
                      placeholder="optional"
                      type="email"
                    />
                  </div>
                  <Field
                    label="Address line 1"
                    value={addressLine1}
                    onChange={setAddressLine1}
                    placeholder="Plot 14, Kisakye Ln"
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <Field
                      label="Address line 2"
                      value={addressLine2}
                      onChange={setAddressLine2}
                      placeholder="Block A"
                    />
                    <Field
                      label="Unit label"
                      value={unitLabel}
                      onChange={setUnitLabel}
                      placeholder="Unit 1"
                    />
                  </div>

                  <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
                    <Dialog.Close asChild>
                      <button
                        type="button"
                        className="rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground hover:bg-muted"
                      >
                        Cancel
                      </button>
                    </Dialog.Close>
                    <button
                      type="submit"
                      disabled={saving || !displayName.trim()}
                      className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {saving ? "Saving…" : "Add household"}
                    </button>
                  </div>
                </form>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>

      <HouseholdTable
        microgridId={microgridId}
        households={households}
        devices={devices}
        primaryDeviceAssignments={primaryDeviceAssignments}
      />
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  required,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  required?: boolean;
  type?: "text" | "email";
}) {
  return (
    <label className="block">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </span>
      <input
        type={type}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 block w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground shadow-elev-1 focus:outline-none focus:ring-2 focus:ring-ring"
      />
    </label>
  );
}
