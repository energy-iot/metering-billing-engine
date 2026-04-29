"use client";

/**
 * HouseholdWizard — 4-step Add-Household flow (UX2 / #74).
 *
 * Replaces the minimal modal from D2 (#53). Captures all household fields
 * PLUS a mandatory primary_consumption_meter assignment in a single
 * transactional RPC call (fn_create_household_with_meter).
 *
 * Steps:
 *   1. Basics   — display_name (required), primary_phone, primary_email
 *   2. Address  — address_line1, address_line2, unit_label (all optional)
 *   3. Meter    — RadioGroup of available consumption_meter devices
 *   4. Review   — read-only summary, submit button
 *
 * The wizard is rendered inside a Radix Dialog; the caller owns the open/close
 * state. On successful save it calls router.refresh() + onOpenChange(false).
 *
 * Available-meters feed: pre-fetched server-side in the wrapping page and
 * passed in as `availableMeters`. Do NOT refetch from the browser — the
 * Supabase JS client cannot express the `NOT IN (subquery)` clause cleanly
 * via PostgREST, and keeping it server-side means no leaked org data.
 */

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Banner } from "@/components/ui/banner";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { RadioCard } from "@/components/ui/radio-card";
import { StatusChip } from "@/components/ui/status-chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { humanReadable } from "@/lib/openems/device-descriptions";
import type { DeviceType } from "@/lib/types/domain";
import {
  DiscoverMeterInline,
  type DiscoverMeterInlineEdge,
} from "@/components/forms/DiscoverMeterInline";

// ── Types ────────────────────────────────────────────────────────────────

/**
 * Shape of an available-meter row passed from the server component.
 *
 * Widened in #145 to include `edge_id` (required by `<DeviceSelect>` for
 * grouping by edge) and `linked_household_name` (rendered as a
 * "(linked: …)" suffix on already-assigned consumption meters when surfaced
 * in `<DeviceSelect>`). The wizard's StepMeter still filters out linked
 * meters at the call site, so AvailableMeter populates `linked_household_name`
 * with `null` for the wizard's own usage but is shaped for cross-surface
 * reuse in the Household Edit dialog.
 */
export type AvailableMeter = {
  id: string;
  name: string;
  device_type: DeviceType;
  edge_id: string;
  edge_name: string;
  linked_household_name: string | null;
};

export interface HouseholdWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  microgridId: string;
  availableMeters: AvailableMeter[];
  /** Route to the edges discovery page — surfaced in the empty-state banner. */
  edgesSetupHref: string;
  /**
   * Edges on this microgrid (#200). Used by `<DiscoverMeterInline>` for the
   * inline edge picker + discovery scope.
   */
  edges?: DiscoverMeterInlineEdge[];
  /**
   * IDs of edges on this microgrid that have NO `consumption_meter` device
   * yet (#200). Used to default-pre-select the most-likely edge in the
   * inline discovery section.
   */
  edgeIdsWithoutConsumptionMeter?: string[];
}

type Step = 1 | 2 | 3 | 4;

type FormState = {
  display_name: string;
  primary_phone: string;
  primary_email: string;
  address_line1: string;
  address_line2: string;
  unit_label: string;
  address_city: string;
  address_region: string;
  address_country: string;
  address_postal_code: string;
  geography_notes: string;
  device_id: string;
  /**
   * #158: when true, Step 3 surfaces no meter picker — the household will
   * be created without a primary_consumption_meter link and Aaron enters
   * usage manually each period from the BillingTable. Step 3 is treated as
   * valid regardless of meter count when this is set.
   */
  no_meter: boolean;
  // PDF3 (#205) — household PDF-invoice identity fields. account_number,
  // meter_serial are optional (empty-string → null on submit). meter_type /
  // customer_type are NOT NULL on the column; EMPTY_STATE seeds them with
  // the DB defaults so a save without edits produces canonical values.
  account_number: string;
  meter_serial: string;
  meter_type: string;
  customer_type: "residential" | "commercial";
};

const EMPTY_STATE: FormState = {
  display_name: "",
  primary_phone: "",
  primary_email: "",
  address_line1: "",
  address_line2: "",
  unit_label: "",
  address_city: "",
  address_region: "",
  address_country: "",
  address_postal_code: "",
  geography_notes: "",
  device_id: "",
  no_meter: false,
  // PDF3 (#205) defaults — mirror the PDF1a column DEFAULTs so a "Save with
  // no edits" produces the canonical values without relying on the
  // RPC-side COALESCE alone.
  account_number: "",
  meter_serial: "",
  meter_type: "Smart Submeter",
  customer_type: "residential",
};

const STEP_LABELS: Record<Step, string> = {
  1: "Basics",
  2: "Address",
  3: "Meter",
  4: "Review",
};

// ── Validation ────────────────────────────────────────────────────────────

function isStepValid(step: Step, state: FormState, meterCount: number): boolean {
  switch (step) {
    case 1:
      // #155: phone is required so Pesapal payment links can always be
      // delivered via WhatsApp without falling back to manual lookup.
      return (
        state.display_name.trim().length > 0 &&
        state.primary_phone.trim().length > 0
      );
    case 2:
      // All fields optional.
      return true;
    case 3:
      // #158: when no_meter is checked, Step 3 is valid regardless of
      // meter count or device_id (the household will bill manually).
      if (state.no_meter) return true;
      // Otherwise: must pick one of the available meters. Empty-state (zero
      // meters) can never satisfy this — Save is disabled at the caller.
      return meterCount > 0 && state.device_id.length > 0;
    case 4:
      // Review folds rules from #155 (phone-required) and #158 (no-meter
      // alternative path): step1 must pass AND step2 trivially passes AND
      // either no_meter is set OR a valid meter is picked.
      return (
        state.display_name.trim().length > 0 &&
        state.primary_phone.trim().length > 0 &&
        (state.no_meter ||
          (meterCount > 0 && state.device_id.length > 0))
      );
  }
}

function hasAnyData(state: FormState): boolean {
  // PDF3 (#205): meter_type / customer_type are seeded to canonical defaults
  // in EMPTY_STATE, so we compare against those literals to detect "user
  // changed something". account_number / meter_serial both start as "" so a
  // non-empty trim signals user edits.
  return (
    state.display_name.trim().length > 0 ||
    state.primary_phone.trim().length > 0 ||
    state.primary_email.trim().length > 0 ||
    state.address_line1.trim().length > 0 ||
    state.address_line2.trim().length > 0 ||
    state.unit_label.trim().length > 0 ||
    state.address_city.trim().length > 0 ||
    state.address_region.trim().length > 0 ||
    state.address_country.trim().length > 0 ||
    state.address_postal_code.trim().length > 0 ||
    state.geography_notes.trim().length > 0 ||
    state.device_id.length > 0 ||
    state.no_meter ||
    state.account_number.trim().length > 0 ||
    state.meter_serial.trim().length > 0 ||
    state.meter_type.trim() !== "Smart Submeter" ||
    state.customer_type !== "residential"
  );
}

// ── Component ────────────────────────────────────────────────────────────

export function HouseholdWizard({
  open,
  onOpenChange,
  microgridId,
  availableMeters: availableMetersProp,
  edgesSetupHref,
  edges = [],
  edgeIdsWithoutConsumptionMeter = [],
}: HouseholdWizardProps) {
  const router = useRouter();

  const [step, setStep] = React.useState<Step>(1);
  const [visited, setVisited] = React.useState<Set<Step>>(() => new Set([1]));
  const [state, setState] = React.useState<FormState>(EMPTY_STATE);
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [confirmCancelOpen, setConfirmCancelOpen] = React.useState(false);
  // #200: `availableMeters` is a prop seeded from the server, but inline
  // discovery (DiscoverMeterInline) appends new meters mid-flow. Promote
  // to local state so all reads see the augmented list.
  const [availableMeters, setAvailableMeters] = React.useState<AvailableMeter[]>(
    availableMetersProp
  );

  // Refs for focus management — each step's first required/focusable field.
  const step1FirstFieldRef = React.useRef<HTMLInputElement>(null);
  const step2FirstFieldRef = React.useRef<HTMLInputElement>(null);
  // #158: step3FirstFieldRef may resolve to a checkbox (no-meter info path)
  // or a radio (meter-pick path). Type it as the union accordingly.
  const step3FirstFieldRef = React.useRef<HTMLButtonElement | HTMLInputElement | null>(null);
  const step4FirstElementRef = React.useRef<HTMLButtonElement>(null);

  // Reset wizard state when `open` flips false → true (entering a fresh
  // wizard session). Split out from the prop-resync effect below: keeping
  // `availableMetersProp` as a dep here would wipe the user's in-progress
  // form state every time the parent server component re-renders with a
  // new array reference (e.g. after `router.refresh()` from
  // `handleDevicePersisted`). Two effects let prop refreshes update the
  // local meter list without touching step/state/visited.
  React.useEffect(() => {
    if (open) {
      setStep(1);
      setVisited(new Set([1]));
      setState(EMPTY_STATE);
      setSubmitting(false);
      setSubmitError(null);
      setConfirmCancelOpen(false);
      // #200: re-seed availableMeters from the prop so any in-flight
      // appended-via-discovery devices from a prior open are dropped on
      // re-open.
      setAvailableMeters(availableMetersProp);
    }
    // Intentionally only depend on `open` — we want this to run on the
    // open transition, not on prop changes mid-flow. The prop is read at
    // open time to seed `availableMeters`; subsequent prop refreshes are
    // handled by the dedicated effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // #200: re-sync local availableMeters when the parent server component
  // hands us a new prop reference (e.g. after `router.refresh()`).
  // Dedupes against in-flight inline-discovery appends so we don't drop
  // freshly persisted devices that haven't yet appeared in the prop.
  React.useEffect(() => {
    if (!open) return;
    setAvailableMeters((prev) => {
      const byId = new Map(availableMetersProp.map((m) => [m.id, m]));
      // Append any locally-known meters that aren't in the new prop yet.
      for (const m of prev) {
        if (!byId.has(m.id)) {
          byId.set(m.id, m);
        }
      }
      return Array.from(byId.values());
    });
  }, [availableMetersProp, open]);

  // #200: handle a freshly persisted device from inline discovery.
  // Update ordering rationale (per ticket #200 AC #11):
  //   1. setAvailableMeters → dedup + append → immediate UI feedback.
  //   2. setState → set device_id to the new meter's id → also auto-batched.
  //   3. router.refresh() → fire-and-forget, syncs server-rendered ancestors
  //      (HouseholdTable's billingDevices, primaryDeviceAssignments).
  //
  // React 18 auto-batches setState calls in event handlers AND across
  // awaited boundaries when fired in the same post-await tick. No
  // `flushSync` or `unstable_batchedUpdates` is needed — do NOT add one
  // here.
  const handleDevicePersisted = React.useCallback(
    (newMeter: AvailableMeter) => {
      setAvailableMeters((prev) => {
        const existing = prev.find((m) => m.id === newMeter.id);
        if (existing) {
          // Already in the list — keep existing entry (preserve ordering),
          // don't reorder on re-pick.
          return prev;
        }
        return [...prev, newMeter];
      });
      setState((prev) => ({ ...prev, device_id: newMeter.id }));
      router.refresh();
    },
    [router]
  );

  // Focus management — on every step change, move focus to the first
  // focusable field of the new step. Run in a layout effect so the element
  // is in the DOM before we try to focus.
  React.useLayoutEffect(() => {
    if (!open) return;
    const target =
      step === 1
        ? step1FirstFieldRef.current
        : step === 2
          ? step2FirstFieldRef.current
          : step === 3
            ? step3FirstFieldRef.current
            : step4FirstElementRef.current;
    // Focus in the next microtask to ensure Radix Dialog didn't snap focus
    // elsewhere after mounting.
    queueMicrotask(() => {
      target?.focus();
    });
  }, [step, open]);

  const update = React.useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) => {
      setState((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  const goToStep = React.useCallback((next: Step) => {
    setVisited((prev) => {
      const nextVisited = new Set(prev);
      nextVisited.add(next);
      return nextVisited;
    });
    setStep(next);
  }, []);

  const handleNext = React.useCallback(() => {
    if (step >= 4) return;
    if (!isStepValid(step, state, availableMeters.length)) return;
    goToStep((step + 1) as Step);
  }, [step, state, availableMeters.length, goToStep]);

  const handleBack = React.useCallback(() => {
    if (step <= 1) return;
    goToStep((step - 1) as Step);
  }, [step, goToStep]);

  const handleCancelClick = React.useCallback(() => {
    if (hasAnyData(state)) {
      setConfirmCancelOpen(true);
    } else {
      onOpenChange(false);
    }
  }, [state, onOpenChange]);

  const confirmCancel = React.useCallback(async () => {
    setConfirmCancelOpen(false);
    onOpenChange(false);
  }, [onOpenChange]);

  const handleSubmit = React.useCallback(async () => {
    setSubmitError(null);
    if (!isStepValid(4, state, availableMeters.length)) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/households/with-meter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          microgrid_id: microgridId,
          display_name: state.display_name.trim(),
          // #155: phone is required and validated upstream by isStepValid.
          primary_phone: state.primary_phone.trim(),
          primary_email: state.primary_email.trim() || null,
          address_line1: state.address_line1.trim() || null,
          address_line2: state.address_line2.trim() || null,
          unit_label: state.unit_label.trim() || null,
          address_city: state.address_city.trim() || null,
          address_region: state.address_region.trim() || null,
          address_country: state.address_country.trim() || null,
          address_postal_code: state.address_postal_code.trim() || null,
          geography_notes: state.geography_notes.trim() || null,
          // #158: send null when the user opted out of meter assignment.
          // The route distinguishes the two paths and dispatches to
          // fn_create_household vs fn_create_household_with_meter.
          device_id: state.no_meter ? null : state.device_id,
          // PDF3 (#205) — household PDF-invoice identity fields.
          // Optional ones: empty-string → null. Required-on-column ones
          // (meter_type / customer_type) always send the form's value
          // (EMPTY_STATE seeds canonical defaults).
          account_number: state.account_number.trim() || null,
          meter_serial: state.meter_serial.trim() || null,
          meter_type: state.meter_type.trim() || "Smart Submeter",
          customer_type: state.customer_type,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSubmitError(body.error ?? `Could not save (HTTP ${res.status}).`);
        setSubmitting(false);
        return;
      }
      router.refresh();
      onOpenChange(false);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Network error. Please retry."
      );
      setSubmitting(false);
    }
  }, [state, availableMeters.length, microgridId, router, onOpenChange]);

  const canProceed = isStepValid(step, state, availableMeters.length);
  const noMeters = availableMeters.length === 0;
  // #158: when no_meter is checked, the empty-meters condition no longer
  // blocks Next/Save — the household path doesn't need a device.
  const blockedByNoMeters = noMeters && !state.no_meter;
  const canSave = isStepValid(4, state, availableMeters.length);

  // Pre-computed completed-set for the progress indicator. A step is
  // "completed" when it has been visited AND its fields are valid.
  const completedSteps = React.useMemo<Set<Step>>(() => {
    const out = new Set<Step>();
    ([1, 2, 3, 4] as const).forEach((s) => {
      if (visited.has(s) && isStepValid(s, state, availableMeters.length)) {
        out.add(s);
      }
    });
    return out;
  }, [visited, state, availableMeters.length]);

  return (
    <>
      <Dialog.Root
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            // Don't close via overlay click when data is present — route
            // through the Cancel-guard flow instead.
            if (hasAnyData(state)) {
              setConfirmCancelOpen(true);
              return;
            }
          }
          onOpenChange(next);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/55" />
          <Dialog.Content
            aria-modal
            className={cn(
              "fixed left-1/2 top-1/2 z-50 w-[640px] max-w-[94%] -translate-x-1/2 -translate-y-1/2",
              "max-h-[92vh] overflow-y-auto rounded-md border border-border bg-card shadow-elev-3 outline-none"
            )}
          >
            {/* top rail */}
            <div aria-hidden="true" className="h-[6px] bg-primary" />

            <div className="px-6 pt-5">
              <Dialog.Title className="text-xl font-semibold tracking-tight text-foreground">
                Add household
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] text-muted-foreground">
                Four quick steps. You&apos;ll assign a primary meter in step 3
                so billing starts on the next period.
              </Dialog.Description>
            </div>

            {/* Progress indicator */}
            <StepIndicator
              currentStep={step}
              completedSteps={completedSteps}
              visitedSteps={visited}
              onStepClick={(s) => {
                // Only jump-back to completed (visited AND valid) steps.
                if (s < step && completedSteps.has(s)) {
                  goToStep(s);
                }
              }}
            />

            <div className="px-6 pb-2 pt-4">
              {submitError && (
                <div className="mb-4">
                  <Banner tone="destructive" title="Could not save household">
                    {submitError}
                  </Banner>
                </div>
              )}

              {step === 1 && (
                <StepBasics
                  state={state}
                  update={update}
                  firstFieldRef={step1FirstFieldRef}
                  disabled={submitting}
                />
              )}
              {step === 2 && (
                <StepAddress
                  state={state}
                  update={update}
                  firstFieldRef={step2FirstFieldRef}
                  disabled={submitting}
                />
              )}
              {step === 3 && (
                <StepMeter
                  state={state}
                  update={update}
                  onFirstRadio={(el) => {
                    step3FirstFieldRef.current = el;
                  }}
                  onCheckboxRef={(el) => {
                    // #158: when no_meter is the active path, the first
                    // focusable element is the checkbox itself.
                    if (state.no_meter || availableMeters.length === 0) {
                      step3FirstFieldRef.current = el;
                    }
                  }}
                  meters={availableMeters}
                  edgesSetupHref={edgesSetupHref}
                  disabled={submitting}
                  edges={edges}
                  edgeIdsWithoutConsumptionMeter={edgeIdsWithoutConsumptionMeter}
                  microgridId={microgridId}
                  onDevicePersisted={handleDevicePersisted}
                />
              )}
              {step === 4 && (
                <StepReview
                  state={state}
                  meters={availableMeters}
                  firstElementRef={step4FirstElementRef}
                  onJumpTo={(s) => {
                    // Review "edit" links jump back only to completed steps.
                    if (completedSteps.has(s)) goToStep(s);
                  }}
                />
              )}
            </div>

            {/* Footer actions */}
            <div className="mt-4 flex items-center justify-between gap-2 border-t border-border bg-muted px-6 pb-[18px] pt-[14px]">
              <button
                type="button"
                onClick={handleCancelClick}
                disabled={submitting}
                className="inline-flex h-8 items-center rounded-md px-3.5 text-[13px] font-medium text-foreground hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              >
                Cancel
              </button>

              <div className="flex items-center gap-2">
                {step > 1 && (
                  <button
                    type="button"
                    onClick={handleBack}
                    disabled={submitting}
                    className="inline-flex h-8 items-center rounded-md border border-border bg-card px-3.5 text-[13px] font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                  >
                    Back
                  </button>
                )}

                {step < 4 ? (
                  <button
                    type="button"
                    onClick={handleNext}
                    disabled={
                      !canProceed ||
                      submitting ||
                      (step === 3 && blockedByNoMeters)
                    }
                    className={cn(
                      "inline-flex h-8 items-center rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      "disabled:cursor-not-allowed disabled:opacity-50"
                    )}
                  >
                    Next
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={!canSave || submitting || blockedByNoMeters}
                    className={cn(
                      "inline-flex h-8 items-center rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      "disabled:cursor-not-allowed disabled:opacity-50"
                    )}
                  >
                    {submitting ? "Saving…" : "Create household"}
                  </button>
                )}
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={confirmCancelOpen}
        onOpenChange={setConfirmCancelOpen}
        tone="neutral"
        title="Discard unsaved household?"
        description="Your entries in this wizard will be lost. This is not an irreversible action against the database — nothing has been saved yet."
        confirmLabel="Discard"
        onConfirm={confirmCancel}
      />
    </>
  );
}

// ── Step indicator ───────────────────────────────────────────────────────

function StepIndicator({
  currentStep,
  completedSteps,
  visitedSteps,
  onStepClick,
}: {
  currentStep: Step;
  completedSteps: Set<Step>;
  visitedSteps: Set<Step>;
  onStepClick: (step: Step) => void;
}) {
  const steps: Step[] = [1, 2, 3, 4];
  return (
    <nav
      aria-label="Progress"
      className="flex items-center gap-1 border-b border-border px-6 pb-4 pt-3"
    >
      {steps.map((s, idx) => {
        const isActive = s === currentStep;
        const isCompleted = completedSteps.has(s);
        const isVisited = visitedSteps.has(s);
        // A step is clickable only when it's a completed step earlier than
        // the current step — i.e. a jump-back target.
        const isClickable = isCompleted && s < currentStep;
        return (
          <React.Fragment key={s}>
            <button
              type="button"
              onClick={() => onStepClick(s)}
              disabled={!isClickable}
              aria-current={isActive ? "step" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                isActive && "bg-primary/10 text-primary",
                !isActive && isCompleted && "text-foreground hover:bg-muted",
                !isActive && !isCompleted && isVisited && "text-muted-foreground",
                !isActive && !isVisited && "text-muted-foreground opacity-60",
                isClickable ? "cursor-pointer" : "cursor-default"
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold",
                  isActive && "bg-primary text-primary-foreground",
                  !isActive && isCompleted && "bg-success text-success-foreground",
                  !isActive && !isCompleted && "bg-border text-foreground"
                )}
              >
                {isCompleted && !isActive ? "✓" : s}
              </span>
              <span>{STEP_LABELS[s]}</span>
            </button>
            {idx < steps.length - 1 && (
              <span aria-hidden="true" className="h-px flex-1 bg-border" />
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

// ── Step 1: Basics ───────────────────────────────────────────────────────

function StepBasics({
  state,
  update,
  firstFieldRef,
  disabled,
}: {
  state: FormState;
  update: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  firstFieldRef: React.RefObject<HTMLInputElement | null>;
  disabled: boolean;
}) {
  // #155: phone is required for Pesapal payment-link delivery. The inline
  // error fires only after the user has interacted with the phone field
  // (focused-then-left), so the dialog doesn't yell on first render. The
  // Next button stays disabled until phone is non-empty either way, so the
  // user can't bypass the rule.
  const [phoneTouched, setPhoneTouched] = React.useState(false);
  const phoneBlank = state.primary_phone.trim().length === 0;
  const phoneInvalid = phoneTouched && phoneBlank;
  return (
    <fieldset className="space-y-4" disabled={disabled}>
      <legend className="sr-only">Step 1 of 4: Basics</legend>
      <div>
        <label
          htmlFor="hh-display-name"
          className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Display name <span aria-hidden="true">*</span>
          <span className="sr-only"> (required)</span>
        </label>
        <Input
          id="hh-display-name"
          ref={firstFieldRef}
          type="text"
          value={state.display_name}
          onChange={(e) => update("display_name", e.target.value)}
          placeholder="Block A, Unit 1"
          required
          aria-required="true"
        />
      </div>
      {/* PDF3 (#205) — Account Number (optional, ≤ 30 chars). */}
      <div>
        <label
          htmlFor="hh-account-number"
          className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Account number
        </label>
        <Input
          id="hh-account-number"
          type="text"
          maxLength={30}
          value={state.account_number}
          onChange={(e) => update("account_number", e.target.value)}
          placeholder="Optional — appears on the PDF invoice"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label
            htmlFor="hh-primary-phone"
            className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Primary phone <span aria-hidden="true">*</span>
            <span className="sr-only"> (required)</span>
          </label>
          <Input
            id="hh-primary-phone"
            type="text"
            value={state.primary_phone}
            onChange={(e) => update("primary_phone", e.target.value)}
            onBlur={() => setPhoneTouched(true)}
            placeholder="+256 …"
            required
            aria-required="true"
            aria-invalid={phoneInvalid ? "true" : undefined}
            aria-describedby={phoneInvalid ? "hh-primary-phone-error" : undefined}
            className={cn(
              phoneInvalid && "border-destructive ring-1 ring-destructive"
            )}
          />
          {phoneInvalid && (
            <p
              id="hh-primary-phone-error"
              className="mt-1 text-xs text-destructive-fg"
            >
              Phone is required for payment links
            </p>
          )}
        </div>
        <div>
          <label
            htmlFor="hh-primary-email"
            className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Email
          </label>
          <Input
            id="hh-primary-email"
            type="email"
            value={state.primary_email}
            onChange={(e) => update("primary_email", e.target.value)}
            placeholder="optional"
          />
        </div>
      </div>
      {/* PDF3 (#205) — Customer type (radio group; default residential). */}
      <div>
        <span
          id="hh-customer-type-label"
          className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Customer type
        </span>
        <RadioGroup
          value={state.customer_type}
          onValueChange={(v) =>
            update("customer_type", v as "residential" | "commercial")
          }
          aria-labelledby="hh-customer-type-label"
          className="flex flex-row gap-4"
        >
          <label
            htmlFor="hh-customer-type-residential"
            className="flex cursor-pointer items-center gap-2 text-sm text-foreground"
          >
            <RadioGroupItem
              id="hh-customer-type-residential"
              value="residential"
            />
            <span>Residential</span>
          </label>
          <label
            htmlFor="hh-customer-type-commercial"
            className="flex cursor-pointer items-center gap-2 text-sm text-foreground"
          >
            <RadioGroupItem
              id="hh-customer-type-commercial"
              value="commercial"
            />
            <span>Commercial</span>
          </label>
        </RadioGroup>
      </div>
    </fieldset>
  );
}

// ── Step 2: Address ──────────────────────────────────────────────────────

function StepAddress({
  state,
  update,
  firstFieldRef,
  disabled,
}: {
  state: FormState;
  update: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  firstFieldRef: React.RefObject<HTMLInputElement | null>;
  disabled: boolean;
}) {
  return (
    <fieldset className="space-y-4" disabled={disabled}>
      <legend className="sr-only">Step 2 of 4: Address</legend>
      <p className="text-xs text-muted-foreground">
        Optional — used for technician dispatch and visit context.
      </p>
      <div>
        <label
          htmlFor="hh-address-line1"
          className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Address line 1
        </label>
        <Input
          id="hh-address-line1"
          ref={firstFieldRef}
          type="text"
          value={state.address_line1}
          onChange={(e) => update("address_line1", e.target.value)}
          placeholder="Plot 14, Kisakye Ln"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label
            htmlFor="hh-address-line2"
            className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Address line 2
          </label>
          <Input
            id="hh-address-line2"
            type="text"
            value={state.address_line2}
            onChange={(e) => update("address_line2", e.target.value)}
            placeholder="Block A"
          />
        </div>
        <div>
          <label
            htmlFor="hh-unit-label"
            className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Unit label
          </label>
          <Input
            id="hh-unit-label"
            type="text"
            value={state.unit_label}
            onChange={(e) => update("unit_label", e.target.value)}
            placeholder="Unit 1"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label
            htmlFor="hh-address-city"
            className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            City
          </label>
          <Input
            id="hh-address-city"
            type="text"
            value={state.address_city}
            onChange={(e) => update("address_city", e.target.value)}
            placeholder="Kampala"
          />
        </div>
        <div>
          <label
            htmlFor="hh-address-region"
            className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Region / state
          </label>
          <Input
            id="hh-address-region"
            type="text"
            value={state.address_region}
            onChange={(e) => update("address_region", e.target.value)}
            placeholder="Central Region"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label
            htmlFor="hh-address-country"
            className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Country
          </label>
          <Input
            id="hh-address-country"
            type="text"
            value={state.address_country}
            onChange={(e) => update("address_country", e.target.value)}
            placeholder="Uganda"
          />
        </div>
        <div>
          <label
            htmlFor="hh-address-postal"
            className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Postal code
          </label>
          <Input
            id="hh-address-postal"
            type="text"
            value={state.address_postal_code}
            onChange={(e) => update("address_postal_code", e.target.value)}
            placeholder="00256"
          />
        </div>
      </div>
      <div>
        <label
          htmlFor="hh-geography-notes"
          className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Geography notes
        </label>
        <textarea
          id="hh-geography-notes"
          rows={2}
          value={state.geography_notes}
          onChange={(e) => update("geography_notes", e.target.value)}
          placeholder="Directions, landmarks, or access notes"
          className="flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        />
      </div>
    </fieldset>
  );
}

// ── Step 3: Meter pick ───────────────────────────────────────────────────

function StepMeter({
  state,
  update,
  onFirstRadio,
  onCheckboxRef,
  meters,
  edgesSetupHref,
  disabled,
  edges,
  edgeIdsWithoutConsumptionMeter,
  microgridId,
  onDevicePersisted,
}: {
  state: FormState;
  update: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  onFirstRadio: (el: HTMLButtonElement) => void;
  onCheckboxRef: (el: HTMLInputElement | null) => void;
  meters: AvailableMeter[];
  edgesSetupHref: string;
  disabled: boolean;
  edges: DiscoverMeterInlineEdge[];
  edgeIdsWithoutConsumptionMeter: string[];
  microgridId: string;
  onDevicePersisted: (device: AvailableMeter) => void;
}) {
  // #158: top-of-step "no meter" checkbox. When checked we clear device_id
  // defensively so an accidental prior pick doesn't leak into the submit
  // body, then collapse the meter picker into an info panel.
  const handleNoMeterToggle = (checked: boolean) => {
    update("no_meter", checked);
    if (checked) {
      update("device_id", "");
    }
  };

  return (
    <fieldset className="space-y-4" disabled={disabled}>
      <legend className="sr-only">Step 3 of 4: Meter assignment</legend>

      {/* PDF3 (#205) — physical-device descriptors that pair with the
          meter assignment. Editable in both branches (no_meter included)
          so the operator can record the physical serial even when the
          OpenEMS link isn't established. */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label
            htmlFor="hh-meter-serial"
            className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Meter serial
          </label>
          <Input
            id="hh-meter-serial"
            type="text"
            maxLength={50}
            value={state.meter_serial}
            onChange={(e) => update("meter_serial", e.target.value)}
            placeholder="Optional — physical serial"
          />
        </div>
        <div>
          <label
            htmlFor="hh-meter-type"
            className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Meter type
          </label>
          <Input
            id="hh-meter-type"
            type="text"
            maxLength={50}
            value={state.meter_type}
            onChange={(e) => update("meter_type", e.target.value)}
            placeholder="Smart Submeter"
          />
        </div>
      </div>

      {/* #158: no-meter (manual billing) checkbox. */}
      <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-card p-3 hover:bg-muted">
        <input
          id="hh-no-meter-checkbox"
          ref={onCheckboxRef}
          type="checkbox"
          checked={state.no_meter}
          onChange={(e) => handleNoMeterToggle(e.target.checked)}
          className="mt-0.5"
        />
        <span className="text-sm text-foreground">
          <span className="font-medium">
            This household does not have a meter
          </span>{" "}
          <span className="text-muted-foreground">(manual billing).</span>
        </span>
      </label>

      {state.no_meter ? (
        <div className="rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
          Without a meter, you&apos;ll enter usage manually each period. You
          can link a meter later from the household&apos;s edit dialog.
        </div>
      ) : (
        <>
          {/*
            #200 inline discovery section. Always visible (empty + non-empty
            cases both show it); suppressed only when state.no_meter is
            true via the outer ternary above.

            `key={state.no_meter}` re-mounts on toggle so any in-flight
            internal state (current pick, scan results, fetch errors) is
            reset. The component's internal AbortController also aborts
            pending fetches on unmount.
          */}
          {edges.length > 0 && (
            <DiscoverMeterInline
              key={String(state.no_meter)}
              edges={edges}
              edgeIdsWithoutConsumptionMeter={edgeIdsWithoutConsumptionMeter}
              microgridId={microgridId}
              onDevicePersisted={onDevicePersisted}
            />
          )}
        </>
      )}

      {state.no_meter ? null : meters.length === 0 ? (
        <div className="space-y-3">
          <Banner
            tone="warn"
            title="No available meters"
            action={
              <Link
                href={edgesSetupHref}
                className="inline-flex items-center rounded-md border border-warning bg-card px-3 py-1 text-xs font-medium text-warning-fg hover:bg-muted"
              >
                Go to Setup &gt; Edges
              </Link>
            }
          >
            All consumption meters on this microgrid are already assigned to a
            household. Discover more devices on the edges setup page before
            adding another household here, or check &ldquo;manual
            billing&rdquo; above to skip the meter assignment.
          </Banner>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Pick the consumption meter that will produce this household&apos;s
            bill each period.
          </p>
          <RadioGroup
            value={state.device_id}
            onValueChange={(v) => update("device_id", v)}
            aria-label="Available consumption meters"
            className="gap-2"
          >
            {meters.map((meter, idx) => {
              // The first radio input needs to be a focus target when
              // entering this step. We attach the ref to the first card only
              // by wrapping the RadioCard's inner item via a side-effect —
              // but RadioCard doesn't forward the inner radio ref. Instead
              // we use a targetted DOM query after mount: we focus the first
              // `role=radio` element in the list if this is the first card.
              return (
                <RadioCard
                  key={meter.id}
                  value={meter.id}
                  title={
                    <span className="flex items-center gap-2">
                      <span>{meter.name}</span>
                      <StatusChip
                        kind="deviceType"
                        status={meter.device_type}
                      />
                    </span>
                  }
                  description={meter.edge_name}
                  meta={humanReadable(meter.device_type)}
                  // Mark the first card so we can locate it for focus.
                  id={idx === 0 ? "hh-meter-first" : undefined}
                />
              );
            })}
          </RadioGroup>
          <FirstMeterFocuser onFound={onFirstRadio} meters={meters} />
        </div>
      )}
    </fieldset>
  );
}

/**
 * FirstMeterFocuser — finds the first radio button in step 3 and wires it
 * to the step-3 focus callback. Works around RadioCard not exposing an
 * inner ref to the radio input. This runs once after mount and on meters
 * change.
 */
function FirstMeterFocuser({
  onFound,
  meters,
}: {
  onFound: (el: HTMLButtonElement) => void;
  meters: AvailableMeter[];
}) {
  React.useEffect(() => {
    if (meters.length === 0) return;
    // Radix RadioGroupItem renders as a <button role="radio">.
    const el =
      (document.getElementById("hh-meter-first") as HTMLButtonElement | null) ??
      (document.querySelector('[role="radio"]') as HTMLButtonElement | null);
    if (el) {
      onFound(el);
      el.focus();
    }
  }, [onFound, meters]);
  return null;
}

// ── Step 4: Review ───────────────────────────────────────────────────────

function StepReview({
  state,
  meters,
  firstElementRef,
  onJumpTo,
}: {
  state: FormState;
  meters: AvailableMeter[];
  firstElementRef: React.RefObject<HTMLButtonElement | null>;
  onJumpTo: (step: Step) => void;
}) {
  const selectedMeter = meters.find((m) => m.id === state.device_id);
  return (
    <div className="space-y-4">
      <p className="sr-only">Step 4 of 4: Review</p>
      <ReviewSection
        title="Basics"
        onEdit={() => onJumpTo(1)}
        editRef={firstElementRef}
      >
        <ReviewRow label="Display name" value={state.display_name} />
        <ReviewRow
          label="Account number"
          value={state.account_number || "—"}
        />
        <ReviewRow
          label="Primary phone"
          value={state.primary_phone || "—"}
        />
        <ReviewRow
          label="Email"
          value={state.primary_email || "—"}
        />
        <ReviewRow
          label="Customer type"
          value={
            state.customer_type === "commercial" ? "Commercial" : "Residential"
          }
        />
      </ReviewSection>

      <ReviewSection title="Address" onEdit={() => onJumpTo(2)}>
        <ReviewRow
          label="Address line 1"
          value={state.address_line1 || "—"}
        />
        <ReviewRow
          label="Address line 2"
          value={state.address_line2 || "—"}
        />
        <ReviewRow label="Unit label" value={state.unit_label || "—"} />
        <ReviewRow label="City" value={state.address_city || "—"} />
        <ReviewRow label="Region / state" value={state.address_region || "—"} />
        <ReviewRow label="Country" value={state.address_country || "—"} />
        <ReviewRow label="Postal code" value={state.address_postal_code || "—"} />
        <ReviewRow
          label="Geography notes"
          value={state.geography_notes || "—"}
        />
      </ReviewSection>

      <ReviewSection title="Primary meter" onEdit={() => onJumpTo(3)}>
        {/* PDF3 (#205) — physical-device descriptors render regardless of
            no_meter. They describe the physical device, not the
            OpenEMS link. */}
        <ReviewRow label="Meter serial" value={state.meter_serial || "—"} />
        <ReviewRow
          label="Meter type"
          value={state.meter_type || "Smart Submeter"}
        />
        {state.no_meter ? (
          // #158: explicit no-meter review row (manual billing path).
          <ReviewRow
            label="Primary meter"
            value="— (manual billing)"
          />
        ) : selectedMeter ? (
          <>
            <ReviewRow label="Device" value={selectedMeter.name} />
            <ReviewRow label="Edge" value={selectedMeter.edge_name} />
            <ReviewRow
              label="Type"
              value={humanReadable(selectedMeter.device_type)}
            />
          </>
        ) : (
          <p className="text-sm text-destructive-fg">No meter selected.</p>
        )}
      </ReviewSection>
    </div>
  );
}

function ReviewSection({
  title,
  onEdit,
  editRef,
  children,
}: {
  title: string;
  onEdit: () => void;
  editRef?: React.RefObject<HTMLButtonElement | null>;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-border bg-card p-3">
      <header className="mb-2 flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h4>
        <button
          type="button"
          ref={editRef}
          onClick={onEdit}
          className="text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Edit
        </button>
      </header>
      <dl className="space-y-1 text-sm">{children}</dl>
    </section>
  );
}

function ReviewRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-32 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{value}</dd>
    </div>
  );
}
