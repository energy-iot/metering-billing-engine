"use client";

/**
 * HouseholdEditDialog — combined Identity / Contact / Billing-device /
 * Address edit modal (#145).
 *
 * Replaces the inline name/phone/email edit and the per-row billing-device
 * <select> previously rendered in HouseholdTable. Create flow remains via
 * <HouseholdWizard> (PM-pinned in #143); this dialog is edit-only.
 *
 * Surface contract:
 *   - Width 640px, mirroring HouseholdWizard
 *   - Save semantics: PATCH /api/households/[id] with the diff of changed
 *     fields only. Includes device_id when the linked device changed.
 *   - device_id semantics: the route reconciles the household_devices link
 *     by deleting any existing primary_consumption_meter row and (when
 *     non-null) inserting the new one. The dialog passes `null` to clear.
 *   - Phone required (#155): primary_phone is mandatory — the payment-link
 *     flow needs WhatsApp delivery. When primary_phone is blank the phone
 *     field flags red (border-destructive ring) and the helper text reads
 *     "Phone is required for payment links (WhatsApp delivery)." Save
 *     remains disabled until the rule passes. primary_email stays optional.
 *   - Cancel-when-dirty: opens neutral <ConfirmDialog tone="neutral">
 *     with the discard prompt. Cancel-while-clean closes immediately.
 *   - Initial focus: display_name (the keystone identity field).
 *
 * Forward-compatibility for #146 (address widening): the address subform is
 * extracted into <AddressSubsection>. When #146 lands the new fields slot
 * in there without disturbing the dialog skeleton or the diff machinery.
 */

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Banner } from "@/components/ui/banner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DeviceSelect, type DeviceOption } from "@/components/ui/device-select";
import { cn } from "@/lib/utils";
import type { Household } from "@/lib/types/domain";

// ── Types ────────────────────────────────────────────────────────────────

export interface HouseholdEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  household: Household;
  /**
   * All consumption_meter devices on this microgrid, including ones already
   * assigned to another household. The dialog filters the *current* device
   * out of the linked-elsewhere set so it isn't disabled in its own picker.
   */
  availableDevices: DeviceOption[];
  /** household_devices.role='primary_consumption_meter' device id, if any. */
  currentDeviceId: string | null;
  /** href to the microgrid's edges discovery page (empty-state CTA). */
  edgesSetupHref: string;
}

type FormState = {
  display_name: string;
  primary_email: string;
  primary_phone: string;
  address_line1: string;
  address_line2: string;
  unit_label: string;
  address_city: string;
  address_region: string;
  address_country: string;
  address_postal_code: string;
  geography_notes: string;
  device_id: string | null;
};

function initialState(h: Household, deviceId: string | null): FormState {
  return {
    display_name: h.display_name ?? "",
    primary_email: h.primary_email ?? "",
    primary_phone: h.primary_phone ?? "",
    address_line1: h.address_line1 ?? "",
    address_line2: h.address_line2 ?? "",
    unit_label: h.unit_label ?? "",
    address_city: h.address_city ?? "",
    address_region: h.address_region ?? "",
    address_country: h.address_country ?? "",
    address_postal_code: h.address_postal_code ?? "",
    geography_notes: h.geography_notes ?? "",
    device_id: deviceId,
  };
}

function isDirty(cur: FormState, init: FormState): boolean {
  return (
    cur.display_name !== init.display_name ||
    cur.primary_email !== init.primary_email ||
    cur.primary_phone !== init.primary_phone ||
    cur.address_line1 !== init.address_line1 ||
    cur.address_line2 !== init.address_line2 ||
    cur.unit_label !== init.unit_label ||
    cur.address_city !== init.address_city ||
    cur.address_region !== init.address_region ||
    cur.address_country !== init.address_country ||
    cur.address_postal_code !== init.address_postal_code ||
    cur.geography_notes !== init.geography_notes ||
    cur.device_id !== init.device_id
  );
}

/** Build the PATCH-diff: only changed fields, with empty strings → null. */
function buildDiff(
  cur: FormState,
  init: FormState
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (cur.display_name !== init.display_name) {
    out.display_name = cur.display_name.trim();
  }
  if (cur.primary_email !== init.primary_email) {
    const v = cur.primary_email.trim();
    out.primary_email = v.length > 0 ? v : null;
  }
  if (cur.primary_phone !== init.primary_phone) {
    // #155: phone is required — canSave blocks the empty case, so we send
    // the trimmed string here (never null). The PATCH route rejects null
    // explicitly as a defense-in-depth check.
    out.primary_phone = cur.primary_phone.trim();
  }
  if (cur.address_line1 !== init.address_line1) {
    const v = cur.address_line1.trim();
    out.address_line1 = v.length > 0 ? v : null;
  }
  if (cur.address_line2 !== init.address_line2) {
    const v = cur.address_line2.trim();
    out.address_line2 = v.length > 0 ? v : null;
  }
  if (cur.unit_label !== init.unit_label) {
    const v = cur.unit_label.trim();
    out.unit_label = v.length > 0 ? v : null;
  }
  if (cur.address_city !== init.address_city) {
    const v = cur.address_city.trim();
    out.address_city = v.length > 0 ? v : null;
  }
  if (cur.address_region !== init.address_region) {
    const v = cur.address_region.trim();
    out.address_region = v.length > 0 ? v : null;
  }
  if (cur.address_country !== init.address_country) {
    const v = cur.address_country.trim();
    out.address_country = v.length > 0 ? v : null;
  }
  if (cur.address_postal_code !== init.address_postal_code) {
    const v = cur.address_postal_code.trim();
    out.address_postal_code = v.length > 0 ? v : null;
  }
  if (cur.geography_notes !== init.geography_notes) {
    const v = cur.geography_notes.trim();
    out.geography_notes = v.length > 0 ? v : null;
  }
  if (cur.device_id !== init.device_id) {
    out.device_id = cur.device_id;
  }
  return out;
}

// ── Component ────────────────────────────────────────────────────────────

const PHONE_HELPER_ID = "hh-edit-phone-helper";
const DEVICE_HELPER_ID = "hh-edit-device-helper";

export function HouseholdEditDialog({
  open,
  onOpenChange,
  household,
  availableDevices,
  currentDeviceId,
  edgesSetupHref,
}: HouseholdEditDialogProps) {
  const router = useRouter();

  const init = React.useMemo(
    () => initialState(household, currentDeviceId),
    [household, currentDeviceId]
  );

  const [state, setState] = React.useState<FormState>(init);
  const [submitting, setSubmitting] = React.useState(false);
  const [topError, setTopError] = React.useState<string | null>(null);
  const [confirmCancelOpen, setConfirmCancelOpen] = React.useState(false);
  const firstFieldRef = React.useRef<HTMLInputElement>(null);

  // Reset form whenever the dialog opens (or the underlying household
  // changes while open).
  React.useEffect(() => {
    if (open) {
      setState(init);
      setSubmitting(false);
      setTopError(null);
    }
  }, [open, init]);

  const dirty = isDirty(state, init);
  const displayNameValid = state.display_name.trim().length > 0;
  // #155: phone is required for Pesapal payment-link delivery (WhatsApp).
  // primary_email stays optional.
  const hasPhone = state.primary_phone.trim().length > 0;
  const canSave = dirty && displayNameValid && hasPhone && !submitting;

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  // The DeviceSelect's "linked to" suffix should NOT appear on the device
  // currently linked to THIS household — otherwise the picker would render
  // its own current value as disabled. We strip linkedToHouseholdName on
  // the matching id.
  const devicesForPicker = React.useMemo<DeviceOption[]>(() => {
    return availableDevices.map((d) =>
      d.id === currentDeviceId ? { ...d, linkedToHouseholdName: null } : d
    );
  }, [availableDevices, currentDeviceId]);

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!canSave) return;
    if (!dirty) {
      onOpenChange(false);
      return;
    }
    setSubmitting(true);
    setTopError(null);
    try {
      const res = await fetch(`/api/households/${household.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildDiff(state, init)),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setTopError(body.error ?? `Could not save (HTTP ${res.status}).`);
        setSubmitting(false);
        return;
      }
      router.refresh();
      onOpenChange(false);
    } catch (err) {
      setTopError(err instanceof Error ? err.message : "Network error.");
      setSubmitting(false);
    }
  }

  function requestClose(next: boolean) {
    if (!next && dirty) {
      setConfirmCancelOpen(true);
      return;
    }
    onOpenChange(next);
  }

  const phoneInvalid = !hasPhone;

  return (
    <>
      <Dialog.Root open={open} onOpenChange={requestClose}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/55" />
          <Dialog.Content
            aria-modal
            aria-describedby="hh-edit-desc"
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              firstFieldRef.current?.focus();
            }}
            className={cn(
              "fixed left-1/2 top-1/2 z-50 w-[640px] max-w-[94%] -translate-x-1/2 -translate-y-1/2",
              "max-h-[92vh] overflow-y-auto rounded-md border border-border bg-card shadow-elev-3 outline-none"
            )}
          >
            {/* top rail */}
            <div aria-hidden="true" className="h-[6px] bg-primary" />

            <div className="px-6 pt-5">
              <Dialog.Title className="text-xl font-semibold tracking-tight text-foreground">
                Edit household
              </Dialog.Title>
              <Dialog.Description
                id="hh-edit-desc"
                className="mt-1 text-[13px] text-muted-foreground"
              >
                Only changed fields are saved. Switch the billing meter at any
                time — historical bills retain their original device link.
              </Dialog.Description>
            </div>

            <form
              onSubmit={handleSubmit}
              className="space-y-5 px-6 pb-2 pt-4"
              noValidate
            >
              {topError && (
                <Banner tone="destructive" title="Could not save">
                  {topError}
                </Banner>
              )}

              {/* IDENTITY */}
              <Section title="Identity">
                <Field
                  id="hh-edit-display-name"
                  label="Display name"
                  required
                  value={state.display_name}
                  onChange={(v) => update("display_name", v)}
                  inputRef={firstFieldRef}
                  ariaInvalid={!displayNameValid}
                />
              </Section>

              {/* CONTACT */}
              <Section
                title="Contact"
                helper="Phone is required for payment links (WhatsApp delivery)."
                helperId={PHONE_HELPER_ID}
                helperTone={phoneInvalid ? "destructive" : "default"}
              >
                <Pair>
                  <Field
                    id="hh-edit-email"
                    label="Primary email"
                    type="email"
                    value={state.primary_email}
                    onChange={(v) => update("primary_email", v)}
                  />
                  <Field
                    id="hh-edit-phone"
                    label="Primary phone"
                    type="tel"
                    required
                    value={state.primary_phone}
                    onChange={(v) => update("primary_phone", v)}
                    describedBy={PHONE_HELPER_ID}
                    ariaInvalid={phoneInvalid}
                  />
                </Pair>
              </Section>

              {/* BILLING DEVICE */}
              <Section
                title="Billing device"
                helper="The consumption meter that produces this household's bill each period. Unassigned households are skipped at billing time."
                helperId={DEVICE_HELPER_ID}
              >
                <DeviceSelect
                  devices={devicesForPicker}
                  value={state.device_id}
                  onChange={(id) => update("device_id", id)}
                  edgesSetupHref={edgesSetupHref}
                  aria-describedby={DEVICE_HELPER_ID}
                  aria-label="Billing device"
                />
              </Section>

              {/* ADDRESS */}
              <AddressSubsection
                state={state}
                update={update}
                disabled={submitting}
              />
            </form>

            <div className="mt-2 flex items-center justify-end gap-2 border-t border-border bg-muted px-6 pb-[18px] pt-[14px]">
              <Dialog.Close asChild>
                <button
                  type="button"
                  disabled={submitting}
                  className="inline-flex h-8 items-center rounded-md px-3.5 text-[13px] font-medium text-foreground hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="button"
                onClick={() => handleSubmit()}
                disabled={!canSave}
                className="inline-flex h-8 items-center rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {submitting ? "Saving…" : "Save changes"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={confirmCancelOpen}
        onOpenChange={setConfirmCancelOpen}
        tone="neutral"
        title="Discard unsaved changes?"
        description="Your edits will be lost."
        confirmLabel="Discard"
        onConfirm={async () => {
          setConfirmCancelOpen(false);
          onOpenChange(false);
        }}
      />
    </>
  );
}

// ── Local primitives ─────────────────────────────────────────────────────

function Section({
  title,
  helper,
  helperId,
  helperTone = "default",
  children,
}: {
  title: string;
  helper?: string;
  helperId?: string;
  helperTone?: "default" | "destructive";
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {children}
      {helper && (
        <p
          id={helperId}
          className={cn(
            "text-xs",
            helperTone === "destructive"
              ? "text-destructive-fg"
              : "text-muted-foreground"
          )}
        >
          {helper}
        </p>
      )}
    </section>
  );
}

function Pair({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  required,
  type = "text",
  placeholder,
  describedBy,
  inputRef,
  ariaInvalid,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  type?: string;
  placeholder?: string;
  describedBy?: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  ariaInvalid?: boolean;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
      >
        {label}
        {required && (
          <>
            <span aria-hidden="true" className="ml-0.5 text-destructive-fg">
              *
            </span>
            <span className="sr-only"> (required)</span>
          </>
        )}
      </label>
      <Input
        id={id}
        ref={inputRef}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        aria-required={required ? "true" : undefined}
        aria-describedby={describedBy}
        aria-invalid={ariaInvalid ? "true" : undefined}
        className={cn(
          ariaInvalid && "border-destructive ring-1 ring-destructive"
        )}
      />
    </div>
  );
}

/**
 * AddressSubsection — widened in #146 to include address_city,
 * address_region, address_country, address_postal_code, geography_notes.
 *
 * Layout (per Designer mockup 02-household-edit-dialog.tsx):
 *   1. Address line 1 — full width
 *   2. Address line 2 — full width
 *   3. City + Region/state — 2-col pair
 *   4. Country + Postal code — 2-col pair
 *   5. Geography notes — full-width textarea, rows=2, last
 *   Unit label — kept in its pre-existing slot (separate row with line 2).
 */
function AddressSubsection({
  state,
  update,
  disabled,
}: {
  state: FormState;
  update: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  disabled: boolean;
}) {
  return (
    <details
      className="group rounded-md border border-border bg-card"
      open
    >
      <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span>Address</span>
        <span
          aria-hidden
          className="text-muted-foreground transition group-open:rotate-180"
        >
          ▾
        </span>
      </summary>
      <fieldset
        disabled={disabled}
        className="space-y-3 border-t border-border px-3 py-4"
      >
        <Field
          id="hh-edit-line1"
          label="Address line 1"
          value={state.address_line1}
          onChange={(v) => update("address_line1", v)}
        />
        <Field
          id="hh-edit-line2"
          label="Address line 2"
          value={state.address_line2}
          onChange={(v) => update("address_line2", v)}
        />
        <Pair>
          <Field
            id="hh-edit-city"
            label="City"
            value={state.address_city}
            onChange={(v) => update("address_city", v)}
            placeholder="Kampala"
          />
          <Field
            id="hh-edit-region"
            label="Region / state"
            value={state.address_region}
            onChange={(v) => update("address_region", v)}
            placeholder="Central Region"
          />
        </Pair>
        <Pair>
          <Field
            id="hh-edit-country"
            label="Country"
            value={state.address_country}
            onChange={(v) => update("address_country", v)}
            placeholder="Uganda"
          />
          <Field
            id="hh-edit-postal"
            label="Postal code"
            value={state.address_postal_code}
            onChange={(v) => update("address_postal_code", v)}
            placeholder="00256"
          />
        </Pair>
        <div>
          <label
            htmlFor="hh-edit-geography-notes"
            className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Geography notes
          </label>
          <textarea
            id="hh-edit-geography-notes"
            rows={2}
            value={state.geography_notes}
            onChange={(e) => update("geography_notes", e.target.value)}
            placeholder="Directions, landmarks, or access notes"
            disabled={disabled}
            className="flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>
        <Field
          id="hh-edit-unit-label"
          label="Unit label"
          value={state.unit_label}
          onChange={(v) => update("unit_label", v)}
        />
      </fieldset>
    </details>
  );
}
