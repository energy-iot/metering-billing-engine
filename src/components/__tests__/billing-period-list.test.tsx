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
