"use client";

/**
 * EntityForm — shared modal form for Organization / Community / Microgrid CRUD (#76).
 *
 * Single component covers create + edit for all three entities via a
 * discriminated union on the `entity` prop. Rendered as a modal dialog
 * (Radix Dialog), not a dedicated route.
 *
 * Entity-specific extras stay in a small per-entity branch (kept under ~20 lines
 * each) — the common scaffolding (name, address, submit, error handling) is
 * shared.
 *
 * Server-side write path:
 *   - create: POST /api/{organizations|communities|microgrids}
 *   - edit:   PATCH /api/{organizations|communities|microgrids}/[id]
 * The form computes a dirty-fields diff in edit mode — only CHANGED fields
 * are sent. The server merges; a missing key in the PATCH body does NOT set
 * the column to null.
 *
 * Error contract: `{ error: string, field?: string }`.
 *   - 422 with `field`  → inline error under that input
 *   - 409               → top-level banner (duplicate microgrid name)
 *   - 403 / 500 / other → top-level banner
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { Input } from "@/components/ui/input";
import { Banner } from "@/components/ui/banner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AddressFields,
  type AddressFieldName,
  type AddressValues,
} from "./AddressFields";
import { CURRENCY_OPTIONS } from "@/lib/validation/currency";
import { cn } from "@/lib/utils";
import type {
  Organization,
  Community,
  Microgrid,
} from "@/lib/types/domain";
import type { OrgOption, CommunityOption } from "./AddEntityButton";

// ── Props (discriminated union) ──────────────────────────────────────────

type CommonModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
};

export type EntityFormProps = CommonModalProps &
  (
    | {
        entity: "organization";
        mode: "create" | "edit";
        initialValues?: Partial<Organization> & { id?: string };
      }
    | {
        entity: "community";
        mode: "create" | "edit";
        /** Single-parent locked mode. */
        parentOrgId: string;
        availableOrgs?: never;
        initialValues?: Partial<Community> & { id?: string };
      }
    | {
        entity: "community";
        mode: "create";
        /** Multi-parent picker mode. Only valid for create. */
        availableOrgs: OrgOption[];
        parentOrgId?: never;
        initialValues?: never;
      }
    | {
        entity: "microgrid";
        mode: "create" | "edit";
        /** Single-parent locked mode. */
        parentCommunityId: string;
        availableCommunities?: never;
        initialValues?: Partial<Microgrid> & { id?: string };
      }
    | {
        entity: "microgrid";
        mode: "create";
        /** Multi-parent picker mode. Only valid for create. */
        availableCommunities: CommunityOption[];
        parentCommunityId?: never;
        initialValues?: never;
      }
  );

// ── Shared internal state shape ──────────────────────────────────────────

type FormState = AddressValues & {
  name: string;
  geography_notes?: string;
  currency?: string;
  lat?: string; // kept as string for input binding
  lng?: string;
  /** Selected org ID when in community picker mode. */
  selectedOrgId?: string;
  /** Selected community ID when in microgrid picker mode. */
  selectedCommunityId?: string;
};

type FieldErrors = Partial<Record<string, string>>;

const ADDRESS_FIELDS: AddressFieldName[] = [
  "address_line1",
  "address_line2",
  "address_city",
  "address_region",
  "address_country",
  "address_postal_code",
];

// ── Helpers ──────────────────────────────────────────────────────────────

function initialStateFor(props: EntityFormProps): FormState {
  const iv =
    (props.entity === "organization"
      ? props.initialValues
      : props.entity === "community"
        ? props.initialValues
        : props.initialValues) ?? {};

  const base: FormState = {
    name: iv.name ?? "",
    address_line1: iv.address_line1 ?? "",
    address_line2: iv.address_line2 ?? "",
    address_city: iv.address_city ?? "",
    address_region: iv.address_region ?? "",
    address_country: iv.address_country ?? "",
    address_postal_code: iv.address_postal_code ?? "",
  };

  if (props.entity === "community") {
    base.geography_notes = props.initialValues?.geography_notes ?? "";
  }

  if (props.entity === "microgrid") {
    const mgIv = props.initialValues ?? {};
    base.currency = mgIv.currency ?? "UGX";
    base.lat = mgIv.lat != null ? String(mgIv.lat) : "";
    base.lng = mgIv.lng != null ? String(mgIv.lng) : "";
  }

  return base;
}

/** Build the POST payload (all fields) from form state. */
function buildCreatePayload(
  state: FormState,
  props: EntityFormProps
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: state.name.trim(),
  };

  for (const f of ADDRESS_FIELDS) {
    payload[f] = state[f]?.trim() ?? "";
  }

  if (props.entity === "community") {
    // parentOrgId is set in locked mode; selectedOrgId is used in picker mode.
    payload.org_id = props.parentOrgId ?? state.selectedOrgId;
    payload.geography_notes = state.geography_notes?.trim() ?? "";
  }
  if (props.entity === "microgrid") {
    // parentCommunityId is set in locked mode; selectedCommunityId is used in picker mode.
    payload.community_id = props.parentCommunityId ?? state.selectedCommunityId;
    payload.currency = state.currency ?? "UGX";
    payload.lat = state.lat?.trim() ? state.lat.trim() : null;
    payload.lng = state.lng?.trim() ? state.lng.trim() : null;
  }

  return payload;
}

/** Build the PATCH payload (only changed fields). */
function buildPatchPayload(
  state: FormState,
  props: EntityFormProps
): Record<string, unknown> {
  const initial = initialStateFor(props);
  const payload: Record<string, unknown> = {};

  if (state.name.trim() !== (initial.name ?? "").trim()) {
    payload.name = state.name.trim();
  }

  for (const f of ADDRESS_FIELDS) {
    const cur = (state[f] ?? "").trim();
    const init = (initial[f] ?? "").trim();
    if (cur !== init) {
      payload[f] = cur;
    }
  }

  if (props.entity === "community") {
    const cur = (state.geography_notes ?? "").trim();
    const init = (initial.geography_notes ?? "").trim();
    if (cur !== init) payload.geography_notes = cur;
  }

  if (props.entity === "microgrid") {
    if ((state.currency ?? "") !== (initial.currency ?? "")) {
      payload.currency = state.currency;
    }
    const curLat = (state.lat ?? "").trim();
    const initLat = (initial.lat ?? "").trim();
    if (curLat !== initLat) payload.lat = curLat;
    const curLng = (state.lng ?? "").trim();
    const initLng = (initial.lng ?? "").trim();
    if (curLng !== initLng) payload.lng = curLng;
  }

  return payload;
}

function endpointFor(props: EntityFormProps): {
  url: string;
  method: "POST" | "PATCH";
} {
  const base =
    props.entity === "organization"
      ? "/api/organizations"
      : props.entity === "community"
        ? "/api/communities"
        : "/api/microgrids";

  if (props.mode === "create") {
    return { url: base, method: "POST" };
  }
  const id = props.initialValues?.id;
  return { url: `${base}/${id}`, method: "PATCH" };
}

function titleFor(props: EntityFormProps): string {
  const verb = props.mode === "create" ? "Add" : "Edit";
  const noun =
    props.entity === "organization"
      ? "Organization"
      : props.entity === "community"
        ? "Community"
        : "Microgrid";
  return `${verb} ${noun}`;
}

// ── Component ────────────────────────────────────────────────────────────

export function EntityForm(props: EntityFormProps) {
  const router = useRouter();

  const [state, setState] = React.useState<FormState>(() =>
    initialStateFor(props)
  );
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [topError, setTopError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  // Reset state when the dialog opens — catches the "opened twice with
  // different initialValues" edge case.
  React.useEffect(() => {
    if (props.open) {
      setState(initialStateFor(props));
      setFieldErrors({});
      setTopError(null);
      setSubmitting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  const updateField = React.useCallback(
    (key: keyof FormState, value: string) => {
      setState((prev) => ({ ...prev, [key]: value }));
      setFieldErrors((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key as string];
        return next;
      });
    },
    []
  );

  const updateAddress = React.useCallback(
    (field: AddressFieldName, value: string) => {
      updateField(field, value);
    },
    [updateField]
  );

  // Client-side guards: org address city+country required. Server is the
  // authoritative validator — this is just an immediate-feedback affordance.
  const clientValidate = React.useCallback((): FieldErrors => {
    const errs: FieldErrors = {};
    if (!state.name.trim()) errs.name = "Name is required.";
    if (props.entity === "organization") {
      if (!(state.address_city ?? "").trim())
        errs.address_city = "City is required.";
      if (!(state.address_country ?? "").trim())
        errs.address_country = "Country is required.";
    }
    if (props.entity === "community" && "availableOrgs" in props && props.availableOrgs) {
      if (!state.selectedOrgId)
        errs.selectedOrgId = "Organization is required.";
    }
    if (props.entity === "microgrid") {
      if (!(state.currency ?? "").trim())
        errs.currency = "Currency is required.";
      if ("availableCommunities" in props && props.availableCommunities) {
        if (!state.selectedCommunityId)
          errs.selectedCommunityId = "Community is required.";
      }
    }
    return errs;
  }, [state, props]);

  const handleSubmit = React.useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setTopError(null);

      const errs = clientValidate();
      if (Object.keys(errs).length > 0) {
        setFieldErrors(errs);
        return;
      }

      const { url, method } = endpointFor(props);
      const payload =
        props.mode === "create"
          ? buildCreatePayload(state, props)
          : buildPatchPayload(state, props);

      if (method === "PATCH" && Object.keys(payload).length === 0) {
        // Nothing to save — just close.
        props.onOpenChange(false);
        return;
      }

      setSubmitting(true);
      try {
        const res = await fetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          field?: string;
        };

        if (!res.ok) {
          if (res.status === 422 && data.field) {
            setFieldErrors({ [data.field]: data.error ?? "Invalid value." });
          } else if (res.status === 403) {
            setTopError(
              data.error ?? "You do not have permission to perform this action."
            );
          } else if (res.status === 409) {
            // Duplicate name — surface top-level banner AND inline on name.
            const msg = data.error ?? "Duplicate name.";
            setTopError(msg);
            if (data.field) setFieldErrors({ [data.field]: msg });
          } else {
            setTopError(data.error ?? "Could not save. Please try again.");
          }
          setSubmitting(false);
          return;
        }

        // Success.
        router.refresh();
        props.onSuccess?.();
        props.onOpenChange(false);
      } catch {
        setTopError("Network error. Please retry.");
        setSubmitting(false);
      }
    },
    [clientValidate, props, state, router]
  );

  const isOrg = props.entity === "organization";
  const orgAddressRequired: readonly AddressFieldName[] = isOrg
    ? ["address_city", "address_country"]
    : [];

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/55" />
        <Dialog.Content
          aria-modal
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[520px] max-w-[94%] -translate-x-1/2 -translate-y-1/2",
            "max-h-[90vh] overflow-y-auto rounded-md border border-border bg-card shadow-elev-3 outline-none"
          )}
        >
          <div className="px-6 pt-5">
            <Dialog.Title className="text-xl font-semibold tracking-tight text-foreground">
              {titleFor(props)}
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[13px] text-muted-foreground">
              {props.mode === "create"
                ? "Fill in the fields below. City and country are required for organizations."
                : "Only changed fields will be saved."}
            </Dialog.Description>
          </div>

          <form
            onSubmit={handleSubmit}
            className="px-6 pb-2 pt-4 space-y-4"
            noValidate
          >
            {topError && (
              <Banner tone="destructive" title="Could not save">
                {topError}
              </Banner>
            )}

            {/* Parent picker — community create in multi-org scope */}
            {props.entity === "community" &&
              "availableOrgs" in props &&
              props.availableOrgs && (
                <div>
                  <label
                    htmlFor="entity-parent-org"
                    className="mb-1 block text-xs font-medium text-muted-foreground"
                  >
                    Organization
                    <span aria-hidden="true" className="ml-0.5 text-destructive-fg">
                      *
                    </span>
                    <span className="sr-only"> (required)</span>
                  </label>
                  <Select
                    value={state.selectedOrgId ?? ""}
                    onValueChange={(v) => updateField("selectedOrgId", v)}
                    disabled={submitting}
                  >
                    <SelectTrigger id="entity-parent-org" className="w-full">
                      <SelectValue placeholder="Select an organization…" />
                    </SelectTrigger>
                    <SelectContent>
                      {[...props.availableOrgs]
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((org) => (
                          <SelectItem key={org.id} value={org.id}>
                            {org.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  {fieldErrors.selectedOrgId && (
                    <p role="alert" className="mt-1 text-xs text-destructive-fg">
                      {fieldErrors.selectedOrgId}
                    </p>
                  )}
                </div>
              )}

            {/* Parent picker — microgrid create in multi-community scope */}
            {props.entity === "microgrid" &&
              "availableCommunities" in props &&
              props.availableCommunities && (
                <div>
                  <label
                    htmlFor="entity-parent-community"
                    className="mb-1 block text-xs font-medium text-muted-foreground"
                  >
                    Community
                    <span aria-hidden="true" className="ml-0.5 text-destructive-fg">
                      *
                    </span>
                    <span className="sr-only"> (required)</span>
                  </label>
                  <Select
                    value={state.selectedCommunityId ?? ""}
                    onValueChange={(v) => updateField("selectedCommunityId", v)}
                    disabled={submitting}
                  >
                    <SelectTrigger id="entity-parent-community" className="w-full">
                      <SelectValue placeholder="Select a community…" />
                    </SelectTrigger>
                    <SelectContent>
                      {[...props.availableCommunities]
                        .sort((a, b) => {
                          const orgCmp = (a.org_name ?? "").localeCompare(b.org_name ?? "");
                          return orgCmp !== 0 ? orgCmp : a.name.localeCompare(b.name);
                        })
                        .map((community) => (
                          <SelectItem key={community.id} value={community.id}>
                            {community.org_name
                              ? `${community.name} (${community.org_name})`
                              : community.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  {fieldErrors.selectedCommunityId && (
                    <p role="alert" className="mt-1 text-xs text-destructive-fg">
                      {fieldErrors.selectedCommunityId}
                    </p>
                  )}
                </div>
              )}

            {/* Name */}
            <div>
              <label
                htmlFor="entity-name"
                className="mb-1 block text-xs font-medium text-muted-foreground"
              >
                Name
                <span aria-hidden="true" className="ml-0.5 text-destructive-fg">
                  *
                </span>
                <span className="sr-only"> (required)</span>
              </label>
              <Input
                id="entity-name"
                type="text"
                value={state.name}
                onChange={(e) => updateField("name", e.target.value)}
                disabled={submitting}
                aria-invalid={fieldErrors.name ? true : undefined}
                aria-describedby={fieldErrors.name ? "entity-name-err" : undefined}
                className={cn(fieldErrors.name && "border-destructive")}
              />
              {fieldErrors.name && (
                <p
                  id="entity-name-err"
                  role="alert"
                  className="mt-1 text-xs text-destructive-fg"
                >
                  {fieldErrors.name}
                </p>
              )}
            </div>

            {/* Address */}
            <AddressFields
              values={state}
              onChange={updateAddress}
              requiredFields={orgAddressRequired}
              fieldErrors={fieldErrors}
              disabled={submitting}
            />

            {/* Per-entity extras */}
            {props.entity === "community" && (
              <div>
                <label
                  htmlFor="entity-geography-notes"
                  className="mb-1 block text-xs font-medium text-muted-foreground"
                >
                  Geography notes
                </label>
                <textarea
                  id="entity-geography-notes"
                  value={state.geography_notes ?? ""}
                  onChange={(e) =>
                    updateField("geography_notes", e.target.value)
                  }
                  disabled={submitting}
                  rows={3}
                  className="flex w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
            )}

            {props.entity === "microgrid" && (
              <div className="space-y-3">
                <div>
                  <label
                    htmlFor="entity-currency"
                    className="mb-1 block text-xs font-medium text-muted-foreground"
                  >
                    Currency
                    <span
                      aria-hidden="true"
                      className="ml-0.5 text-destructive-fg"
                    >
                      *
                    </span>
                  </label>
                  <Select
                    value={state.currency ?? "UGX"}
                    onValueChange={(v) => updateField("currency", v)}
                    disabled={submitting}
                  >
                    <SelectTrigger id="entity-currency" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CURRENCY_OPTIONS.map((code) => (
                        <SelectItem key={code} value={code}>
                          {code}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {fieldErrors.currency && (
                    <p
                      role="alert"
                      className="mt-1 text-xs text-destructive-fg"
                    >
                      {fieldErrors.currency}
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label
                      htmlFor="entity-lat"
                      className="mb-1 block text-xs font-medium text-muted-foreground"
                    >
                      Latitude
                    </label>
                    <Input
                      id="entity-lat"
                      type="text"
                      inputMode="decimal"
                      value={state.lat ?? ""}
                      onChange={(e) => updateField("lat", e.target.value)}
                      disabled={submitting}
                      aria-invalid={fieldErrors.lat ? true : undefined}
                    />
                    {fieldErrors.lat && (
                      <p role="alert" className="mt-1 text-xs text-destructive-fg">
                        {fieldErrors.lat}
                      </p>
                    )}
                  </div>
                  <div>
                    <label
                      htmlFor="entity-lng"
                      className="mb-1 block text-xs font-medium text-muted-foreground"
                    >
                      Longitude
                    </label>
                    <Input
                      id="entity-lng"
                      type="text"
                      inputMode="decimal"
                      value={state.lng ?? ""}
                      onChange={(e) => updateField("lng", e.target.value)}
                      disabled={submitting}
                      aria-invalid={fieldErrors.lng ? true : undefined}
                    />
                    {fieldErrors.lng && (
                      <p role="alert" className="mt-1 text-xs text-destructive-fg">
                        {fieldErrors.lng}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </form>

          <div className="mt-4 flex items-center justify-end gap-2 border-t border-border bg-muted px-6 pb-[18px] pt-[14px]">
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
              type="submit"
              onClick={handleSubmit}
              disabled={submitting}
              className="inline-flex h-8 items-center rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              {submitting
                ? "Saving…"
                : props.mode === "create"
                  ? "Create"
                  : "Save changes"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
