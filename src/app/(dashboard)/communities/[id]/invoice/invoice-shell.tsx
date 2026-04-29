"use client";

/**
 * invoice-shell.tsx — Client shell for the community Invoice tab (#204 / PDF2).
 *
 * Owns:
 *   - Form state (controlled — useState; no react-hook-form, mirrors the
 *     Payment-shell precedent).
 *   - Logo-staging state (drafted path + signed thumbnail URL until next save).
 *   - Submit handler (PATCH /api/communities/[id]/invoice-config).
 *   - Preview-button click flow (Pattern A — fetch + blob + popup window).
 *
 * Click-flow rationale (preview button — Pattern A): we open `about:blank`
 * synchronously inside the click handler (popup blockers reject async opens),
 * then POST to the preview route, then set the popup's location to a blob
 * URL. Pattern B (hidden form submit) was rejected because the route's
 * permission gate operates on JSON, and accepting both content-types is
 * extra surface area.
 *
 * Default-value semantics (#204 R5): when `invoice_config` is empty (`{}`),
 * we pre-fill the form with sensible defaults (sourced from PDF1a's Zod
 * schema defaults). These defaults are EDITABLE, not placeholder — the first
 * save persists the full populated JSONB.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
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
  parseInvoiceConfig,
  type InvoiceConfig,
} from "@/lib/invoices/config-schema";
import { ColorInput } from "./color-input";
import { ListEditor } from "./list-editor";
import {
  LogoUploadControl,
  type LogoUploadResult,
} from "./logo-upload-control";

// ── Defaults ────────────────────────────────────────────────────────────────
//
// Sourced from PLAN.md's "default config" reference + AC #2 default-value
// section. Mirror the Zod schema's expectations so the first PATCH from a
// fresh form always passes validation.

const DEFAULT_PRIMARY_COLOR = "#163a5f";
const DEFAULT_ACCENT_COLOR = "#2f7d32";
const DEFAULT_DUE_DAYS = 8;
const DEFAULT_TAX_RATE = 18;
const DEFAULT_TAX_LABEL = "VAT @ 18%";

type FormState = {
  invoice_prefix: string;
  // Identity
  document_title: "Invoice" | "Bill" | "Receipt";
  // Seller
  legal_name: string;
  trade_name: string;
  tax_ids: { label: string; value: string }[];
  address_lines: string[];
  contact_email: string;
  contact_phone: string;
  // Branding
  tagline: string;
  primary_color: string;
  accent_color: string;
  whatsapp_number: string;
  logo_storage_path: string | null;
  // Payment
  due_days_after_issue: number;
  // Tax
  tax_show_section: boolean;
  tax_category_label: string;
  tax_rate_pct: number;
  // Notices
  vat_text: string;
  payment_instructions_text: string;
  signature_disclaimer: string;
};

function buildInitialState(
  config: InvoiceConfig,
  prefix: string | null,
): FormState {
  const branding = config.branding ?? {};
  const seller = config.seller ?? { legal_name: "" };
  const payment = config.payment;
  const tax = config.tax ?? {};
  const notices = config.notices ?? {};

  return {
    invoice_prefix: prefix ?? "",
    document_title:
      branding.document_title === "Bill" || branding.document_title === "Receipt"
        ? branding.document_title
        : "Invoice",
    legal_name: seller.legal_name ?? "",
    trade_name: seller.trade_name ?? "",
    tax_ids: seller.tax_ids ? [...seller.tax_ids] : [],
    address_lines: seller.address_lines ? [...seller.address_lines] : [],
    contact_email: seller.contact_email ?? "",
    contact_phone: seller.contact_phone ?? "",
    tagline: branding.tagline ?? "",
    primary_color: branding.primary_color ?? DEFAULT_PRIMARY_COLOR,
    accent_color: branding.accent_color ?? DEFAULT_ACCENT_COLOR,
    whatsapp_number: branding.whatsapp_number ?? "",
    logo_storage_path: branding.logo_storage_path ?? null,
    due_days_after_issue: payment?.due_days_after_issue ?? DEFAULT_DUE_DAYS,
    tax_show_section: tax.show_section ?? true,
    tax_category_label: tax.category_label ?? DEFAULT_TAX_LABEL,
    tax_rate_pct: tax.rate_pct ?? DEFAULT_TAX_RATE,
    vat_text: notices.vat_text ?? "",
    payment_instructions_text: notices.payment_instructions_text ?? "",
    signature_disclaimer: notices.signature_disclaimer ?? "",
  };
}

function buildPayload(state: FormState): {
  invoice_prefix: string | null;
  invoice_config: InvoiceConfig;
} {
  const seller: NonNullable<InvoiceConfig["seller"]> = {
    legal_name: state.legal_name.trim(),
  };
  if (state.trade_name.trim()) seller.trade_name = state.trade_name.trim();
  if (state.tax_ids.length > 0) {
    seller.tax_ids = state.tax_ids
      .map((t) => ({ label: t.label.trim(), value: t.value.trim() }))
      .filter((t) => t.label && t.value);
  }
  if (state.address_lines.length > 0) {
    seller.address_lines = state.address_lines
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }
  if (state.contact_email.trim()) {
    seller.contact_email = state.contact_email.trim();
  }
  if (state.contact_phone.trim()) {
    seller.contact_phone = state.contact_phone.trim();
  }

  const branding: NonNullable<InvoiceConfig["branding"]> = {};
  if (state.logo_storage_path) {
    branding.logo_storage_path = state.logo_storage_path;
  }
  if (state.tagline.trim()) branding.tagline = state.tagline.trim();
  branding.primary_color = state.primary_color;
  branding.accent_color = state.accent_color;
  if (state.whatsapp_number.trim()) {
    branding.whatsapp_number = state.whatsapp_number.trim();
  }
  branding.document_title = state.document_title;

  const config: InvoiceConfig = {
    seller: seller.legal_name ? seller : undefined,
    branding,
    payment: { due_days_after_issue: state.due_days_after_issue },
    tax: {
      show_section: state.tax_show_section,
      category_label: state.tax_category_label.trim() || DEFAULT_TAX_LABEL,
      rate_pct: state.tax_rate_pct,
    },
    notices: {
      vat_text: state.vat_text.trim() || null,
      payment_instructions_text:
        state.payment_instructions_text.trim() || null,
      signature_disclaimer: state.signature_disclaimer.trim() || null,
    },
  };

  // Strip undefined keys so the JSONB stays canonical.
  if (!config.seller) delete config.seller;

  return {
    invoice_prefix: state.invoice_prefix.trim()
      ? state.invoice_prefix.trim()
      : null,
    invoice_config: config,
  };
}

export type InvoiceShellProps = {
  communityId: string;
  communityName: string;
  initialConfig: InvoiceConfig;
  initialPrefix: string | null;
  initialSignedThumbnailUrl: string | null;
};

export function InvoiceShell({
  communityId,
  communityName,
  initialConfig,
  initialPrefix,
  initialSignedThumbnailUrl,
}: InvoiceShellProps) {
  const router = useRouter();
  const [state, setState] = React.useState<FormState>(() =>
    buildInitialState(initialConfig, initialPrefix),
  );
  const [signedThumbnailUrl, setSignedThumbnailUrl] = React.useState<
    string | null
  >(initialSignedThumbnailUrl);
  const [saving, setSaving] = React.useState(false);
  const [previewing, setPreviewing] = React.useState(false);
  const [outcome, setOutcome] = React.useState<
    | null
    | { kind: "success"; message: string }
    | { kind: "error"; message: string; fields?: Record<string, unknown> }
  >(null);
  const [showNotices, setShowNotices] = React.useState(false);

  // Cross-field rule (#204 R5 / PDF1a Zod): when the rate is set to 0, auto-
  // toggle Show tax section to false. Mirrors the schema's invariant.
  React.useEffect(() => {
    if (state.tax_rate_pct === 0 && state.tax_show_section) {
      setState((s) => ({ ...s, tax_show_section: false }));
    }
  }, [state.tax_rate_pct, state.tax_show_section]);

  function patch<K extends keyof FormState>(key: K, value: FormState[K]) {
    setState((s) => ({ ...s, [key]: value }));
  }

  function handleLogoUploaded(result: LogoUploadResult) {
    setState((s) => ({ ...s, logo_storage_path: result.logo_storage_path }));
    setSignedThumbnailUrl(result.signed_thumbnail_url || null);
  }

  function handleLogoRemove() {
    // Clear the form-state path; the storage object is intentionally left
    // orphaned for MVP (architect R6 cleanup is a future ticket).
    setState((s) => ({ ...s, logo_storage_path: null }));
    setSignedThumbnailUrl(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setOutcome(null);
    setSaving(true);
    try {
      const payload = buildPayload(state);

      // Client-side Zod pre-flight — catches obvious errors without a server
      // round-trip and normalises the JSONB shape.
      try {
        parseInvoiceConfig(payload.invoice_config);
      } catch (err) {
        setOutcome({
          kind: "error",
          message:
            err instanceof Error
              ? err.message
              : "Invoice configuration is invalid.",
        });
        setSaving(false);
        return;
      }

      const res = await fetch(
        `/api/communities/${communityId}/invoice-config`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const json = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      if (res.status === 200) {
        setOutcome({
          kind: "success",
          message: "Invoice settings saved.",
        });
        router.refresh();
        return;
      }

      setOutcome({
        kind: "error",
        message:
          (typeof json.error === "string" && json.error) ||
          "Failed to save invoice settings.",
        fields:
          json.fields && typeof json.fields === "object"
            ? (json.fields as Record<string, unknown>)
            : undefined,
      });
    } catch {
      setOutcome({
        kind: "error",
        message: "Network error — please try again.",
      });
    } finally {
      setSaving(false);
    }
  }

  async function handlePreview() {
    if (previewing) return;
    setPreviewing(true);
    setOutcome(null);

    // Pattern A — open the popup synchronously inside the click handler so
    // popup blockers don't reject it.
    const popup = window.open("about:blank", "_blank");

    try {
      const payload = buildPayload(state);
      const res = await fetch(
        `/api/communities/${communityId}/invoice-preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        setOutcome({
          kind: "error",
          message:
            (typeof json.error === "string" && json.error) ||
            `Preview failed (HTTP ${res.status}).`,
        });
        if (popup) popup.close();
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (popup) {
        popup.location.href = url;
      } else {
        // Popup blocked — fall back to navigating the current tab. The
        // operator should re-enable popups for the best experience.
        window.location.href = url;
      }
    } catch {
      setOutcome({
        kind: "error",
        message: "Network error during preview generation.",
      });
      if (popup) popup.close();
    } finally {
      setPreviewing(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────

  const showPrefixWarning = !state.invoice_prefix.trim();

  return (
    <form onSubmit={handleSave} className="space-y-6">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Invoice
        </p>
        <h3 className="text-lg font-semibold text-foreground">
          Configure {communityName}&apos;s invoice template
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Branding, seller details, and tax/payment copy that appear on every
          PDF bill for this community.
        </p>
      </div>

      {/* Section: Identity */}
      <Section title="Identity">
        <Field
          id="invoice-prefix"
          label="Invoice prefix"
          description="Used in invoice numbers, e.g. NFE-2026-00421. 2-8 uppercase letters or digits."
        >
          <Input
            id="invoice-prefix"
            type="text"
            value={state.invoice_prefix}
            onChange={(e) => patch("invoice_prefix", e.target.value.toUpperCase())}
            placeholder="NFE"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        </Field>

        <Field id="document-title" label="Document title">
          <Select
            value={state.document_title}
            onValueChange={(v) =>
              patch("document_title", v as FormState["document_title"])
            }
          >
            <SelectTrigger id="document-title">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Invoice">Invoice</SelectItem>
              <SelectItem value="Bill">Bill</SelectItem>
              <SelectItem value="Receipt">Receipt</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </Section>

      {/* Section: Seller Details */}
      <Section title="Seller Details">
        <Field
          id="legal-name"
          label="Legal name"
          description="Required when other invoice config fields are set. Falls back to the org name if empty."
        >
          <Input
            id="legal-name"
            type="text"
            value={state.legal_name}
            onChange={(e) => patch("legal_name", e.target.value)}
          />
        </Field>

        <Field
          id="trade-name"
          label="Trade name"
          description="Optional — falls back to legal name."
        >
          <Input
            id="trade-name"
            type="text"
            value={state.trade_name}
            onChange={(e) => patch("trade_name", e.target.value)}
          />
        </Field>

        <Field id="tax-ids" label="Tax IDs">
          <ListEditor<{ label: string; value: string }>
            rows={state.tax_ids}
            onChange={(rows) => patch("tax_ids", rows)}
            renderRow={(row, _i, update) => (
              <div className="grid grid-cols-2 gap-2">
                <Input
                  type="text"
                  value={row.label}
                  onChange={(e) => update({ ...row, label: e.target.value })}
                  placeholder="Label (e.g. TIN)"
                  aria-label="Tax ID label"
                />
                <Input
                  type="text"
                  value={row.value}
                  onChange={(e) => update({ ...row, value: e.target.value })}
                  placeholder="Value"
                  aria-label="Tax ID value"
                />
              </div>
            )}
            emptyRow={() => ({ label: "", value: "" })}
            maxRows={4}
            addLabel="Add tax ID"
            emptyCopy="No tax IDs configured."
          />
        </Field>

        <Field id="address-lines" label="Address lines">
          <ListEditor<string>
            rows={state.address_lines}
            onChange={(rows) => patch("address_lines", rows)}
            renderRow={(row, _i, update) => (
              <Input
                type="text"
                value={row}
                onChange={(e) => update(e.target.value)}
                placeholder="Street, city, country…"
                aria-label="Address line"
              />
            )}
            emptyRow={() => ""}
            maxRows={6}
            addLabel="Add address line"
            emptyCopy="No address lines configured."
          />
        </Field>

        <Field id="contact-email" label="Contact email">
          <Input
            id="contact-email"
            type="email"
            value={state.contact_email}
            onChange={(e) => patch("contact_email", e.target.value)}
          />
        </Field>

        <Field
          id="contact-phone"
          label="Contact phone"
          description="Used as a fallback for the WhatsApp link if the WhatsApp number is empty."
        >
          <Input
            id="contact-phone"
            type="tel"
            value={state.contact_phone}
            onChange={(e) => patch("contact_phone", e.target.value)}
          />
        </Field>
      </Section>

      {/* Section: Branding */}
      <Section title="Branding">
        <Field id="tagline" label="Tagline">
          <Input
            id="tagline"
            type="text"
            value={state.tagline}
            onChange={(e) => patch("tagline", e.target.value)}
            placeholder="Customer Energy Bill"
          />
        </Field>

        <ColorInput
          id="primary-color"
          label="Primary colour"
          value={state.primary_color}
          onChange={(v) => patch("primary_color", v)}
          defaultValue={DEFAULT_PRIMARY_COLOR}
          description="Used for the document header and accents."
        />

        <ColorInput
          id="accent-color"
          label="Accent colour"
          value={state.accent_color}
          onChange={(v) => patch("accent_color", v)}
          defaultValue={DEFAULT_ACCENT_COLOR}
          description="Used for highlighted totals and action chips."
        />

        <Field
          id="whatsapp-number"
          label="WhatsApp number"
          description="Optional — overrides the contact phone for the WhatsApp link."
        >
          <Input
            id="whatsapp-number"
            type="tel"
            value={state.whatsapp_number}
            onChange={(e) => patch("whatsapp_number", e.target.value)}
          />
        </Field>

        <Field id="logo" label="Logo">
          <LogoUploadControl
            communityId={communityId}
            currentLogoPath={state.logo_storage_path}
            currentSignedThumbnailUrl={signedThumbnailUrl}
            onUploaded={handleLogoUploaded}
            onRemove={handleLogoRemove}
          />
        </Field>
      </Section>

      {/* Section: Payment */}
      <Section title="Payment">
        <Field
          id="due-days"
          label="Days until due"
          description="Number of days after issue when the bill becomes due (1-60)."
        >
          <Input
            id="due-days"
            type="number"
            min={1}
            max={60}
            value={state.due_days_after_issue}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              patch(
                "due_days_after_issue",
                Number.isFinite(n) ? Math.max(1, Math.min(60, n)) : DEFAULT_DUE_DAYS,
              );
            }}
            className="w-24"
          />
        </Field>
      </Section>

      {/* Section: Tax */}
      <Section title="Tax">
        <div>
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={state.tax_show_section}
              onChange={(e) => patch("tax_show_section", e.target.checked)}
              disabled={state.tax_rate_pct === 0}
              className="h-4 w-4 rounded border-border text-primary focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span className="text-xs text-foreground">
              Show tax section on bills
            </span>
          </label>
          {state.tax_rate_pct === 0 && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Tax section is hidden when the rate is 0%.
            </p>
          )}
        </div>

        <Field id="tax-category-label" label="Tax category label">
          <Input
            id="tax-category-label"
            type="text"
            value={state.tax_category_label}
            onChange={(e) => patch("tax_category_label", e.target.value)}
            disabled={!state.tax_show_section}
          />
        </Field>

        <Field id="tax-rate-pct" label="Tax rate %">
          <Input
            id="tax-rate-pct"
            type="number"
            min={0}
            max={30}
            value={state.tax_rate_pct}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              patch(
                "tax_rate_pct",
                Number.isFinite(n) ? Math.max(0, Math.min(30, n)) : 0,
              );
            }}
            disabled={!state.tax_show_section && state.tax_rate_pct === 0}
            className="w-24"
          />
        </Field>
      </Section>

      {/* Section: Notice Copy (collapsible) */}
      <Section
        title="Notice copy"
        collapsible
        collapsed={!showNotices}
        onToggle={() => setShowNotices((v) => !v)}
      >
        {showNotices && (
          <>
            <Field
              id="vat-text"
              label="VAT notice"
              description="Optional — renderer falls back to the default VAT explanation."
            >
              <textarea
                id="vat-text"
                value={state.vat_text}
                onChange={(e) => patch("vat_text", e.target.value)}
                rows={2}
                className="flex w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </Field>
            <Field
              id="payment-instructions-text"
              label="Payment instructions"
              description="Optional — renderer falls back to default payment instructions."
            >
              <textarea
                id="payment-instructions-text"
                value={state.payment_instructions_text}
                onChange={(e) =>
                  patch("payment_instructions_text", e.target.value)
                }
                rows={3}
                className="flex w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </Field>
            <Field
              id="signature-disclaimer"
              label="Signature disclaimer"
              description="Optional — renderer defaults to “Computer generated, valid without signature.”"
            >
              <textarea
                id="signature-disclaimer"
                value={state.signature_disclaimer}
                onChange={(e) => patch("signature_disclaimer", e.target.value)}
                rows={2}
                className="flex w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </Field>
          </>
        )}
      </Section>

      {showPrefixWarning && (
        <Banner tone="warn" title="Invoice prefix not set">
          Invoice prefix is required to download bills as PDFs — bills cannot
          be generated until you set this.
        </Banner>
      )}

      {outcome?.kind === "success" && (
        <Banner tone="success" title="Saved">
          {outcome.message}
        </Banner>
      )}

      {outcome?.kind === "error" && (
        <Banner tone="destructive" title="Could not save">
          {outcome.message}
        </Banner>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={handlePreview}
          disabled={previewing}
          className="rounded-md border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          {previewing ? "Generating preview…" : "Preview bill"}
        </button>
        <button
          type="submit"
          disabled={saving}
          aria-busy={saving}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

// ── Internal layout primitives ────────────────────────────────────────────

function Section({
  title,
  children,
  collapsible = false,
  collapsed = false,
  onToggle,
}: {
  title: string;
  children: React.ReactNode;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  return (
    <section className="rounded-md border border-border bg-card p-5 shadow-elev-1">
      <div className="mb-4 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        {collapsible && (
          <button
            type="button"
            onClick={onToggle}
            className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
            aria-expanded={!collapsed}
          >
            {collapsed ? "Show" : "Hide"}
          </button>
        )}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Field({
  id,
  label,
  description,
  children,
}: {
  id: string;
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1 block text-xs font-medium text-foreground"
      >
        {label}
      </label>
      {children}
      {description && (
        <p className="mt-1 text-[11px] text-muted-foreground">{description}</p>
      )}
    </div>
  );
}
