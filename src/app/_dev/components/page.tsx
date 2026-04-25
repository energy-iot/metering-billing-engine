"use client";

import * as React from "react";
import { LocaleProvider } from "@/components/format/locale-context";
import { Chip } from "@/components/ui/chip";
import { StatusChip } from "@/components/ui/status-chip";
import { CopyTable, type ColumnDef } from "@/components/ui/copy-table";
import { ClosePeriodDialog } from "@/components/ui/close-period-dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PeriodPicker, type PeriodOption } from "@/components/ui/period-picker";
import { HierarchyNav } from "@/components/ui/hierarchy-nav";
import { ConsumptionCell } from "@/components/ui/consumption-cell";
import { ConsumptionCalendar } from "@/components/ui/consumption-calendar";

// ─── CopyTable sample data ───────────────────────────────────────────────────

type HouseholdRow = {
  name: string;
  tier1Kwh: number;
  tier2Kwh: number;
  totalAmount: number;
};

const COPY_TABLE_ROWS: HouseholdRow[] = [
  { name: "Aisha M.",   tier1Kwh: 47.3, tier2Kwh: 12.1, totalAmount: 58400 },
  { name: "Bernard K.", tier1Kwh: 31.0, tier2Kwh:  0.0, totalAmount: 31000 },
  { name: "Cynthia O.", tier1Kwh: 52.8, tier2Kwh: 24.9, totalAmount: 77700 },
  { name: "David N.",   tier1Kwh: 18.5, tier2Kwh:  0.0, totalAmount: 18500 },
  { name: "Esther W.",  tier1Kwh: 44.2, tier2Kwh:  8.3, totalAmount: 52500 },
];

const COPY_TABLE_COLS: ColumnDef<HouseholdRow>[] = [
  { header: "Household", kind: "row-header", accessor: (r) => r.name },
  { header: "Tier 1 kWh", kind: "value", accessor: (r) => r.tier1Kwh },
  { header: "Tier 2 kWh", kind: "value", accessor: (r) => r.tier2Kwh },
  {
    header: "Total (UGX)",
    kind: "value",
    accessor: (r) => r.totalAmount,
    format: (v) => (v == null ? "—" : Number(v).toLocaleString()),
  },
];

// ─── PeriodPicker sample data ─────────────────────────────────────────────────

const SAMPLE_PERIODS: PeriodOption[] = [
  { id: "1", startDate: "2026-04-01", endDate: "2026-04-30", status: "draft",  totalAmount: 4216800 },
  { id: "2", startDate: "2026-03-01", endDate: "2026-03-31", status: "closed", totalAmount: 3870000 },
  { id: "3", startDate: "2026-02-01", endDate: "2026-02-28", status: "closed", totalAmount: 3540000 },
  { id: "4", startDate: "2026-01-01", endDate: "2026-01-31", status: "closed", totalAmount: 3910000 },
  { id: "5", startDate: "2025-12-01", endDate: "2025-12-31", status: "closed", totalAmount: 4050000 },
  { id: "6", startDate: "2025-12-15", endDate: "2025-12-15", status: "closed", totalAmount: 120000  },
];

// ─── ConsumptionCalendar sample data ─────────────────────────────────────────

const CALENDAR_DAYS = Array.from({ length: 30 }, (_, i) => {
  const day = i + 1;
  if (day > 21) return { day, pct: null, kwh: null, status: "future" as const };
  const pct = [0.4, 0.6, 0.82, 1.1, 1.4, 0.55, 0.7, 0.91, 0.3, 0.5,
               0.65, 0.78, 1.05, 0.45, 0.88, 0.72, 1.38, 0.6, 0.9, 0.35, 0.5][i] ?? 0.5;
  const kwh = +(pct * 4.8).toFixed(1);
  return { day, pct, kwh };
});

// ─── Section wrapper ──────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-12">
      <h2 className="mb-4 border-b border-border pb-2 text-base font-semibold text-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ComponentsDevPage() {
  const [closePeriodOpen, setClosePeriodOpen] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [confirmNeutralOpen, setConfirmNeutralOpen] = React.useState(false);
  const [confirmTypedOpen, setConfirmTypedOpen] = React.useState(false);
  const [currentPeriodId, setCurrentPeriodId] = React.useState("1");

  return (
    <LocaleProvider locale="en-UG" currency="UGX">
      <div className="mx-auto max-w-4xl px-6 py-10 font-sans text-foreground">
        <h1 className="mb-2 text-2xl font-semibold tracking-tight">Design System — Components</h1>
        <p className="mb-10 text-[13px] text-muted-foreground">
          Visual spec for T2 primitives. Not linked from production nav.
        </p>

        {/* ── Chip ── */}
        <Section title="Chip — tones × sizes × states">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Chip tone="neutral">Neutral</Chip>
              <Chip tone="success">Success</Chip>
              <Chip tone="warn">Warning</Chip>
              <Chip tone="alert">Alert</Chip>
              <Chip tone="brand">Brand</Chip>
            </div>
            <div className="flex flex-wrap gap-2">
              <Chip tone="success" dot>With dot</Chip>
              <Chip tone="warn" dot size="sm">Small dot</Chip>
              <Chip tone="neutral" state="disabled">Disabled</Chip>
              <Chip tone="success" state="stale">Stale</Chip>
              <Chip tone="brand" state="loading">Loading</Chip>
            </div>
            <div className="flex flex-wrap gap-2">
              <Chip tone="neutral" aria-label="Chip with aria-label" size="sm">SM neutral</Chip>
              <Chip tone="alert" size="sm">SM alert</Chip>
              <Chip tone="success" size="sm">SM success</Chip>
            </div>
          </div>
        </Section>

        {/* ── StatusChip ── */}
        <Section title="StatusChip — each kind">
          <div className="flex flex-wrap gap-2">
            <StatusChip kind="billingPeriod" status="draft" />
            <StatusChip kind="billingPeriod" status="closed" />
            <StatusChip kind="edge" status="online" />
            <StatusChip kind="edge" status="degraded" />
            <StatusChip kind="edge" status="offline" />
            <StatusChip kind="edge" status="stale" state="stale" />
            <StatusChip kind="household" status="active" />
            <StatusChip kind="household" status="inactive" />
            <StatusChip kind="household" status="disputed" />
            <StatusChip kind="meterType" status="grid" />
            <StatusChip kind="meterType" status="consumption" />
            <StatusChip kind="meterType" status="production" />
            <StatusChip kind="meterType" status="unknown" />
            {/* Uppercase variants (from openems types.ts) */}
            <StatusChip kind="meterType" status="GRID" />
            <StatusChip kind="meterType" status="CONSUMPTION" />
            <StatusChip kind="meterType" status="PRODUCTION" />
            <StatusChip kind="meterType" status="UNKNOWN" />
          </div>
        </Section>

        {/* ── CopyTable ── */}
        <Section title="CopyTable — 5 rows × 4 columns">
          <CopyTable
            rows={COPY_TABLE_ROWS}
            columns={COPY_TABLE_COLS}
            caption="April 2026 billing summary, 5 households"
            ariaLabel="Billing summary table"
          />
          <p className="mt-2 text-[12px] text-muted-foreground">
            Tab/Shift+Tab navigates column-major. C or Enter copies. Esc exits grid.
          </p>
        </Section>

        {/* ── ClosePeriodDialog ── */}
        <Section title="ClosePeriodDialog">
          <button
            onClick={() => setClosePeriodOpen(true)}
            className="inline-flex h-8 items-center rounded-md border border-primary bg-card px-3.5 text-[13px] font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open Close Period Dialog
          </button>
          <ClosePeriodDialog
            open={closePeriodOpen}
            onOpenChange={setClosePeriodOpen}
            periodLabel="April 2026"
            summaryRows={[
              { label: "Households", value: "12" },
              { label: "Total kWh", value: "487.3" },
              { label: "Tier 1 kWh", value: "392.1" },
              { label: "Tier 2 kWh", value: "95.2" },
            ]}
            grandTotal={4216800}
            onConfirm={() => new Promise((res) => setTimeout(res, 1500))}
          />
        </Section>

        {/* ── ConfirmDialog (destructive) ── */}
        <Section title="ConfirmDialog — destructive tone">
          <button
            onClick={() => setConfirmOpen(true)}
            className="inline-flex h-8 items-center rounded-md border border-destructive bg-card px-3.5 text-[13px] font-medium text-destructive hover:bg-destructive-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Delete Period (opens dialog)
          </button>
          <ConfirmDialog
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            title="Delete billing period?"
            description="This will permanently remove the draft period and all generated data. This cannot be undone."
            confirmLabel="Delete"
            tone="destructive"
            onConfirm={() => new Promise((res) => setTimeout(res, 1000))}
          />
        </Section>

        {/* ── ConfirmDialog (destructive + type-to-confirm + body) ── */}
        <Section title="ConfirmDialog — destructive with type-to-confirm + blast-radius body">
          <button
            onClick={() => setConfirmTypedOpen(true)}
            className="inline-flex h-8 items-center rounded-md border border-destructive bg-destructive-muted px-3.5 text-[13px] font-medium text-destructive-fg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Delete Microgrid (opens dialog)
          </button>
          <ConfirmDialog
            open={confirmTypedOpen}
            onOpenChange={setConfirmTypedOpen}
            title="Delete microgrid “Kisakye Main”?"
            description={`This cannot be undone. Type “Kisakye Main” to confirm.`}
            body={
              <ul className="my-2 list-disc space-y-0.5 pl-5">
                <li>1 edge</li>
                <li>10 devices</li>
                <li>10 households</li>
                <li>1 draft billing period (in progress — unfinalized readings will be lost)</li>
                <li>2 closed billing periods</li>
                <li>47 billing line items</li>
              </ul>
            }
            confirmLabel="Delete microgrid"
            tone="destructive"
            requireTypedConfirmation={{
              label: "Type microgrid name to confirm",
              expected: "Kisakye Main",
            }}
            onConfirm={() => new Promise((res) => setTimeout(res, 800))}
          />
        </Section>

        {/* ── ConfirmDialog (neutral) ── */}
        <Section title="ConfirmDialog — neutral tone">
          <button
            onClick={() => setConfirmNeutralOpen(true)}
            className="inline-flex h-8 items-center rounded-md border border-border bg-card px-3.5 text-[13px] font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Confirm action (opens dialog)
          </button>
          <ConfirmDialog
            open={confirmNeutralOpen}
            onOpenChange={setConfirmNeutralOpen}
            title="Apply rate schedule?"
            description="This will apply the new rate schedule starting next billing period."
            confirmLabel="Apply"
            tone="neutral"
            onConfirm={() => new Promise((res) => setTimeout(res, 800))}
          />
        </Section>

        {/* ── PeriodPicker ── */}
        <Section title="PeriodPicker — 6 sample periods">
          <PeriodPicker
            periods={SAMPLE_PERIODS}
            currentId={currentPeriodId}
            onSelect={(p) => setCurrentPeriodId(p.id)}
            onNewPeriod={() => alert("New period clicked")}
          />
          <p className="mt-2 text-[12px] text-muted-foreground">
            Selected: {SAMPLE_PERIODS.find((p) => p.id === currentPeriodId)?.startDate}
          </p>
        </Section>

        {/* ── HierarchyNav — single org ── */}
        <Section title="HierarchyNav — single org">
          <HierarchyNav
            levels={[
              { kind: "Organization", label: "Kisakye Energy", count: 1, href: "/orgs/kisakye" },
              { kind: "Community",    label: "Kisakye Village", count: 1, href: "/orgs/kisakye/communities/kisakye-village" },
              { kind: "Microgrid",    label: "Grid Alpha", count: 1, href: "/orgs/kisakye/microgrids/grid-alpha", active: true },
            ]}
          />
        </Section>

        {/* ── HierarchyNav — multi-org ── */}
        <Section title="HierarchyNav — multi-org with switcher">
          <HierarchyNav
            levels={[
              {
                kind: "Organization",
                label: "Kisakye Energy",
                count: 3,
                href: "/orgs/kisakye",
                active: false,
                siblings: [
                  { label: "Kisakye Energy", href: "/orgs/kisakye" },
                  { label: "Luwero Solar",   href: "/orgs/luwero" },
                  { label: "Masaka Grid",    href: "/orgs/masaka" },
                ],
              },
              {
                kind: "Community",
                label: "Kisakye Village",
                count: 2,
                href: "/orgs/kisakye/communities/kisakye-village",
                active: false,
                siblings: [
                  { label: "Kisakye Village", href: "/orgs/kisakye/communities/kisakye-village" },
                  { label: "Kasana Town",     href: "/orgs/kisakye/communities/kasana-town" },
                ],
              },
              {
                kind: "Microgrid",
                label: "Grid Alpha",
                count: 1,
                href: "/orgs/kisakye/microgrids/grid-alpha",
                active: true,
              },
            ]}
          />
        </Section>

        {/* ── ConsumptionCell ── */}
        <Section title="ConsumptionCell — states">
          <div className="flex flex-wrap gap-2">
            <ConsumptionCell day={1}  pct={0.4}  kwh={1.9} />
            <ConsumptionCell day={5}  pct={0.82} kwh={3.9} />
            <ConsumptionCell day={10} pct={1.1}  kwh={5.3} />
            <ConsumptionCell day={17} pct={1.4}  kwh={6.7} />
            <ConsumptionCell day={22} pct={null} kwh={null} status="future" />
            <ConsumptionCell day={8}  pct={null} kwh={null} status="missing" />
            <ConsumptionCell day={3}  pct={0.6}  kwh={2.9} small />
            <ConsumptionCell day={14} pct={1.38} kwh={6.6} />
          </div>
        </Section>

        {/* ── ConsumptionCalendar ── */}
        <Section title="ConsumptionCalendar — April 2026 (21 days data + future)">
          <ConsumptionCalendar
            days={CALENDAR_DAYS}
            onDaySelect={(day) => alert(`Day ${day} selected`)}
          />
        </Section>
      </div>
    </LocaleProvider>
  );
}
