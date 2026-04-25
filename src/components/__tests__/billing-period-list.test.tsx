// BillingPeriodList unit tests
//
// Strategy:
//   - Mount BillingPeriodList with fixture periods wrapped in
//     <LocaleProvider locale="en-UG" currency="UGX">.
//   - Assert:
//     (a) PeriodPicker trigger button is rendered (aria-haspopup="listbox").
//     (b) Selecting an option calls router.push with the correct URL.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LocaleProvider } from "../format/locale-context";
import type { BillingPeriod } from "@/lib/types/domain";

// Mock next/navigation BEFORE any component imports that use it
const pushSpy = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushSpy, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/microgrids/mg-1/billing",
}));

// Mock Supabase client (BillingPeriodList calls createClient() on render)
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
      insert: () => ({
        select: () => ({
          single: () => Promise.resolve({ data: { id: "new-period" }, error: null }),
        }),
      }),
    }),
  }),
}));

// Import after mocks are set up
import { BillingPeriodList } from "../BillingPeriodList";

// ─── Fixture data ────────────────────────────────────────────────────────────

const MICROGRID_ID = "mg-fixture-1";

const PERIOD_1: BillingPeriod = {
  id: "period-a",
  microgrid_id: MICROGRID_ID,
  start_date: "2026-02-01",
  end_date: "2026-02-28",
  status: "closed",
  created_at: "2026-02-01T00:00:00Z",
  closed_at: "2026-03-01T00:00:00Z",
};

const PERIOD_2: BillingPeriod = {
  id: "period-b",
  microgrid_id: MICROGRID_ID,
  start_date: "2026-03-01",
  end_date: "2026-03-31",
  status: "draft",
  created_at: "2026-03-01T00:00:00Z",
  closed_at: null,
};

const SUMMARIES = {
  "period-a": { totalKwh: 120, totalAmount: 60000 },
  "period-b": { totalKwh: 45, totalAmount: 22500 },
};

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <LocaleProvider locale="en-UG" currency="UGX">
      {children}
    </LocaleProvider>
  );
}

describe("BillingPeriodList", () => {
  beforeEach(() => {
    pushSpy.mockClear();
  });

  it("(a) renders the PeriodPicker trigger button with aria-haspopup='listbox'", () => {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[PERIOD_1, PERIOD_2]}
          summaries={SUMMARIES}
          currency="UGX"
        />
      </Wrapper>
    );

    const trigger = document.querySelector("button[aria-haspopup='listbox']");
    expect(trigger).not.toBeNull();
  });

  it("(b) selecting the second option calls router.push with the correct URL", () => {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[PERIOD_1, PERIOD_2]}
          summaries={SUMMARIES}
          currency="UGX"
        />
      </Wrapper>
    );

    // Open the picker by clicking the trigger
    const trigger = document.querySelector(
      "button[aria-haspopup='listbox']",
    ) as HTMLButtonElement;
    fireEvent.click(trigger);

    // All period options are role="option" buttons inside the panel
    const options = screen.getAllByRole("option");
    // The picker renders periods in the same order as passed (server returns DESC by start_date)
    // PERIOD_1 is index 0, PERIOD_2 is index 1
    expect(options.length).toBeGreaterThanOrEqual(2);

    // Click the second option (PERIOD_2)
    fireEvent.click(options[1]);

    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).toHaveBeenCalledWith(
      `/microgrids/${MICROGRID_ID}/billing/${PERIOD_2.id}`,
    );
  });
});

// ─── EmptyState (#139 P9) ─────────────────────────────────────────────────────

describe("BillingPeriodList — EmptyState (#139)", () => {
  it("shows EmptyState title and body when periods is empty", () => {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[]}
          summaries={{}}
          currency="UGX"
        />
      </Wrapper>
    );
    expect(screen.getByText("Create the first billing period")).toBeTruthy();
    expect(screen.getByText(/A billing period defines the start and end dates/)).toBeTruthy();
  });

  it("shows '+ Create period' CTA when canManage=true and periods empty", () => {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[]}
          summaries={{}}
          currency="UGX"
          canManage={true}
        />
      </Wrapper>
    );
    expect(screen.getByRole("button", { name: /Create period/i })).toBeTruthy();
  });

  it("hides CTA and shows role-locked footnote when canManage=false", () => {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[]}
          summaries={{}}
          currency="UGX"
          canManage={false}
        />
      </Wrapper>
    );
    expect(screen.queryByRole("button", { name: /Create period/i })).toBeNull();
    expect(
      screen.getByText(/Ask a super admin to create the first billing period/)
    ).toBeTruthy();
  });

  it("shows canManage=true footnote about editing date range", () => {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[]}
          summaries={{}}
          currency="UGX"
          canManage={true}
        />
      </Wrapper>
    );
    expect(
      screen.getByText(/You'll be able to edit the date range/)
    ).toBeTruthy();
  });

  it("does NOT show EmptyState when periods are present", () => {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[PERIOD_1, PERIOD_2]}
          summaries={SUMMARIES}
          currency="UGX"
        />
      </Wrapper>
    );
    expect(screen.queryByText("Create the first billing period")).toBeNull();
  });
});

// ─── CTA collapse / picker invariant (#171) ──────────────────────────────────
//
// One CTA at zero, one CTA at >=1, no overlap. Mirrors AC-7 of the ticket.

describe("BillingPeriodList — CTA collapse (#171)", () => {
  beforeEach(() => {
    pushSpy.mockClear();
  });

  it("at zero periods + form closed: PeriodPicker NOT rendered, EmptyState rendered with one CTA, form NOT rendered", () => {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[]}
          summaries={{}}
          currency="UGX"
          canManage={true}
        />
      </Wrapper>
    );

    // Picker hidden — its trigger has aria-haspopup="listbox"
    expect(document.querySelector("button[aria-haspopup='listbox']")).toBeNull();

    // EmptyState rendered with the canonical first-run title
    expect(screen.getByText("Create the first billing period")).toBeTruthy();

    // Exactly one CTA: the EmptyState's "+ Create period" button
    const createButtons = screen.getAllByRole("button", { name: /Create period/i });
    expect(createButtons).toHaveLength(1);

    // Form not rendered — there's no Cancel button visible
    expect(screen.queryByRole("button", { name: /^Cancel$/i })).toBeNull();
  });

  it("at zero periods + clicking EmptyState CTA: form rendered, EmptyState NOT rendered, PeriodPicker still NOT rendered", () => {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[]}
          summaries={{}}
          currency="UGX"
          canManage={true}
        />
      </Wrapper>
    );

    // Click the EmptyState CTA to open the form
    fireEvent.click(screen.getByRole("button", { name: /\+ Create period/i }));

    // Form is rendered — Cancel + Create Period buttons visible
    expect(screen.getByRole("button", { name: /^Cancel$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create Period/i })).toBeTruthy();

    // EmptyState gone — its title no longer in the document
    expect(screen.queryByText("Create the first billing period")).toBeNull();

    // Picker still hidden — periods.length is still 0
    expect(document.querySelector("button[aria-haspopup='listbox']")).toBeNull();
  });

  it("at zero periods + form open + clicking Cancel: form NOT rendered, EmptyState rendered with CTA", () => {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[]}
          summaries={{}}
          currency="UGX"
          canManage={true}
        />
      </Wrapper>
    );

    // Open the form
    fireEvent.click(screen.getByRole("button", { name: /\+ Create period/i }));
    expect(screen.getByRole("button", { name: /^Cancel$/i })).toBeTruthy();

    // Click Cancel
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    // Form gone — Cancel button no longer visible
    expect(screen.queryByRole("button", { name: /^Cancel$/i })).toBeNull();

    // EmptyState back with its "+ Create period" CTA
    expect(screen.getByText("Create the first billing period")).toBeTruthy();
    expect(screen.getByRole("button", { name: /\+ Create period/i })).toBeTruthy();
  });

  it("at >=1 period + form closed: PeriodPicker rendered, EmptyState NOT rendered, list rendered", () => {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[PERIOD_1, PERIOD_2]}
          summaries={SUMMARIES}
          currency="UGX"
          canManage={true}
        />
      </Wrapper>
    );

    // Picker rendered
    expect(document.querySelector("button[aria-haspopup='listbox']")).not.toBeNull();

    // EmptyState absent
    expect(screen.queryByText("Create the first billing period")).toBeNull();

    // List rendered — column headers present
    expect(screen.getByText(/Date Range/i)).toBeTruthy();
  });

  it("at >=1 period + clicking picker '+ New period': form rendered, picker still rendered, list still rendered", () => {
    render(
      <Wrapper>
        <BillingPeriodList
          microgridId={MICROGRID_ID}
          periods={[PERIOD_1, PERIOD_2]}
          summaries={SUMMARIES}
          currency="UGX"
          canManage={true}
        />
      </Wrapper>
    );

    // Open the picker
    const trigger = document.querySelector(
      "button[aria-haspopup='listbox']",
    ) as HTMLButtonElement;
    fireEvent.click(trigger);

    // Click the picker's "+ New period" header CTA
    fireEvent.click(screen.getByRole("button", { name: /\+ New period/i }));

    // Form is rendered — Cancel + Create Period buttons visible
    expect(screen.getByRole("button", { name: /^Cancel$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create Period/i })).toBeTruthy();

    // Picker still rendered
    expect(document.querySelector("button[aria-haspopup='listbox']")).not.toBeNull();

    // List still rendered — column header still in DOM
    expect(screen.getByText(/Date Range/i)).toBeTruthy();
  });
});
