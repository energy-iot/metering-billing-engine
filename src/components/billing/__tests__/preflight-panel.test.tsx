// PreflightPanel — component tests (jsdom environment) — BC3 #175 AC5

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { LocaleProvider } from "@/components/format/locale-context";
import { PreflightPanel } from "../preflight-panel";
import type { Household } from "@/lib/types/domain";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: refreshMock }),
}));

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

function makeHousehold(id: string, name: string): Household {
  return {
    id,
    microgrid_id: "mg-1",
    display_name: name,
    primary_phone: null,
    primary_email: null,
    address_line1: null,
    address_line2: null,
    unit_label: null,
    address_city: null,
    address_region: null,
    address_country: null,
    address_postal_code: null,
    geography_notes: null,
    created_at: "2026-01-01T00:00:00Z",
  } as unknown as Household;
}

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <LocaleProvider locale="en-UG" currency="UGX">
      {children}
    </LocaleProvider>
  );
}

describe("PreflightPanel — block-until-filled (Q1=A)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshMock.mockClear();
  });

  it("Generate button disabled when needs-manual rows are empty; enables when filled", async () => {
    const households = [makeHousehold("h-1", "Alice")];
    const edgeMap = { "h-1": false }; // needs manual

    render(
      <Wrap>
        <PreflightPanel
          open
          onClose={vi.fn()}
          billingPeriodId="p-1"
          households={households}
          edgeAvailableByHouseholdId={edgeMap}
        />
      </Wrap>,
    );

    const btn = document.querySelector(
      '[data-testid="preflight-generate-button"]',
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    const startInput = screen.getByLabelText(/Start kWh for Alice/i) as HTMLInputElement;
    const endInput = screen.getByLabelText(/End kWh for Alice/i) as HTMLInputElement;
    fireEvent.change(startInput, { target: { value: "100" } });
    fireEvent.change(endInput, { target: { value: "150" } });
    expect(btn.disabled).toBe(false);

    // Now flip end < start — button should disable again.
    fireEvent.change(endInput, { target: { value: "50" } });
    expect(btn.disabled).toBe(true);
  });
});

describe("PreflightPanel — submit body shape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshMock.mockClear();
  });

  it("POSTs manualReadings (needs-manual + override-toggled), no householdIds", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ lineItems: 2, errors: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const households = [
      makeHousehold("h-1", "Alice"), // needs manual
      makeHousehold("h-2", "Bob"), // edge, will be override-toggled
    ];
    const edgeMap = { "h-1": false, "h-2": true };

    const onClose = vi.fn();
    render(
      <Wrap>
        <PreflightPanel
          open
          onClose={onClose}
          billingPeriodId="p-1"
          households={households}
          edgeAvailableByHouseholdId={edgeMap}
        />
      </Wrap>,
    );

    // Fill Alice's manual fields.
    fireEvent.change(screen.getByLabelText(/Start kWh for Alice/i), {
      target: { value: "100" },
    });
    fireEvent.change(screen.getByLabelText(/End kWh for Alice/i), {
      target: { value: "150" },
    });

    // Expand the override section.
    const overrideToggle = document.querySelector(
      '[data-testid="preflight-override-section"] button',
    ) as HTMLButtonElement;
    fireEvent.click(overrideToggle);

    // Toggle Bob's override checkbox.
    const overrideCheckbox = screen.getByLabelText(
      /Use manual entry instead for Bob/i,
    );
    fireEvent.click(overrideCheckbox);

    // Now Bob's start/end inputs become required. There are now two End-kWh
    // inputs visible (Alice + Bob); pick by aria-label.
    fireEvent.change(screen.getByLabelText(/Start kWh for Bob/i), {
      target: { value: "200" },
    });
    fireEvent.change(screen.getByLabelText(/End kWh for Bob/i), {
      target: { value: "275" },
    });

    const submitBtn = document.querySelector(
      '[data-testid="preflight-generate-button"]',
    ) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe("/api/billing/generate");
    const body = JSON.parse(call[1].body as string);
    expect(body.billingPeriodId).toBe("p-1");
    expect(body.householdIds).toBeUndefined();
    expect(body.manualReadings).toEqual([
      { householdId: "h-1", startKwh: 100, endKwh: 150 },
      { householdId: "h-2", startKwh: 200, endKwh: 275 },
    ]);

    // Panel closes + refresh fires on 200.
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(refreshMock).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

describe("PreflightPanel — partial-failure result view (BC3 polish #182)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshMock.mockClear();
  });

  async function fillAndSubmit(onClose: () => void) {
    const households = [
      makeHousehold("h-1", "Alice"),
      makeHousehold("h-2", "Bob"),
      makeHousehold("h-3", "Carol"),
    ];
    const edgeMap = { "h-1": false, "h-2": false, "h-3": false };
    render(
      <Wrap>
        <PreflightPanel
          open
          onClose={onClose}
          billingPeriodId="p-1"
          households={households}
          edgeAvailableByHouseholdId={edgeMap}
        />
      </Wrap>,
    );
    fireEvent.change(screen.getByLabelText(/Start kWh for Alice/i), {
      target: { value: "100" },
    });
    fireEvent.change(screen.getByLabelText(/End kWh for Alice/i), {
      target: { value: "150" },
    });
    fireEvent.change(screen.getByLabelText(/Start kWh for Bob/i), {
      target: { value: "200" },
    });
    fireEvent.change(screen.getByLabelText(/End kWh for Bob/i), {
      target: { value: "250" },
    });
    fireEvent.change(screen.getByLabelText(/Start kWh for Carol/i), {
      target: { value: "300" },
    });
    fireEvent.change(screen.getByLabelText(/End kWh for Carol/i), {
      target: { value: "350" },
    });
    const submitBtn = document.querySelector(
      '[data-testid="preflight-generate-button"]',
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(submitBtn);
    });
  }

  it("all-success: panel calls onClose() (existing behavior preserved)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ lineItems: 3, errors: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    await fillAndSubmit(onClose);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(
      document.querySelector('[data-testid="preflight-panel-result"]'),
    ).toBeNull();
    expect(refreshMock).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("partial failure: panel stays open, switches to result view with warn banner + per-code copy", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          lineItems: 2,
          errors: [
            {
              householdId: "h-3",
              householdName: "Carol",
              error: "raw",
              code: "invalid_manual_reading",
            },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    await fillAndSubmit(onClose);

    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="preflight-panel-result"]'),
      ).not.toBeNull(),
    );
    // onClose was NOT called.
    expect(onClose).not.toHaveBeenCalled();
    // Heading shows partial-success summary.
    expect(document.body.textContent).toContain("Generated 2 of 3 households");
    // Per-code copy renders.
    const list = document.querySelector(
      '[data-testid="preflight-result-failure-list"]',
    );
    expect(list!.textContent).toContain(
      "Carol has an invalid manual reading.",
    );
    // router.refresh fires regardless of partial.
    expect(refreshMock).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("full failure: panel stays open with destructive banner; heading reads 'Could not generate'", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          lineItems: 0,
          errors: [
            {
              householdId: "h-1",
              householdName: "Alice",
              error: "raw1",
              code: "no_meter_reading",
            },
            {
              householdId: "h-2",
              householdName: "Bob",
              error: "raw2",
              code: "missing_openems_config",
            },
            {
              householdId: "h-3",
              householdName: "Carol",
              error: "raw3",
              code: "unmetered_no_manual",
            },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    await fillAndSubmit(onClose);

    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="preflight-panel-result"]'),
      ).not.toBeNull(),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Could not generate 3 households",
    );
    const items = document.querySelectorAll(
      '[data-testid="preflight-result-failure-list"] > li',
    );
    expect(items.length).toBe(3);
    // Order preserved (AC7).
    expect(items[0].textContent).toContain("Alice");
    expect(items[1].textContent).toContain("Bob");
    expect(items[2].textContent).toContain("Carol");
    vi.unstubAllGlobals();
  });

  it("per-error-code copy smoke: maps unmetered_no_manual, invalid_manual_reading, currently_manual", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          lineItems: 0,
          errors: [
            {
              householdId: "h-1",
              householdName: "Alice",
              error: "x",
              code: "unmetered_no_manual",
            },
            {
              householdId: "h-2",
              householdName: "Bob",
              error: "y",
              code: "invalid_manual_reading",
            },
            {
              householdId: "h-3",
              householdName: "Carol",
              error: "z",
              code: "currently_manual",
            },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await fillAndSubmit(vi.fn());

    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="preflight-panel-result"]'),
      ).not.toBeNull(),
    );
    const text = document.querySelector(
      '[data-testid="preflight-result-failure-list"]',
    )!.textContent ?? "";
    expect(text).toContain(
      "Alice has no meter and no manual reading provided.",
    );
    expect(text).toContain("Bob has an invalid manual reading.");
    expect(text).toContain(
      "Carol is set to manual entry — use per-row regenerate.",
    );
    vi.unstubAllGlobals();
  });

  it("default fallback: unknown code renders '${name}: ${error}'", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          lineItems: 0,
          errors: [
            {
              householdId: "h-1",
              householdName: "Alice",
              error: "Quoted server message",
              code: "future_code",
            },
            {
              householdId: "h-2",
              householdName: "Bob",
              error: "another verbatim",
              // no code at all
            },
            {
              householdId: "h-3",
              householdName: "Carol",
              error: "third",
              code: "no_meter_reading",
            },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await fillAndSubmit(vi.fn());

    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="preflight-panel-result"]'),
      ).not.toBeNull(),
    );
    const text = document.querySelector(
      '[data-testid="preflight-result-failure-list"]',
    )!.textContent ?? "";
    expect(text).toContain("Alice: Quoted server message");
    expect(text).toContain("Bob: another verbatim");
    // Mapped code wins for Carol.
    expect(text).toContain("Carol has no current meter reading.");
    vi.unstubAllGlobals();
  });

  it("truncation: 6 failures → 5 + '+ 1 more'", async () => {
    const errs = Array.from({ length: 6 }, (_, i) => ({
      householdId: `h-${i + 1}`,
      householdName: `Person${i + 1}`,
      error: "x",
      code: "no_meter_reading",
    }));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ lineItems: 0, errors: errs }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const households = errs.map((e) =>
      makeHousehold(e.householdId, e.householdName),
    );
    const edgeMap: Record<string, boolean> = {};
    households.forEach((h) => {
      edgeMap[h.id] = false;
    });
    render(
      <Wrap>
        <PreflightPanel
          open
          onClose={vi.fn()}
          billingPeriodId="p-1"
          households={households}
          edgeAvailableByHouseholdId={edgeMap}
        />
      </Wrap>,
    );
    households.forEach((h, i) => {
      fireEvent.change(
        screen.getByLabelText(new RegExp(`Start kWh for ${h.display_name}`, "i")),
        { target: { value: String(i * 10) } },
      );
      fireEvent.change(
        screen.getByLabelText(new RegExp(`End kWh for ${h.display_name}`, "i")),
        { target: { value: String(i * 10 + 5) } },
      );
    });
    const submitBtn = document.querySelector(
      '[data-testid="preflight-generate-button"]',
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="preflight-panel-result"]'),
      ).not.toBeNull(),
    );
    const items = document.querySelectorAll(
      '[data-testid="preflight-result-failure-list"] > li',
    );
    // 5 displayed + 1 overflow li.
    expect(items.length).toBe(6);
    const overflow = document.querySelector(
      '[data-testid="preflight-result-failure-overflow"]',
    );
    expect(overflow!.textContent).toContain("+ 1 more");
    vi.unstubAllGlobals();
  });

  it("Close button in result view calls onClose()", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          lineItems: 2,
          errors: [
            {
              householdId: "h-3",
              householdName: "Carol",
              error: "x",
              code: "no_meter_reading",
            },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    await fillAndSubmit(onClose);
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="preflight-panel-result"]'),
      ).not.toBeNull(),
    );
    expect(onClose).not.toHaveBeenCalled();
    const closeBtn = document.querySelector(
      '[data-testid="preflight-result-close"]',
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(closeBtn);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe("PreflightPanel — Generate button label", () => {
  it("reads 'Generate (N households)' regardless of trigger source", () => {
    const households = [makeHousehold("h-1", "Alice"), makeHousehold("h-2", "Bob")];
    const edgeMap = { "h-1": true, "h-2": true };
    render(
      <Wrap>
        <PreflightPanel
          open
          onClose={vi.fn()}
          billingPeriodId="p-1"
          households={households}
          edgeAvailableByHouseholdId={edgeMap}
        />
      </Wrap>,
    );
    const btn = document.querySelector(
      '[data-testid="preflight-generate-button"]',
    );
    expect(btn?.textContent).toContain("Generate (2 households)");
  });
});

// #339 — the seed section. Shipped without tests in the first pass; these pin
// the three things that decide whether real readings get collected or zeroes
// get typed to clear a form.
describe("PreflightPanel — seed readings (#339)", () => {
  const DEVICE = "d-1";

  function renderWithSeed(opts: {
    seedNeeded?: boolean;
    priorHint?: number | null;
    periodTimezone?: string;
  } = {}) {
    const households = [makeHousehold("h-1", "Nakato")];
    return render(
      <Wrap>
        <PreflightPanel
          open
          onClose={vi.fn()}
          billingPeriodId="p-1"
          households={households}
          edgeAvailableByHouseholdId={{ "h-1": true }}
          seedNeededByHouseholdId={{ "h-1": opts.seedNeeded ?? true }}
          priorHintByHouseholdId={{ "h-1": opts.priorHint ?? null }}
          deviceIdByHouseholdId={{ "h-1": DEVICE }}
          periodStartDate="2026-08-01"
          periodTimezone={opts.periodTimezone}
        />
      </Wrap>,
    );
  }

  function energyResponse(totalKwh: number) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: [{ deviceId: DEVICE, totalKwh }] }),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The section must be ABSENT when nothing needs a seed. An always-present
  // optional field is skipped, and a skipped seed is indistinguishable from a
  // seeded zero — which is the defect being fixed.
  it("does not render the section when no household needs a seed", () => {
    renderWithSeed({ seedNeeded: false });
    expect(
      document.querySelector('[data-testid="preflight-needs-seed-section"]'),
    ).toBeNull();
  });

  it("renders the section and blocks Generate until the reading resolves", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(energyResponse(214)));
    renderWithSeed();

    expect(
      document.querySelector('[data-testid="preflight-needs-seed-section"]'),
    ).not.toBeNull();

    const btn = document.querySelector(
      '[data-testid="preflight-generate-button"]',
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    fireEvent.change(
      document.querySelector(
        '[data-testid="preflight-seed-dial-h-1"]',
      ) as HTMLInputElement,
      { target: { value: "4196" } },
    );

    await waitFor(() => expect(btn.disabled).toBe(false));
  });

  // #359 — the seed anchors to the period's start, so the elapsed-usage
  // query must run in the period's STAMPED zone: a non-UTC operator's
  // seed window must match the billing window, not a UTC one.
  it("sends the period's stamped timezone with the elapsed-usage query (#359)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(energyResponse(214));
    vi.stubGlobal("fetch", fetchMock);
    renderWithSeed({ periodTimezone: "Africa/Kampala" });

    fireEvent.change(
      document.querySelector(
        '[data-testid="preflight-seed-dial-h-1"]',
      ) as HTMLInputElement,
      { target: { value: "4196" } },
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/openems/energy");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.timezone).toBe("Africa/Kampala");
    expect(body.fromDate).toBe("2026-08-01");
  });

  it("omits timezone when no stamp is provided (route defaults to UTC)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(energyResponse(214));
    vi.stubGlobal("fetch", fetchMock);
    renderWithSeed();

    fireEvent.change(
      document.querySelector(
        '[data-testid="preflight-seed-dial-h-1"]',
      ) as HTMLInputElement,
      { target: { value: "4196" } },
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect("timezone" in body).toBe(false);
  });

  // The operator types one number and a different one is stored. If the
  // derived value is wrong they must be able to see WHICH input was wrong,
  // so the arithmetic is on screen rather than behind the field.
  it("shows the subtraction and the derived starting reading", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(energyResponse(214)));
    renderWithSeed();

    fireEvent.change(
      document.querySelector(
        '[data-testid="preflight-seed-dial-h-1"]',
      ) as HTMLInputElement,
      { target: { value: "4196" } },
    );

    await waitFor(() => {
      const math = document.querySelector(
        '[data-testid="preflight-seed-math-h-1"]',
      );
      expect(math?.textContent).toContain("214");
      // 4196 − 214
      expect(math?.textContent).toContain("3,982");
    });
  });

  // A derived value below zero means the dial reads under the usage already
  // recorded this period — a mistyped digit, not a meter running backwards.
  it("keeps Generate disabled when the derived reading is negative", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(energyResponse(5000)));
    renderWithSeed();

    fireEvent.change(
      document.querySelector(
        '[data-testid="preflight-seed-dial-h-1"]',
      ) as HTMLInputElement,
      { target: { value: "100" } },
    );

    const btn = document.querySelector(
      '[data-testid="preflight-generate-button"]',
    ) as HTMLButtonElement;
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="preflight-seed-math-h-1"]'),
      ).not.toBeNull(),
    );
    expect(btn.disabled).toBe(true);
  });

  // The hint is the number the operator would otherwise go looking for. It is
  // text, never a prefill: a plausible prefilled figure is confirmed by
  // inertia, and this one is a household's number rather than this meter's.
  it("shows the prior manual figure as a cause line without prefilling the input", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(energyResponse(0)));
    renderWithSeed({ priorHint: 4182 });

    const input = document.querySelector(
      '[data-testid="preflight-seed-dial-h-1"]',
    ) as HTMLInputElement;
    expect(input.value).toBe("");

    const cause = document.querySelector(
      '[data-testid="preflight-seed-cause-h-1"]',
    );
    expect(cause?.textContent).toContain("Billed manually until now");
    expect(cause?.textContent).toContain("4,182");
    // The other branch must NOT also appear.
    expect(cause?.textContent).not.toContain("No earlier reading on record");
  });

  it("says there is no earlier reading, and that zero is a real reading", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(energyResponse(0)));
    renderWithSeed({ priorHint: null });

    const cause = document.querySelector(
      '[data-testid="preflight-seed-cause-h-1"]',
    );
    expect(cause?.textContent).toContain("No earlier reading on record");
    // The permission to enter zero is what makes this a question rather than
    // a wall — without it the operator's only exit is to invent a number.
    expect(cause?.textContent).toContain("enter zero");
    expect(cause?.textContent).not.toContain("Billed manually until now");
  });

  // THE shape that two single-row renders cannot catch. A cause computed at
  // section level rather than per row still looks correct in any render
  // containing one state; only a render holding BOTH states at once
  // distinguishes them. This is the defect the copy change exists to fix.
  it("gives each row its own cause when two households differ", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(energyResponse(0)));
    render(
      <Wrap>
        <PreflightPanel
          open
          onClose={vi.fn()}
          billingPeriodId="p-1"
          households={[makeHousehold("h-1", "Nakato"), makeHousehold("h-2", "Okello")]}
          edgeAvailableByHouseholdId={{ "h-1": true, "h-2": true }}
          seedNeededByHouseholdId={{ "h-1": true, "h-2": true }}
          priorHintByHouseholdId={{ "h-1": 4182, "h-2": null }}
          deviceIdByHouseholdId={{ "h-1": "d-1", "h-2": "d-2" }}
          periodStartDate="2026-08-01"
        />
      </Wrap>,
    );

    const withHistory = document.querySelector(
      '[data-testid="preflight-seed-cause-h-1"]',
    );
    const withoutHistory = document.querySelector(
      '[data-testid="preflight-seed-cause-h-2"]',
    );

    expect(withHistory?.textContent).toContain("Billed manually until now");
    expect(withoutHistory?.textContent).toContain("No earlier reading on record");
    // And neither leaks the other's sentence — a section-level branch would
    // give both rows whichever one it computed.
    expect(withHistory?.textContent).not.toContain("No earlier reading on record");
    expect(withoutHistory?.textContent).not.toContain("Billed manually until now");
  });
});

// #343 — the read date.
//
// #339 shipped a `readAt` field that no control ever wrote, so the subtraction
// always ran to the entry date. Every test it shipped with entered the reading
// the same day, which is the one case where that is correct — so a full green
// suite sat on top of an over-billing defect.
//
// The mock below therefore answers by WINDOW: it returns a different usage
// figure for `toDate: 2026-08-04` than for `toDate: 2026-08-10`. A test that
// does not actually move the window gets the wrong number and fails, which is
// what stops this file from re-acquiring the hole it is being added to close.
describe("PreflightPanel — read date (#343)", () => {
  const DEVICE = "d-1";
  const TODAY = "2026-08-10";
  const READ_DAY = "2026-08-04";
  const USAGE_TO_READ_DAY = 214;
  const USAGE_TO_TODAY = 980;

  beforeEach(() => {
    vi.clearAllMocks();
    // shouldAdvanceTime keeps `waitFor` working — a frozen clock never
    // resolves its polling and the suite hangs rather than fails.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-10T09:00:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Usage keyed by the `toDate` the panel actually asked for.
   *
   * `fallbackKwh` is null by default so an unexpected window yields no figure
   * and the arithmetic tests cannot quietly pass on one.
   *
   * The date-validation tests MUST pass a number instead. With null, the row
   * has no elapsed figure, `derivedSeed` returns null, and Generate is
   * disabled for that reason — so an assertion on `btn.disabled` holds whether
   * or not the date guard exists. Checked by mutation: removing the guard from
   * `allSeedsValid` left all 22 tests green until this argument existed.
   */
  function windowedFetch(fallbackKwh: number | null = null) {
    return vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { toDate?: string };
      const totalKwh =
        body.toDate === READ_DAY
          ? USAGE_TO_READ_DAY
          : body.toDate === TODAY
            ? USAGE_TO_TODAY
            : fallbackKwh;
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [{ deviceId: DEVICE, totalKwh }] }),
      };
    });
  }

  function renderSeedRow() {
    return render(
      <Wrap>
        <PreflightPanel
          open
          onClose={vi.fn()}
          billingPeriodId="p-1"
          households={[makeHousehold("h-1", "Nakato")]}
          edgeAvailableByHouseholdId={{ "h-1": true }}
          seedNeededByHouseholdId={{ "h-1": true }}
          deviceIdByHouseholdId={{ "h-1": DEVICE }}
          periodStartDate="2026-08-01"
        />
      </Wrap>,
    );
  }

  const dateInput = () =>
    document.querySelector(
      '[data-testid="preflight-seed-read-date-h-1"]',
    ) as HTMLInputElement;
  const dialInput = () =>
    document.querySelector(
      '[data-testid="preflight-seed-dial-h-1"]',
    ) as HTMLInputElement;

  it("defaults to today, so same-day entry stays a single field", () => {
    vi.stubGlobal("fetch", windowedFetch());
    renderSeedRow();
    expect(dateInput().value).toBe(TODAY);
  });

  // THE test. Read on the 4th, typed on the 10th: the six days in between are
  // not the operator's consumption to bill, and before #343 they were.
  it("uses the usage window to the READ day, not the entry day", async () => {
    vi.stubGlobal("fetch", windowedFetch());
    renderSeedRow();

    fireEvent.change(dialInput(), { target: { value: "4196" } });
    fireEvent.change(dateInput(), { target: { value: READ_DAY } });

    await waitFor(() => {
      const math = document.querySelector(
        '[data-testid="preflight-seed-math-h-1"]',
      );
      expect(math?.textContent).toContain("214");
      // 4196 − 214. Billing to the entry day would subtract 980 and derive
      // 3,216, understating the start by 766 kWh — which is then billed.
      expect(math?.textContent).toContain("3,982");
      expect(math?.textContent).not.toContain("3,216");
    });

    // The window itself is on screen, so a wrong date is visible rather than
    // only inferable from a number the operator cannot check.
    expect(
      document.querySelector('[data-testid="preflight-seed-math-h-1"]')
        ?.textContent,
    ).toContain(READ_DAY);
  });

  it("sends the read day in readAt and the read-day arithmetic in startKwh", async () => {
    const fetchMock = windowedFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderSeedRow();

    fireEvent.change(dialInput(), { target: { value: "4196" } });
    fireEvent.change(dateInput(), { target: { value: READ_DAY } });

    const btn = document.querySelector(
      '[data-testid="preflight-generate-button"]',
    ) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false));

    await act(async () => {
      fireEvent.click(btn);
    });

    const generateCall = fetchMock.mock.calls.find(
      ([url]) => url === "/api/billing/generate",
    );
    expect(generateCall).toBeDefined();
    const sent = JSON.parse(
      (generateCall![1] as { body: string }).body,
    ) as { seedReadings: Array<{ readAt: string; startKwh: number }> };

    expect(sent.seedReadings).toHaveLength(1);
    expect(sent.seedReadings[0].startKwh).toBe(4196 - USAGE_TO_READ_DAY);
    // Stored as an ISO timestamp, but it must be the read DAY — the audit
    // value is what makes a wrong seed diagnosable a year later, and "now"
    // was indistinguishable from a correct answer.
    expect(sent.seedReadings[0].readAt.slice(0, 10)).toBe(READ_DAY);
  });

  // The control introduced two reachable wrong states that did not exist
  // before it, so it owes both an answer. `min`/`max` are a browser hint a
  // typed or pasted value walks straight past.
  // `fallbackKwh: 300` is load-bearing in both of these. It resolves the
  // arithmetic — dial 4196 − 300 = 3,896, a perfectly valid seed — so the
  // ONLY thing left that can keep Generate disabled is the date guard.
  it("blocks Generate on a read date before the period started", async () => {
    vi.stubGlobal("fetch", windowedFetch(300));
    renderSeedRow();

    fireEvent.change(dialInput(), { target: { value: "4196" } });
    fireEvent.change(dateInput(), { target: { value: "2026-07-28" } });

    const btn = document.querySelector(
      '[data-testid="preflight-generate-button"]',
    ) as HTMLButtonElement;
    await waitFor(() => {
      expect(
        document.querySelector(
          '[data-testid="preflight-seed-date-problem-h-1"]',
        )?.textContent,
      ).toContain("before this period started");
    });
    // The seed itself resolved, so this is the guard and nothing else.
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="preflight-seed-math-h-1"]')
          ?.textContent,
      ).toContain("3,896"),
    );
    expect(btn.disabled).toBe(true);
  });

  it("blocks Generate on a read date in the future", async () => {
    vi.stubGlobal("fetch", windowedFetch(300));
    renderSeedRow();

    fireEvent.change(dialInput(), { target: { value: "4196" } });
    fireEvent.change(dateInput(), { target: { value: "2026-08-11" } });

    const btn = document.querySelector(
      '[data-testid="preflight-generate-button"]',
    ) as HTMLButtonElement;
    await waitFor(() => {
      expect(
        document.querySelector(
          '[data-testid="preflight-seed-date-problem-h-1"]',
        )?.textContent,
      ).toContain("has not happened yet");
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="preflight-seed-math-h-1"]')
          ?.textContent,
      ).toContain("3,896"),
    );
    expect(btn.disabled).toBe(true);
  });
});
