// RegenerateRowDialog — component tests (jsdom environment) — BC3 #175 AC2
//
// Covers:
//   - Edge unpaid path: immediate POST /api/billing/generate, no preview
//   - Edge paid path: POST /api/billing/regenerate-preview first, dialog
//     renders the diff, /api/billing/generate fires only on confirm
//   - Edge paid + closed period: warn-banner renders inside dialog body
//   - Manual entry path: form validation + POST body matches expected shape
//   - currently_manual / unknown_household error display

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { LocaleProvider } from "@/components/format/locale-context";
import { RegenerateRowDialog } from "../regenerate-row-dialog";
import type { RowBannerEntry } from "../row-banner-stack";

// Mock next/navigation — useRouter is consumed inside the dialog.
const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: refreshMock }),
}));

// Radix Dialog uses ResizeObserver / PointerEvent in jsdom — stub them.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof globalThis.PointerEvent === "undefined") {
  globalThis.PointerEvent = class PointerEvent extends MouseEvent {
    constructor(type: string, init?: PointerEventInit) {
      super(type, init);
    }
  } as typeof PointerEvent;
}

function makeProps(overrides?: Partial<Parameters<typeof RegenerateRowDialog>[0]>) {
  const onOpenChange = vi.fn();
  const pushBanner = vi.fn() as (entry: RowBannerEntry) => void;
  const dismissBanner = vi.fn();
  const onSuccess = vi.fn();
  return {
    open: true,
    onOpenChange,
    mode: "edge" as const,
    household: { id: "h-1", display_name: "Alice" },
    period: {
      id: "p-1",
      status: "draft" as const,
      start_date: "2026-04-01",
      end_date: "2026-04-30",
    },
    lineItem: {
      id: "li-1",
      payment_status: "unpaid" as const,
    },
    pushBanner,
    dismissBanner,
    onSuccess,
    ...overrides,
  };
}

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <LocaleProvider locale="en-UG" currency="UGX">
      {children}
    </LocaleProvider>
  );
}

describe("RegenerateRowDialog — edge unpaid path (2a)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshMock.mockClear();
  });

  it("fires POST /api/billing/generate immediately, no preview call", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ lineItems: 1, errors: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const props = makeProps();
    render(
      <Wrap>
        <RegenerateRowDialog {...props} />
      </Wrap>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const calls = fetchMock.mock.calls;
    expect(calls.some((c) => c[0] === "/api/billing/regenerate-preview")).toBe(false);
    const generateCall = calls.find((c) => c[0] === "/api/billing/generate");
    expect(generateCall).toBeDefined();
    const body = JSON.parse(generateCall![1].body as string);
    expect(body).toEqual({
      billingPeriodId: "p-1",
      householdIds: ["h-1"],
    });

    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(props.onSuccess).toHaveBeenCalledWith("li-1");

    vi.unstubAllGlobals();
  });

  it("pushes destructive banner with Retry on errors[]", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          lineItems: 0,
          errors: [
            {
              householdId: "h-1",
              householdName: "Alice",
              error: "No meter reading data available",
              code: "no_meter_reading",
            },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const props = makeProps();
    render(
      <Wrap>
        <RegenerateRowDialog {...props} />
      </Wrap>,
    );
    await waitFor(() => expect(props.pushBanner).toHaveBeenCalled());
    const entry = (props.pushBanner as unknown as { mock: { calls: RowBannerEntry[][] } }).mock
      .calls[0][0];
    expect(entry.tone).toBe("destructive");
    expect(entry.message).toContain("No meter reading data");
    expect(entry.action?.label).toBe("Retry");

    vi.unstubAllGlobals();
  });
});

describe("RegenerateRowDialog — edge paid path (2b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshMock.mockClear();
  });

  it("calls preview first; renders diff body; /generate not called until confirm", async () => {
    const previewResponse = {
      preview: [
        {
          householdId: "h-1",
          householdName: "Alice",
          startKwh: 100,
          endKwh: 145,
          usageKwh: 45,
          tierBreakdown: [],
          totalAmount: 22000,
          previousTotalAmount: 20000,
          previousPaymentStatus: "paid",
        },
      ],
      errors: [],
    };
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/billing/regenerate-preview") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(previewResponse),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ lineItems: 1, errors: [] }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const props = makeProps({
      lineItem: { id: "li-1", payment_status: "paid" },
    });
    render(
      <Wrap>
        <RegenerateRowDialog {...props} />
      </Wrap>,
    );

    // Loading state shows first.
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="regenerate-preview-loading"]'),
      ).not.toBeNull(),
    );

    // After preview returns, the diff is rendered.
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="regenerate-preview-diff"]'),
      ).not.toBeNull(),
    );

    // The diff cell should reference both totals.
    const diff = document.querySelector('[data-testid="regenerate-preview-diff"]');
    expect(diff?.textContent).toMatch(/\+/); // 22000 - 20000 = +2000

    // #183 — paid-edge dialog passes eyebrow={null}; the neutral-tone
    // default "Confirm" eyebrow should NOT appear in the dialog header.
    // ("Regenerate" is the confirm-button label, which still renders.)
    expect(screen.queryByText("Confirm")).toBeNull();

    // /api/billing/generate should NOT have been called yet.
    const generateCalls = fetchMock.mock.calls.filter(
      (c) => c[0] === "/api/billing/generate",
    );
    expect(generateCalls.length).toBe(0);

    // Confirm button is the "Regenerate" label inside ConfirmDialog.
    const confirmBtn = screen
      .getAllByRole("button")
      .find((b) => b.textContent === "Regenerate");
    expect(confirmBtn).toBeDefined();
    await act(async () => {
      fireEvent.click(confirmBtn!);
    });

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(
        (c) => c[0] === "/api/billing/generate",
      );
      expect(calls.length).toBe(1);
    });
    expect(refreshMock).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("renders closed-period audit-revision warn banner inside the dialog body", async () => {
    const previewResponse = {
      preview: [
        {
          householdId: "h-1",
          householdName: "Alice",
          startKwh: 100,
          endKwh: 145,
          usageKwh: 45,
          tierBreakdown: [],
          totalAmount: 22000,
          previousTotalAmount: 20000,
          previousPaymentStatus: "paid",
        },
      ],
      errors: [],
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(previewResponse),
    });
    vi.stubGlobal("fetch", fetchMock);

    const props = makeProps({
      lineItem: { id: "li-1", payment_status: "paid" },
      period: {
        id: "p-1",
        status: "closed",
        start_date: "2026-04-01",
        end_date: "2026-04-30",
      },
    });
    render(
      <Wrap>
        <RegenerateRowDialog {...props} />
      </Wrap>,
    );

    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="regenerate-preview-diff"]'),
      ).not.toBeNull(),
    );

    expect(
      Array.from(document.querySelectorAll("h3")).some((h) =>
        h.textContent?.includes("Period is closed"),
      ),
    ).toBe(true);

    vi.unstubAllGlobals();
  });
});

describe("RegenerateRowDialog — manual entry path (2c)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshMock.mockClear();
  });

  it("submits POST with manualReadings array containing the entered values + reason", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ lineItems: 1, errors: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const props = makeProps({ mode: "manual" });
    render(
      <Wrap>
        <RegenerateRowDialog {...props} />
      </Wrap>,
    );

    // Fill the form via labels.
    const startInput = screen.getByLabelText(/Start \(kWh\)/) as HTMLInputElement;
    const endInput = screen.getByLabelText(/End \(kWh\)/) as HTMLInputElement;
    const reasonInput = screen.getByLabelText(
      /Manual entry reason/,
    ) as HTMLTextAreaElement;
    fireEvent.change(startInput, { target: { value: "100" } });
    fireEvent.change(endInput, { target: { value: "145.5" } });
    fireEvent.change(reasonInput, { target: { value: "URA reading override" } });

    const submitBtn = screen.getByRole("button", { name: /Save manual reading/i }) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe("/api/billing/generate");
    const body = JSON.parse(call[1].body as string);
    expect(body.billingPeriodId).toBe("p-1");
    expect(body.householdIds).toEqual(["h-1"]);
    expect(body.manualReadings).toEqual([
      {
        householdId: "h-1",
        startKwh: 100,
        endKwh: 145.5,
        reason: "URA reading override",
      },
    ]);

    vi.unstubAllGlobals();
  });

  it("disables submit when endKwh < startKwh", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const props = makeProps({ mode: "manual" });
    render(
      <Wrap>
        <RegenerateRowDialog {...props} />
      </Wrap>,
    );

    const startInput = screen.getByLabelText(/Start \(kWh\)/) as HTMLInputElement;
    const endInput = screen.getByLabelText(/End \(kWh\)/) as HTMLInputElement;
    fireEvent.change(startInput, { target: { value: "200" } });
    fireEvent.change(endInput, { target: { value: "100" } });

    const submitBtn = screen.getByRole("button", { name: /Save manual reading/i }) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    // Inline error visible.
    expect(document.body.textContent).toContain("End must be ≥ Start");

    vi.unstubAllGlobals();
  });
});
