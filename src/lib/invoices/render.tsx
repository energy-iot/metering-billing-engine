/**
 * render.tsx — pure-function PDF renderer for the consumer-facing invoice
 * (#203 / PDF1b). Layout matches Aaron's NFE template
 * (`/Users/amalbet/Downloads/nfe_energy_bill_template.html`).
 *
 * Per locked decision D5: NO database access. All joins are resolved by the
 * route handler and passed via the explicit `RenderInvoiceInput` bag. This
 * keeps the function forward-compatible with future tenant-app endpoints
 * (additive parameter add is non-breaking).
 *
 * Per D14: ships Inter Regular + Bold TTFs from `./fonts/`. Registered via
 * `Font.register({ src: <absolute fs path> })` — `@react-pdf/font@4.x`'s
 * `_load()` branches to `fontkit.open(src)` in Node when src is neither a
 * URL nor a `data:` URI (verified at the upstream font-source.ts source).
 *
 * Per D15: PDF `creationDate` set to `lineItem.created_at` for byte-stable
 * output. Caveat documented at the call site if the @react-pdf upstream
 * silently ignores the prop.
 *
 * Per AC3: validates input via `parseInvoiceConfig()`. ZodErrors propagate
 * to the caller (the route handler maps them to 422). Other throws are
 * 500.
 */

import "server-only";

import * as React from "react";
import path from "node:path";
import {
  Document,
  Font,
  Image,
  Link,
  Page,
  StyleSheet,
  Svg,
  Text,
  View,
  Path,
  renderToBuffer,
} from "@react-pdf/renderer";

import { formatCurrency } from "@/components/format/currency";
import { formatKwh } from "@/components/format/kwh";
import { formatLocalDate } from "@/components/format/local-date";
import type {
  BillingLineItem,
  Community,
  Device,
  Household,
  Organization,
  RateSchedule,
} from "@/lib/types/domain";

import {
  DEFAULT_PAYMENT_INSTRUCTIONS_TEXT,
  DEFAULT_SIGNATURE_DISCLAIMER,
  DEFAULT_VAT_TEXT,
} from "./default-copy";
import { type InvoiceConfig, parseInvoiceConfig } from "./config-schema";

// ── Font registration ────────────────────────────────────────────────────────
//
// Module-init side-effect. Re-registering the same family is idempotent in
// @react-pdf/font (each register call replaces the prior entry); even if the
// renderer module is re-imported in a hot-reload scenario the result is a
// stable Inter family.
//
// Plan B (architect note): if the fs-path approach fails on Vercel
// (process.cwd() resolving differently than expected at runtime), fall back
// to reading the TTFs as Buffers + registering as `data:` URIs:
//
//   import fs from "node:fs";
//   const regular = `data:application/x-font-ttf;base64,${
//     fs.readFileSync(REGULAR_PATH).toString("base64")}`;
//   Font.register({ family: "Inter", fonts: [{ src: regular, fontWeight: 400 }, …] });
//
// Adds ~170KB to module-init memory; only switch on demonstrable failure in
// a deployed preview.

const FONTS_DIR = path.join(process.cwd(), "src/lib/invoices/fonts");
Font.register({
  family: "Inter",
  fonts: [
    { src: path.join(FONTS_DIR, "Inter-Regular.ttf"), fontWeight: 400 },
    { src: path.join(FONTS_DIR, "Inter-Bold.ttf"), fontWeight: 700 },
  ],
});

// ── Public types ─────────────────────────────────────────────────────────────

export interface RenderInvoiceInput {
  /** The line item (BC1 columns include manual_reason / reading_source / entered_at). */
  lineItem: BillingLineItem;
  household: Household;
  /** community.invoice_config + invoice_prefix drive most of the layout. */
  community: Community;
  organization: Organization;
  ratesSchedule: RateSchedule;
  /** /pay redirect URL (D6); null → Payment Information card omitted. */
  paymentRedirectUrl: string | null;
  /** Pre-formatted via formatInvoiceNumber() (PDF1a's helper). */
  invoiceNumber: string;
  /** Pre-fetched logo bytes (route uses service-role download). */
  logoBytes: Buffer | null;
  /** Single meter device for the household (route picks first by created_at). */
  meterDevice: Device | null;
  /** Display name for `lineItem.entered_by_user_id` when reading_source='manual'. */
  enteredByUserName: string | null;
  /**
   * Microgrid currency code (e.g. "UGX"). Threaded explicitly so the
   * renderer remains pure (D5) — the route handler reads `microgrids.currency`
   * via the existing scope JOIN. Defaults to "UGX" if unset.
   */
  currency?: string | null;
  /**
   * Billing-period start/end dates from billing_periods (NOT on lineItem).
   * Route handler joins billing_period and threads the ISO date strings here.
   * The "Billing Period" meta cell shows "—" when omitted.
   */
  billingPeriodStart?: string | null;
  billingPeriodEnd?: string | null;
}

// ── Visual constants ─────────────────────────────────────────────────────────

const DEFAULTS = {
  primaryColor: "#163a5f",
  accentColor: "#2f7d32",
  documentTitle: "Invoice",
  dueDaysAfterIssue: 8,
  taxCategoryLabel: "VAT",
  taxRatePct: 18,
} as const;

// Page is 595×842pt (A4). Margins keep content centered. Tight values
// chosen to keep the bill on a single page with a typical 3-tier
// breakdown — verified against F1 (full-config-with-logo, 5 fixtures).
const PAGE_PADDING_X = 24;
const PAGE_PADDING_Y = 20;

const COLORS = {
  text: "#1f2937",
  muted: "#6b7280",
  line: "#d1d5db",
  soft: "#f8fafc",
  soft2: "#eef4f8",
  noteBorder: "#bbf7d0",
  noteBg: "#f0fdf4",
  noteFg: "#166534",
  taxLineBg: "#fff7ed",
  taxLineFg: "#9a3412",
} as const;

// ── Style helpers ────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  page: {
    fontFamily: "Inter",
    fontSize: 8,
    color: COLORS.text,
    paddingTop: PAGE_PADDING_Y,
    paddingBottom: PAGE_PADDING_Y,
    paddingHorizontal: PAGE_PADDING_X,
  },
  bill: {
    border: `1 solid ${COLORS.line}`,
    borderRadius: 2,
  },
  topbar: {
    height: 5,
    flexDirection: "row",
  },
  topbarLeft: {
    flex: 1,
  },
  topbarRight: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    padding: 10,
    borderBottom: `1 solid ${COLORS.line}`,
  },
  headerLeft: {
    flex: 1.4,
    flexDirection: "row",
    paddingRight: 8,
  },
  headerRight: {
    flex: 1,
  },
  logoBox: {
    width: 56,
    height: 56,
    marginRight: 8,
  },
  logo: {
    width: "100%",
    height: "100%",
    objectFit: "contain",
  },
  brandTitle: {
    fontSize: 14,
    fontWeight: 700,
    marginBottom: 2,
    letterSpacing: 0.2,
  },
  tagline: {
    fontWeight: 700,
    fontSize: 7.5,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  legal: {
    fontSize: 7.5,
    color: COLORS.muted,
    marginBottom: 1,
    lineHeight: 1.3,
  },
  contact: {
    fontSize: 7.5,
    color: COLORS.muted,
    marginBottom: 1,
    lineHeight: 1.3,
  },
  invoiceBox: {
    backgroundColor: COLORS.soft2,
    border: "1 solid #c7d5e0",
    borderRadius: 4,
    padding: 8,
  },
  invoiceTitle: {
    fontSize: 12,
    fontWeight: 700,
    marginBottom: 6,
    textAlign: "right",
  },
  metaGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  metaItem: {
    width: "50%",
    marginBottom: 4,
    paddingRight: 4,
  },
  label: {
    color: COLORS.muted,
    fontSize: 6.5,
    textTransform: "uppercase",
    letterSpacing: 0.3,
    marginBottom: 1,
  },
  value: {
    fontWeight: 700,
    fontSize: 8.5,
  },
  section: {
    paddingHorizontal: 10,
    paddingTop: 8,
  },
  sectionTitle: {
    fontSize: 8.5,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  twoCol: {
    flexDirection: "row",
  },
  card: {
    border: `1 solid ${COLORS.line}`,
    borderRadius: 4,
    overflow: "hidden",
  },
  cardLeft: {
    flex: 1,
    marginRight: 6,
  },
  cardRight: {
    flex: 1,
  },
  cardHeader: {
    backgroundColor: COLORS.soft,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderBottom: `1 solid ${COLORS.line}`,
    fontSize: 8,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  cardBody: {
    padding: 8,
  },
  detailRow: {
    flexDirection: "row",
    marginBottom: 4,
  },
  detailHalf: {
    flex: 1,
    paddingRight: 4,
  },
  detailFull: {
    width: "100%",
  },
  table: {
    borderTop: `1 solid ${COLORS.line}`,
  },
  tableHead: {
    flexDirection: "row",
    backgroundColor: COLORS.soft,
    borderBottom: `1 solid ${COLORS.line}`,
  },
  th: {
    paddingVertical: 4,
    paddingHorizontal: 4,
    fontSize: 7.5,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  tableRow: {
    flexDirection: "row",
    borderBottom: `1 solid ${COLORS.line}`,
  },
  td: {
    paddingVertical: 4,
    paddingHorizontal: 4,
    fontSize: 8,
  },
  tdNum: {
    paddingVertical: 4,
    paddingHorizontal: 4,
    fontSize: 8,
    textAlign: "right",
  },
  subtotalRow: {
    flexDirection: "row",
    backgroundColor: "#fafafa",
    borderBottom: `1 solid ${COLORS.line}`,
  },
  subtotalLabel: {
    paddingVertical: 4,
    paddingHorizontal: 4,
    fontWeight: 700,
    fontSize: 8,
  },
  subtotalAmount: {
    paddingVertical: 4,
    paddingHorizontal: 4,
    fontWeight: 700,
    fontSize: 8,
    textAlign: "right",
  },
  totalsWrap: {
    flexDirection: "row",
    paddingHorizontal: 10,
    paddingTop: 8,
  },
  noteBox: {
    flex: 1.2,
    border: `1 solid ${COLORS.noteBorder}`,
    backgroundColor: COLORS.noteBg,
    borderRadius: 4,
    padding: 8,
    marginRight: 6,
    fontSize: 8,
    lineHeight: 1.4,
  },
  noteBoxStrong: {
    fontWeight: 700,
    color: COLORS.noteFg,
  },
  totalsBox: {
    flex: 0.8,
    border: `1 solid ${COLORS.line}`,
    borderRadius: 4,
    overflow: "hidden",
  },
  totalsRow: {
    flexDirection: "row",
    borderBottom: `1 solid ${COLORS.line}`,
  },
  totalsTaxRow: {
    flexDirection: "row",
    borderBottom: `1 solid ${COLORS.line}`,
    backgroundColor: COLORS.taxLineBg,
  },
  totalsLabel: {
    flex: 1,
    paddingVertical: 5,
    paddingHorizontal: 8,
    fontSize: 8,
  },
  totalsLabelBold: {
    flex: 1,
    paddingVertical: 5,
    paddingHorizontal: 8,
    fontSize: 8,
    fontWeight: 700,
    color: COLORS.taxLineFg,
  },
  totalsAmount: {
    paddingVertical: 5,
    paddingHorizontal: 8,
    fontSize: 8,
    textAlign: "right",
    minWidth: 80,
  },
  totalsAmountBold: {
    paddingVertical: 5,
    paddingHorizontal: 8,
    fontSize: 8,
    textAlign: "right",
    fontWeight: 700,
    color: COLORS.taxLineFg,
    minWidth: 80,
  },
  grandTotalRow: {
    flexDirection: "row",
  },
  grandTotalLabel: {
    flex: 1,
    paddingVertical: 7,
    paddingHorizontal: 8,
    fontSize: 10,
    fontWeight: 700,
    color: "#ffffff",
  },
  grandTotalAmount: {
    paddingVertical: 7,
    paddingHorizontal: 8,
    fontSize: 10,
    fontWeight: 700,
    textAlign: "right",
    color: "#ffffff",
    minWidth: 80,
  },
  footer: {
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  footerGrid: {
    flexDirection: "row",
  },
  payCallout: {
    border: "1 solid #86efac",
    backgroundColor: "#f0fdf4",
    borderRadius: 6,
    padding: 8,
  },
  payLabel: {
    fontSize: 7,
    color: COLORS.noteFg,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    fontWeight: 700,
    marginBottom: 4,
  },
  payButton: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 4,
    color: "#ffffff",
    fontWeight: 700,
    fontSize: 11,
    textAlign: "center",
    textDecoration: "none",
    marginVertical: 4,
  },
  payLinkText: {
    fontSize: 7,
    color: COLORS.muted,
    lineHeight: 1.3,
  },
  payNote: {
    fontSize: 7,
    color: COLORS.noteFg,
    marginTop: 4,
    lineHeight: 1.3,
  },
  small: {
    fontSize: 7.5,
    color: COLORS.muted,
    lineHeight: 1.4,
  },
  whatsappLink: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#2f7d32",
    color: "#ffffff",
    fontWeight: 700,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 3,
    fontSize: 8,
    textDecoration: "none",
    marginTop: 3,
    marginBottom: 3,
  },
  watermark: {
    fontSize: 6.5,
    color: COLORS.muted,
    textAlign: "center",
    marginTop: 6,
  },
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** "1 Apr – 30 Apr 2026" — the billing-period date range. */
function formatBillingPeriodRange(
  startDate: string,
  endDate: string,
  locale: string,
): string {
  const sd = new Date(startDate);
  const ed = new Date(endDate);
  if (Number.isNaN(sd.getTime()) || Number.isNaN(ed.getTime())) {
    return "—";
  }
  const sameYear = sd.getUTCFullYear() === ed.getUTCFullYear();
  const startStr = formatLocalDate(
    sd,
    locale,
    sameYear
      ? { day: "numeric", month: "short" }
      : { day: "numeric", month: "short", year: "numeric" },
  );
  const endStr = formatLocalDate(ed, locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${startStr} – ${endStr}`;
}

/** "Edge reading captured 22 Apr 2026" / fallback text per AC3. */
function buildReadingSourceLines(input: RenderInvoiceInput, locale: string): {
  primary: string;
  reason: string | null;
} {
  const { lineItem, enteredByUserName } = input;
  const src = lineItem.reading_source;

  if (src === "manual") {
    const who = enteredByUserName?.trim() || "Operator";
    const primary = `Manual entry by ${who}`;
    const reason = lineItem.manual_reason && lineItem.manual_reason.trim().length > 0
      ? `Reason: ${lineItem.manual_reason.trim()}`
      : null;
    return { primary, reason };
  }

  if (src === "edge") {
    if (lineItem.entered_at) {
      const when = formatLocalDate(lineItem.entered_at, locale);
      return { primary: `Edge reading captured ${when}`, reason: null };
    }
    return { primary: "Edge reading captured", reason: null };
  }

  return { primary: "Reading source unavailable", reason: null };
}

// Locale + currency are derived once per render.
function deriveLocale(): string {
  // The renderer is server-side and has no Accept-Language. Use the
  // operator-default `en-GB` (24-hr time, day-month order — consistent with
  // the URA paste workflow Aaron uses). Future enhancement: pass through
  // community.locale or organization.locale once the schema gets it.
  return "en-GB";
}

// ── WhatsApp icon (SVG path baked from Aaron's template) ─────────────────────

function WhatsAppIcon() {
  return (
    <Svg viewBox="0 0 32 32" width={12} height={12}>
      <Path
        d="M16.001 3C9.373 3 4 8.372 4 15c0 2.64.86 5.08 2.32 7.06L4 29l7.11-2.29A11.95 11.95 0 0016 27c6.627 0 12-5.373 12-12S22.628 3 16 3zm0 21.6c-1.99 0-3.86-.58-5.44-1.58l-.39-.24-4.22 1.36 1.37-4.11-.25-.42A9.53 9.53 0 016.4 15c0-5.29 4.31-9.6 9.6-9.6s9.6 4.31 9.6 9.6-4.31 9.6-9.6 9.6zm5.25-7.21c-.29-.15-1.7-.84-1.96-.94-.26-.1-.45-.15-.64.15-.19.29-.73.94-.9 1.13-.17.19-.34.22-.63.07-.29-.15-1.23-.45-2.34-1.44-.86-.77-1.44-1.72-1.61-2.01-.17-.29-.02-.45.13-.6.13-.13.29-.34.44-.51.15-.17.19-.29.29-.49.1-.19.05-.37-.02-.51-.07-.15-.64-1.54-.88-2.11-.23-.55-.46-.48-.64-.49l-.55-.01c-.19 0-.51.07-.78.37-.27.29-1.03 1.01-1.03 2.46 0 1.44 1.06 2.83 1.2 3.03.15.19 2.08 3.17 5.03 4.45.7.3 1.24.48 1.66.61.7.22 1.33.19 1.83.12.56-.08 1.7-.7 1.94-1.37.24-.67.24-1.25.17-1.37-.07-.12-.26-.19-.55-.34z"
        fill="#ffffff"
      />
    </Svg>
  );
}

// ── Renderer (React tree) ────────────────────────────────────────────────────

interface RenderProps {
  input: RenderInvoiceInput;
  config: InvoiceConfig;
  locale: string;
  currency: string;
  primary: string;
  accent: string;
  documentTitle: string;
  issueDate: Date;
  dueDate: Date;
  energySubtotal: number;
  serviceCharge: number;
  preTaxSubtotal: number;
  taxAmount: number;
  taxNetAmount: number;
  taxRatePct: number;
  showTax: boolean;
  taxCategoryLabel: string;
  vatNoticeText: string;
  paymentInstructionsText: string;
  signatureDisclaimer: string;
  brandTitle: string;
  legalName: string;
  tagline: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  whatsappNumber: string | null;
  addressLines: string[];
  taxIdLines: string[];
}

function InvoiceDocument(props: RenderProps): React.ReactElement {
  const { input, primary, accent } = props;
  const { lineItem, household, ratesSchedule } = input;

  const meterIdValue =
    household.meter_serial?.trim() ||
    input.meterDevice?.openems_component_id ||
    input.meterDevice?.name ||
    "—";
  const customerTypeValue =
    (household.customer_type ?? "").length > 0
      ? household.customer_type.charAt(0).toUpperCase() +
        household.customer_type.slice(1)
      : "Residential";
  const meterTypeValue =
    household.meter_type?.trim() || "Smart Submeter";

  const startKwh = lineItem.start_kwh ?? 0;
  const endKwh = lineItem.end_kwh ?? startKwh + (lineItem.usage_kwh ?? 0);
  const usageKwh = lineItem.usage_kwh ?? Math.max(0, endKwh - startKwh);
  const totalAmount = lineItem.total_amount ?? 0;

  const serviceAddress = [
    household.unit_label,
    household.address_line1,
    household.address_line2,
    household.address_city,
    household.address_country,
  ]
    .map((s) => (s ?? "").trim())
    .filter((s) => s.length > 0)
    .join(", ");

  const billingPeriodRange =
    input.billingPeriodStart && input.billingPeriodEnd
      ? formatBillingPeriodRange(
          input.billingPeriodStart,
          input.billingPeriodEnd,
          props.locale,
        )
      : "—";

  const readingSrc = buildReadingSourceLines(input, props.locale);

  const tariffPlan = (() => {
    // Take the first tier label as the display plan name fallback.
    const tiers = ratesSchedule.tiers ?? [];
    if (tiers.length === 0) return "Tariff";
    return `${tiers.length}-Tier Tariff`;
  })();

  return (
    <Document
      title={`${props.documentTitle} ${input.invoiceNumber}`}
      author={props.legalName}
      creator="Metering & Billing Engine"
      producer="@react-pdf/renderer"
      // D15: byte-stable creationDate. Upstream may silently ignore — see
      // module-level note + AC5 byte-stability flag.
      creationDate={new Date(lineItem.created_at)}
      language={props.locale}
    >
      <Page size="A4" style={styles.page} wrap={false}>
        <View style={styles.bill} wrap={false}>
          {/* Top gradient bar — react-pdf has no CSS gradient; we emulate
              with a horizontal split into two solid colors. */}
          <View style={styles.topbar}>
            <View style={[styles.topbarLeft, { backgroundColor: primary }]} />
            <View style={[styles.topbarRight, { backgroundColor: accent }]} />
          </View>

          {/* HEADER */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              {input.logoBytes ? (
                <View style={styles.logoBox}>
                  {/* @react-pdf/renderer's <Image> is not the DOM <img>;
                      it doesn't accept (or need) an `alt` prop. The
                      jsx-a11y rule fires because both share the symbol
                      name. Suppress narrowly here. */}
                  {/* eslint-disable-next-line jsx-a11y/alt-text */}
                  <Image src={input.logoBytes} style={styles.logo} />
                </View>
              ) : null}
              <View style={{ flex: 1 }}>
                <Text style={[styles.brandTitle, { color: primary }]}>
                  {props.brandTitle}
                </Text>
                {props.tagline ? (
                  <Text style={[styles.tagline, { color: accent }]}>
                    {props.tagline}
                  </Text>
                ) : null}
                <Text style={styles.legal}>{props.legalName}</Text>
                {props.addressLines.map((line, i) => (
                  <Text key={`addr-${i}`} style={styles.contact}>
                    {line}
                  </Text>
                ))}
                {props.contactPhone || props.contactEmail ? (
                  <Text style={styles.contact}>
                    {[
                      props.contactPhone ? `Tel: ${props.contactPhone}` : null,
                      props.contactEmail ? `Email: ${props.contactEmail}` : null,
                    ]
                      .filter(Boolean)
                      .join("  |  ")}
                  </Text>
                ) : null}
                {props.taxIdLines.map((line, i) => (
                  <Text key={`tid-${i}`} style={styles.contact}>
                    {line}
                  </Text>
                ))}
              </View>
            </View>

            <View style={styles.headerRight}>
              <View style={styles.invoiceBox}>
                <Text style={[styles.invoiceTitle, { color: primary }]}>
                  {props.documentTitle}
                </Text>
                <View style={styles.metaGrid}>
                  <MetaItem label="Invoice No." value={input.invoiceNumber} />
                  <MetaItem
                    label="Issue Date"
                    value={formatLocalDate(props.issueDate, props.locale)}
                  />
                  <MetaItem label="Billing Period" value={billingPeriodRange} />
                  <MetaItem
                    label="Due Date"
                    value={formatLocalDate(props.dueDate, props.locale)}
                  />
                  <MetaItem label="Tariff Plan" value={tariffPlan} />
                  <MetaItem label="Currency" value={props.currency} />
                </View>
              </View>
            </View>
          </View>

          {/* CUSTOMER + METER CARDS */}
          <View style={styles.section}>
            <View style={styles.twoCol}>
              <View style={[styles.card, styles.cardLeft]}>
                <Text style={[styles.cardHeader, { color: primary }]}>
                  Customer Details
                </Text>
                <View style={styles.cardBody}>
                  <View style={styles.detailRow}>
                    <View style={styles.detailHalf}>
                      <Text style={styles.label}>Customer Name</Text>
                      <Text style={styles.value}>{household.display_name}</Text>
                    </View>
                    <View style={styles.detailHalf}>
                      <Text style={styles.label}>Account Number</Text>
                      <Text style={styles.value}>
                        {household.account_number?.trim() || "—"}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.detailRow}>
                    <View style={styles.detailHalf}>
                      <Text style={styles.label}>Meter ID</Text>
                      <Text style={styles.value}>{meterIdValue}</Text>
                    </View>
                    <View style={styles.detailHalf}>
                      <Text style={styles.label}>Customer Type</Text>
                      <Text style={styles.value}>{customerTypeValue}</Text>
                    </View>
                  </View>
                  <View style={styles.detailFull}>
                    <Text style={styles.label}>Service Address</Text>
                    <Text style={styles.value}>
                      {serviceAddress || "—"}
                    </Text>
                  </View>
                </View>
              </View>

              <View style={[styles.card, styles.cardRight]}>
                <Text style={[styles.cardHeader, { color: primary }]}>
                  Meter & Usage Summary
                </Text>
                <View style={styles.cardBody}>
                  <View style={styles.detailRow}>
                    <View style={styles.detailHalf}>
                      <Text style={styles.label}>Previous Reading</Text>
                      <Text style={styles.value}>
                        {formatKwh(startKwh, props.locale, { digits: 2 })} kWh
                      </Text>
                    </View>
                    <View style={styles.detailHalf}>
                      <Text style={styles.label}>Current Reading</Text>
                      <Text style={styles.value}>
                        {formatKwh(endKwh, props.locale, { digits: 2 })} kWh
                      </Text>
                    </View>
                  </View>
                  <View style={styles.detailRow}>
                    <View style={styles.detailHalf}>
                      <Text style={styles.label}>Total Consumption</Text>
                      <Text style={styles.value}>
                        {formatKwh(usageKwh, props.locale, { digits: 2 })} kWh
                      </Text>
                    </View>
                    <View style={styles.detailHalf}>
                      <Text style={styles.label}>Meter Type</Text>
                      <Text style={styles.value}>{meterTypeValue}</Text>
                    </View>
                  </View>
                  <View style={styles.detailFull}>
                    <Text style={styles.label}>Reading Source</Text>
                    <Text style={styles.value}>{readingSrc.primary}</Text>
                    {readingSrc.reason ? (
                      <Text
                        style={[
                          styles.value,
                          { fontWeight: 400, color: COLORS.muted, fontSize: 8.5 },
                        ]}
                      >
                        {readingSrc.reason}
                      </Text>
                    ) : null}
                  </View>
                </View>
              </View>
            </View>
          </View>

          {/* ENERGY CHARGES TABLE */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: primary }]}>
              Energy Charges
            </Text>
            <View style={styles.table}>
              <View style={styles.tableHead}>
                <Text style={[styles.th, { color: primary, flex: 2 }]}>
                  Line Item
                </Text>
                <Text
                  style={[styles.th, { color: primary, flex: 1, textAlign: "right" }]}
                >
                  Usage (kWh)
                </Text>
                <Text
                  style={[styles.th, { color: primary, flex: 1, textAlign: "right" }]}
                >
                  Rate ({props.currency} / kWh)
                </Text>
                <Text
                  style={[styles.th, { color: primary, flex: 1, textAlign: "right" }]}
                >
                  Amount ({props.currency})
                </Text>
              </View>
              {(lineItem.tier_breakdown ?? []).map((row, i) => {
                const tierConfig = (ratesSchedule.tiers ?? []).find(
                  (t) => t.label === row.label,
                );
                const rate = tierConfig?.rate_per_kwh ?? null;
                return (
                  <View key={`tier-${i}`} style={styles.tableRow}>
                    <Text style={[styles.td, { flex: 2 }]}>
                      {tierConfig
                        ? `${row.label} (${tierConfig.min_kwh}${
                            tierConfig.max_kwh != null
                              ? `–${tierConfig.max_kwh}`
                              : "+"
                          } kWh)`
                        : row.label}
                    </Text>
                    <Text style={[styles.tdNum, { flex: 1 }]}>
                      {formatKwh(row.kwh, props.locale, { digits: 2 })}
                    </Text>
                    <Text style={[styles.tdNum, { flex: 1 }]}>
                      {rate != null
                        ? formatCurrency(rate, props.locale, props.currency, {
                            bareNumber: true,
                          })
                        : "—"}
                    </Text>
                    <Text style={[styles.tdNum, { flex: 1 }]}>
                      {formatCurrency(row.amount, props.locale, props.currency, {
                        bareNumber: true,
                      })}
                    </Text>
                  </View>
                );
              })}
              <View style={styles.subtotalRow}>
                <Text style={[styles.subtotalLabel, { flex: 4 }]}>
                  Subtotal – Energy Charges
                </Text>
                <Text style={[styles.subtotalAmount, { flex: 1 }]}>
                  {formatCurrency(
                    props.energySubtotal,
                    props.locale,
                    props.currency,
                    { bareNumber: true },
                  )}
                </Text>
              </View>
            </View>
          </View>

          {/* OTHER CHARGES TABLE */}
          {props.serviceCharge > 0 ? (
            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: primary }]}>
                Other Charges
              </Text>
              <View style={styles.table}>
                <View style={styles.tableHead}>
                  <Text style={[styles.th, { color: primary, flex: 1 }]}>
                    Line Item
                  </Text>
                  <Text style={[styles.th, { color: primary, flex: 2 }]}>
                    Description
                  </Text>
                  <Text
                    style={[styles.th, { color: primary, flex: 1, textAlign: "right" }]}
                  >
                    Amount ({props.currency})
                  </Text>
                </View>
                <View style={styles.tableRow}>
                  <Text style={[styles.td, { flex: 1 }]}>Service Charge</Text>
                  <Text style={[styles.td, { flex: 2 }]}>
                    {ratesSchedule.service_charge_description?.trim() ||
                      "Service charge"}
                  </Text>
                  <Text style={[styles.tdNum, { flex: 1 }]}>
                    {formatCurrency(
                      props.serviceCharge,
                      props.locale,
                      props.currency,
                      { bareNumber: true },
                    )}
                  </Text>
                </View>
                <View style={styles.subtotalRow}>
                  <Text style={[styles.subtotalLabel, { flex: 3 }]}>
                    Subtotal – Other Charges
                  </Text>
                  <Text style={[styles.subtotalAmount, { flex: 1 }]}>
                    {formatCurrency(
                      props.serviceCharge,
                      props.locale,
                      props.currency,
                      { bareNumber: true },
                    )}
                  </Text>
                </View>
              </View>
            </View>
          ) : null}

          {/* TOTALS */}
          <View style={styles.totalsWrap}>
            {props.showTax ? (
              <View style={styles.noteBox}>
                <Text>
                  <Text style={styles.noteBoxStrong}>
                    {props.taxCategoryLabel} Notice:{" "}
                  </Text>
                  {props.vatNoticeText.replace(
                    "{rate_pct}",
                    String(props.taxRatePct),
                  )}
                </Text>
              </View>
            ) : (
              <View style={styles.noteBox}>
                <Text>
                  Please pay by the due date to avoid service interruption or
                  late-payment follow-up under your service agreement.
                </Text>
              </View>
            )}

            <View style={styles.totalsBox}>
              <View style={styles.totalsRow}>
                <Text style={styles.totalsLabel}>Subtotal – Energy Charges</Text>
                <Text style={styles.totalsAmount}>
                  {formatCurrency(
                    props.energySubtotal,
                    props.locale,
                    props.currency,
                    { bareNumber: true },
                  )}
                </Text>
              </View>
              {props.serviceCharge > 0 ? (
                <View style={styles.totalsRow}>
                  <Text style={styles.totalsLabel}>
                    Subtotal – Other Charges
                  </Text>
                  <Text style={styles.totalsAmount}>
                    {formatCurrency(
                      props.serviceCharge,
                      props.locale,
                      props.currency,
                      { bareNumber: true },
                    )}
                  </Text>
                </View>
              ) : null}
              {props.showTax ? (
                <>
                  <View style={styles.totalsRow}>
                    <Text style={styles.totalsLabel}>Taxable Subtotal</Text>
                    <Text style={styles.totalsAmount}>
                      {formatCurrency(
                        props.taxNetAmount,
                        props.locale,
                        props.currency,
                        { bareNumber: true },
                      )}
                    </Text>
                  </View>
                  <View style={styles.totalsTaxRow}>
                    <Text style={styles.totalsLabelBold}>
                      {`${props.taxCategoryLabel} @ ${props.taxRatePct}%`}
                    </Text>
                    <Text style={styles.totalsAmountBold}>
                      {formatCurrency(
                        props.taxAmount,
                        props.locale,
                        props.currency,
                        { bareNumber: true },
                      )}
                    </Text>
                  </View>
                </>
              ) : null}
              <View style={[styles.grandTotalRow, { backgroundColor: primary }]}>
                <Text style={styles.grandTotalLabel}>Total Amount Due</Text>
                <Text style={styles.grandTotalAmount}>
                  {`${formatCurrency(totalAmount, props.locale, props.currency, {
                    bareNumber: true,
                  })} ${props.currency}`}
                </Text>
              </View>
            </View>
          </View>

          {/* FOOTER */}
          <View style={styles.footer}>
            <View style={styles.footerGrid}>
              {input.paymentRedirectUrl ? (
                <View style={[styles.card, styles.cardLeft]}>
                  <Text style={[styles.cardHeader, { color: primary }]}>
                    Payment Information
                  </Text>
                  <View style={styles.cardBody}>
                    <View style={styles.payCallout}>
                      <Text style={styles.payLabel}>Online Payment</Text>
                      <Link
                        src={input.paymentRedirectUrl}
                        style={[styles.payButton, { backgroundColor: accent }]}
                      >
                        Pay Now
                      </Link>
                      <Text style={styles.payLinkText}>
                        <Text style={{ fontWeight: 700 }}>Payment Link: </Text>
                        {input.paymentRedirectUrl}
                      </Text>
                      <Text style={styles.payNote}>
                        {props.paymentInstructionsText}
                      </Text>
                    </View>
                  </View>
                </View>
              ) : null}

              <View
                style={[
                  styles.card,
                  input.paymentRedirectUrl ? styles.cardRight : { flex: 1 },
                ]}
              >
                <Text style={[styles.cardHeader, { color: primary }]}>
                  Customer Support
                </Text>
                <View style={styles.cardBody}>
                  <Text style={styles.small}>
                    For billing questions, outages, or payment support, contact
                    {` ${props.brandTitle} `}using the details in the header
                    above.
                  </Text>
                  {props.whatsappNumber ? (
                    <>
                      <Text style={[styles.small, { marginTop: 6 }]}>
                        <Text style={{ fontWeight: 700 }}>WhatsApp Business:</Text>
                      </Text>
                      <Link
                        src={`https://wa.me/${props.whatsappNumber.replace(
                          /[^0-9]/g,
                          "",
                        )}`}
                        style={styles.whatsappLink}
                      >
                        <WhatsAppIcon />
                        <Text style={{ marginLeft: 6, color: "#ffffff" }}>
                          {`Chat with us (${props.whatsappNumber})`}
                        </Text>
                      </Link>
                    </>
                  ) : null}
                  <Text style={[styles.small, { marginTop: 8 }]}>
                    {props.signatureDisclaimer}
                  </Text>
                </View>
              </View>
            </View>
          </View>
        </View>
      </Page>
    </Document>
  );
}

function MetaItem({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.ReactElement {
  return (
    <View style={styles.metaItem}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

// ── Public render API ────────────────────────────────────────────────────────

/**
 * Render a billing line item as a one-page consumer-facing PDF invoice.
 *
 * Pure function: no DB access. Caller resolves all joins and passes them via
 * the input bag. Throws `ZodError` when `community.invoice_config` fails
 * validation; the route handler maps that to 422.
 */
export async function renderInvoicePdf(
  input: RenderInvoiceInput,
): Promise<Buffer> {
  const config = parseInvoiceConfig(
    (input.community.invoice_config ?? {}) as unknown,
  );

  const locale = deriveLocale();
  const currency = input.currency?.trim() || "UGX";

  const seller = config.seller;
  const branding = config.branding ?? {};
  const tax = config.tax ?? { show_section: true, rate_pct: DEFAULTS.taxRatePct };
  const payment = config.payment ?? {
    due_days_after_issue: DEFAULTS.dueDaysAfterIssue,
  };
  const notices = config.notices ?? {};

  const primary = branding.primary_color ?? DEFAULTS.primaryColor;
  const accent = branding.accent_color ?? DEFAULTS.accentColor;
  const documentTitle = branding.document_title ?? DEFAULTS.documentTitle;

  // D7: tax shown by default. The Zod schema's `show_section` is optional;
  // when absent, behave as `true` (show), then disable when explicit false
  // OR rate is 0.
  const taxRatePct = tax.rate_pct ?? DEFAULTS.taxRatePct;
  const showSectionExplicit = tax.show_section;
  const showTax =
    (showSectionExplicit === undefined ? true : showSectionExplicit) &&
    taxRatePct > 0;
  const taxCategoryLabel = (() => {
    const fromConfig = tax.category_label?.trim();
    if (fromConfig && fromConfig.length > 0) {
      // Strip a trailing rate suffix to avoid "VAT @ 18% @ 18%" in the tax
      // line; the renderer always re-appends the rate.
      return fromConfig.replace(/\s*@\s*\d+\s*%\s*$/i, "");
    }
    return DEFAULTS.taxCategoryLabel;
  })();

  // Totals math.
  const totalAmount = input.lineItem.total_amount ?? 0;
  const serviceCharge = input.ratesSchedule.service_charge ?? 0;
  // tier_breakdown is BC1's authoritative per-line-item energy split.
  const energySubtotal = (input.lineItem.tier_breakdown ?? []).reduce(
    (acc, row) => acc + (row.amount ?? 0),
    0,
  );
  const preTaxSubtotal = energySubtotal + serviceCharge;
  // VAT-from-total derivation: taxable subtotal = total / (1 + rate/100).
  // This matches the convention used in Aaron's URA filing (gross-inclusive
  // displayed totals) — when the line item total already includes VAT, the
  // renderer shows the implied net + tax for transparency.
  const taxNetAmount = showTax
    ? Math.round((totalAmount / (1 + taxRatePct / 100)) * 100) / 100
    : preTaxSubtotal;
  const taxAmount = showTax
    ? Math.round((totalAmount - taxNetAmount) * 100) / 100
    : 0;

  // Issue + due dates.
  const issueDate = new Date(input.lineItem.created_at);
  const dueDays = payment.due_days_after_issue ?? DEFAULTS.dueDaysAfterIssue;
  const dueDate = new Date(issueDate);
  dueDate.setUTCDate(dueDate.getUTCDate() + dueDays);

  // Branding text fallbacks.
  const brandTitle = seller?.trade_name?.trim() || input.organization.name;
  const tagline = branding.tagline ?? "Customer Energy Bill";
  const legalName = seller?.legal_name ?? input.organization.name;
  const addressLines = (seller?.address_lines ?? []).filter(
    (line) => line.trim().length > 0,
  );
  const taxIdLines = (seller?.tax_ids ?? []).map(
    (t) => `${t.label}: ${t.value}`,
  );

  const whatsappNumber =
    branding.whatsapp_number ?? seller?.contact_phone ?? null;

  const vatNoticeText = notices.vat_text ?? DEFAULT_VAT_TEXT;
  const paymentInstructionsText =
    notices.payment_instructions_text ?? DEFAULT_PAYMENT_INSTRUCTIONS_TEXT;
  const signatureDisclaimer =
    notices.signature_disclaimer ?? DEFAULT_SIGNATURE_DISCLAIMER;

  const props: RenderProps = {
    input,
    config,
    locale,
    currency,
    primary,
    accent,
    documentTitle,
    issueDate,
    dueDate,
    energySubtotal,
    serviceCharge,
    preTaxSubtotal,
    taxAmount,
    taxNetAmount,
    taxRatePct,
    showTax,
    taxCategoryLabel,
    vatNoticeText,
    paymentInstructionsText,
    signatureDisclaimer,
    brandTitle,
    legalName,
    tagline,
    contactPhone: seller?.contact_phone ?? null,
    contactEmail: seller?.contact_email ?? null,
    whatsappNumber,
    addressLines,
    taxIdLines,
  };

  return renderToBuffer(<InvoiceDocument {...props} />);
}
