// @vitest-environment jsdom
/**
 * HouseholdWizard component tests (UX2 / #74 + #146 + #200).
 *
 * Covers:
 *   (a) 4-step transitions (1 → 2 → 3 → 4) work with Next
 *   (b) Each step moves focus to its first focusable field
 *   (c) Step 3 renders a RadioCard per available meter
 *   (d) Step 3 empty-state renders the warn Banner + Next is disabled
 *   (e) Submit posts the expected payload via POST /api/households/with-meter
 *   (f) Cancel with unsaved data shows a confirm dialog
 *   (g) Cancel with all-empty fields closes immediately (no dialog)
 *   (h) #146 — Step 2 renders 5 new address fields
 *   (i) #146 — Step 4 review displays new address fields
 *   (j) #146 — submit payload includes new address fields
 *   (k) #200 — inline DiscoverMeterInline integration in Step 3
 */

import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  HouseholdWizard,
  type AvailableMeter,
} from "../HouseholdWizard";

// Mock next/navigation. `refreshHandler` is module-scoped so individual
// tests can swap in a side-effecting refresh (e.g. to simulate the parent
// server component re-rendering with a new `availableMeters` prop) — this
// is what the #200 regression test for the reset-effect bug needs.
let refreshHandler: () => void = () => {};
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => refreshHandler() }),
}));

// Polyfill ResizeObserver — required by Radix RadioGroup
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

const MICROGRID_ID = "aaaaaaaa-aaaa-4000-8002-000000000001";

const METERS: AvailableMeter[] = [
  {
    id: "dev-1",
    name: "Household A Meter",
    device_type: "consumption_meter",
    edge_id: "edge-1",
    edge_name: "Metering Pi",
    linked_household_name: null,
  },
  {
    id: "dev-2",
    name: "Household B Meter",
    device_type: "consumption_meter",
    edge_id: "edge-1",
    edge_name: "Metering Pi",
    linked_household_name: null,
  },
];

function renderWizard(props: Partial<React.ComponentProps<typeof HouseholdWizard>> = {}) {
  const onOpenChange = vi.fn();
  const defaults: React.ComponentProps<typeof HouseholdWizard> = {
    open: true,
    onOpenChange,
    microgridId: MICROGRID_ID,
    availableMeters: METERS,
    edgesSetupHref: `/microgrids/${MICROGRID_ID}/setup/edges`,
  };
  const merged = { ...defaults, ...props };
  return { onOpenChange, ...render(<HouseholdWizard {...merged} />) };
}

function fillDisplayName(value: string) {
  const input = screen.getByLabelText(/Display name/i) as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
}

/**
 * #155 — fill the phone field. Phone is required to advance past step 1.
 * Tests that need to reach step 2+ must also call this helper after
 * fillDisplayName().
 */
function fillPhone(value: string) {
  const input = screen.getByLabelText(/Primary phone/i) as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
}

describe("HouseholdWizard", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, "fetch");
    // Reset router.refresh side-effect between tests.
    refreshHandler = () => {};
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ──────────────────────────────────────────────────────────────────────
  // (a) 4-step transitions work
  // ──────────────────────────────────────────────────────────────────────
  describe("(a) step transitions", () => {
    it("advances 1 → 2 → 3 → 4 via Next when fields are valid", async () => {
      renderWizard();

      // Step 1
      expect(screen.getByLabelText(/Display name/i)).toBeDefined();
      fillDisplayName("Block A, Unit 1");
      fillPhone("+256 700 000 000");
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      // Step 2
      await waitFor(() => {
        expect(screen.getByLabelText(/Address line 1/i)).toBeDefined();
      });
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      // Step 3 — pick the first meter
      await waitFor(() => {
        expect(
          screen.getByRole("radio", { name: /Household A Meter/i })
        ).toBeDefined();
      });
      fireEvent.click(
        screen.getByRole("radio", { name: /Household A Meter/i })
      );
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      // Step 4 — Create household button should exist
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: /Create household/i })
        ).toBeDefined();
      });
    });

    it("Next is disabled on step 1 until display_name is non-empty", () => {
      renderWizard();
      const next = screen.getByRole("button", { name: /^Next$/ });
      expect(next).toHaveProperty("disabled", true);
      fillDisplayName("Some household");
      // Phone is also required (#155) — Next stays disabled until phone is set.
      expect(next).toHaveProperty("disabled", true);
      const phone = screen.getByLabelText(
        /Primary phone/i
      ) as HTMLInputElement;
      fireEvent.change(phone, { target: { value: "+256 700" } });
      expect(next).toHaveProperty("disabled", false);
    });

    it("(#155) inline error stays hidden until phone is touched, then blocks Next", () => {
      renderWizard();
      // On first render the dialog must NOT yell — error appears only after
      // the user has interacted with the phone field.
      expect(
        screen.queryByText(/Phone is required for payment links/i)
      ).toBeNull();

      fillDisplayName("Block A, Unit 1");
      const next = screen.getByRole("button", { name: /^Next$/ });
      // display_name set, phone still blank → Next disabled regardless of
      // whether the error message is rendered.
      expect(next).toHaveProperty("disabled", true);

      // Touch the phone field (focus + blur) without typing → error appears.
      const phone = screen.getByLabelText(
        /Primary phone/i
      ) as HTMLInputElement;
      fireEvent.blur(phone);
      expect(
        screen.getByText(/Phone is required for payment links/i)
      ).toBeTruthy();

      // Fill phone → error clears and Next enables
      fireEvent.change(phone, { target: { value: "+256 700 000 000" } });
      expect(
        screen.queryByText(/Phone is required for payment links/i)
      ).toBeNull();
      expect(next).toHaveProperty("disabled", false);
    });

    it("(#155) phone input has aria-required", () => {
      renderWizard();
      const phone = screen.getByLabelText(
        /Primary phone/i
      ) as HTMLInputElement;
      expect(phone.getAttribute("aria-required")).toBe("true");
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // (b) Focus management
  // ──────────────────────────────────────────────────────────────────────
  describe("(b) focus management", () => {
    it("focuses display_name input on step 1 open", async () => {
      renderWizard();
      await waitFor(() => {
        const displayName = screen.getByLabelText(/Display name/i);
        expect(document.activeElement).toBe(displayName);
      });
    });

    it("focuses address_line1 input on step 2", async () => {
      renderWizard();
      fillDisplayName("Household X");
      fillPhone("+256 700 000 000");
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      await waitFor(() => {
        const addr = screen.getByLabelText(/Address line 1/i);
        expect(document.activeElement).toBe(addr);
      });
    });

    it("focuses first meter radio on step 3", async () => {
      renderWizard();
      fillDisplayName("Household X");
      fillPhone("+256 700 000 000");
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
      await waitFor(() =>
        expect(screen.getByLabelText(/Address line 1/i)).toBeDefined()
      );
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      await waitFor(() => {
        const firstRadio = screen.getAllByRole("radio")[0];
        expect(document.activeElement).toBe(firstRadio);
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // (c) Step 3 renders a RadioCard per available meter
  // ──────────────────────────────────────────────────────────────────────
  describe("(c) step 3 rendering", () => {
    it("renders one radio per available meter", async () => {
      renderWizard();
      fillDisplayName("Household X");
      fillPhone("+256 700 000 000");
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
      await waitFor(() =>
        expect(screen.getByLabelText(/Address line 1/i)).toBeDefined()
      );
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      await waitFor(() => {
        const radios = screen.getAllByRole("radio");
        expect(radios.length).toBe(METERS.length);
      });

      // Each meter's name is rendered
      for (const m of METERS) {
        expect(screen.getByText(m.name)).toBeDefined();
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // (d) Step 3 empty-state
  // ──────────────────────────────────────────────────────────────────────
  describe("(d) step 3 empty-state", () => {
    it("renders the warn Banner and Next is disabled when no meters exist", async () => {
      renderWizard({ availableMeters: [] });
      fillDisplayName("Household X");
      fillPhone("+256 700 000 000");
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
      await waitFor(() =>
        expect(screen.getByLabelText(/Address line 1/i)).toBeDefined()
      );
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      await waitFor(() => {
        expect(screen.getByText(/No available meters/i)).toBeDefined();
      });

      // Next is disabled (no meter selected; none selectable)
      const next = screen.getByRole("button", { name: /^Next$/ });
      expect(next).toHaveProperty("disabled", true);

      // Banner contains a link to edges setup
      const link = screen.getByRole("link", { name: /Setup > Edges/i });
      expect(link.getAttribute("href")).toContain("/setup/edges");
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // (e) Submit payload
  // ──────────────────────────────────────────────────────────────────────
  describe("(e) submit payload", () => {
    it("POSTs the complete payload to /api/households/with-meter", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ household_id: "new-hh-uuid" }),
      } as Response);

      const { onOpenChange } = renderWizard();

      // Step 1
      fillDisplayName("Block A, Unit 7");
      const phone = screen.getByLabelText(/Primary phone/i) as HTMLInputElement;
      fireEvent.change(phone, { target: { value: "+256 700 000 000" } });
      const email = screen.getByLabelText(/^Email$/i) as HTMLInputElement;
      fireEvent.change(email, { target: { value: "ops@example.com" } });
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      // Step 2
      await waitFor(() =>
        expect(screen.getByLabelText(/Address line 1/i)).toBeDefined()
      );
      fireEvent.change(screen.getByLabelText(/Address line 1/i), {
        target: { value: "Plot 14, Kisakye Ln" },
      });
      fireEvent.change(screen.getByLabelText(/Address line 2/i), {
        target: { value: "Block A" },
      });
      fireEvent.change(screen.getByLabelText(/Unit label/i), {
        target: { value: "Unit 7" },
      });
      fireEvent.change(screen.getByLabelText(/^City$/i), {
        target: { value: "Kampala" },
      });
      fireEvent.change(screen.getByLabelText(/Region \/ state/i), {
        target: { value: "Central Region" },
      });
      fireEvent.change(screen.getByLabelText(/^Country$/i), {
        target: { value: "Uganda" },
      });
      fireEvent.change(screen.getByLabelText(/Postal code/i), {
        target: { value: "00256" },
      });
      fireEvent.change(screen.getByLabelText(/Geography notes/i), {
        target: { value: "Near the market" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      // Step 3 — pick dev-2
      await waitFor(() =>
        expect(screen.getAllByRole("radio").length).toBe(METERS.length)
      );
      fireEvent.click(
        screen.getByRole("radio", { name: /Household B Meter/i })
      );
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      // Step 4 — submit
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /Create household/i })
        ).toBeDefined()
      );
      fireEvent.click(screen.getByRole("button", { name: /Create household/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/households/with-meter");
      expect(init?.method).toBe("POST");

      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({
        microgrid_id: MICROGRID_ID,
        display_name: "Block A, Unit 7",
        primary_phone: "+256 700 000 000",
        primary_email: "ops@example.com",
        address_line1: "Plot 14, Kisakye Ln",
        address_line2: "Block A",
        unit_label: "Unit 7",
        address_city: "Kampala",
        address_region: "Central Region",
        address_country: "Uganda",
        address_postal_code: "00256",
        geography_notes: "Near the market",
        device_id: "dev-2",
      });

      // On success, wizard closes
      await waitFor(() => {
        expect(onOpenChange).toHaveBeenCalledWith(false);
      });
    });

    it("sends null for optional fields left empty (phone is required #155)", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ household_id: "hh-2" }),
      } as Response);

      renderWizard();
      fillDisplayName("Minimal Household");
      // Phone is required (#155) — set it; everything else stays empty.
      fillPhone("+256700000000");
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      await waitFor(() =>
        expect(screen.getByLabelText(/Address line 1/i)).toBeDefined()
      );
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      await waitFor(() =>
        expect(screen.getAllByRole("radio").length).toBe(METERS.length)
      );
      fireEvent.click(
        screen.getByRole("radio", { name: /Household A Meter/i })
      );
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /Create household/i })
        ).toBeDefined()
      );
      fireEvent.click(screen.getByRole("button", { name: /Create household/i }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({
        display_name: "Minimal Household",
        primary_phone: "+256700000000",
        primary_email: null,
        address_line1: null,
        address_line2: null,
        unit_label: null,
        address_city: null,
        address_region: null,
        address_country: null,
        address_postal_code: null,
        geography_notes: null,
        device_id: "dev-1",
      });
    });
  });

  // ── #146 tests ────────────────────────────────────────────────────────────

  describe("(h) #146 — Step 2 new address fields", () => {
    it("renders City, Region/state, Country, Postal code, Geography notes in step 2", async () => {
      renderWizard();
      fillDisplayName("Household X");
      fillPhone("+256 700 000 000");
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      await waitFor(() =>
        expect(screen.getByLabelText(/Address line 1/i)).toBeDefined()
      );

      expect(screen.getByLabelText(/^City$/i)).toBeDefined();
      expect(screen.getByLabelText(/Region \/ state/i)).toBeDefined();
      expect(screen.getByLabelText(/^Country$/i)).toBeDefined();
      expect(screen.getByLabelText(/Postal code/i)).toBeDefined();
      // Geography notes is a textarea
      const notesField = screen.getByLabelText(/Geography notes/i);
      expect(notesField.tagName.toLowerCase()).toBe("textarea");
    });
  });

  describe("(i) #146 — Step 4 review shows address fields", () => {
    it("displays new address fields in the review summary", async () => {
      renderWizard();

      // Step 1
      fillDisplayName("Household X");
      fillPhone("+256 700 000 000");
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      // Step 2 — fill city + country
      await waitFor(() =>
        expect(screen.getByLabelText(/Address line 1/i)).toBeDefined()
      );
      fireEvent.change(screen.getByLabelText(/^City$/i), {
        target: { value: "Kampala" },
      });
      fireEvent.change(screen.getByLabelText(/^Country$/i), {
        target: { value: "Uganda" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      // Step 3 — pick meter
      await waitFor(() =>
        expect(screen.getAllByRole("radio").length).toBe(METERS.length)
      );
      fireEvent.click(
        screen.getByRole("radio", { name: /Household A Meter/i })
      );
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      // Step 4 — values appear in review
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /Create household/i })
        ).toBeDefined()
      );
      expect(screen.getByText("Kampala")).toBeDefined();
      expect(screen.getByText("Uganda")).toBeDefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // (f) Cancel-with-unsaved-data confirm flow
  // ──────────────────────────────────────────────────────────────────────
  describe("(f) cancel with unsaved data", () => {
    it("shows ConfirmDialog when fields are non-empty and Cancel is clicked", async () => {
      renderWizard();
      fillDisplayName("Dirty household");
      fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));

      await waitFor(() => {
        expect(screen.getByText(/Discard unsaved household/i)).toBeDefined();
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // #158 — no-meter (manual billing) checkbox path
  // ──────────────────────────────────────────────────────────────────────
  describe("#158 no_meter checkbox", () => {
    it("checkbox checked → submit body sends device_id: null", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ household_id: "manual-hh" }),
      } as Response);

      renderWizard();

      // Step 1
      fillDisplayName("Manual-Bill HH");
      fillPhone("+256700000001");
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      // Step 2 → Next
      await waitFor(() =>
        expect(screen.getByLabelText(/Address line 1/i)).toBeDefined()
      );
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      // Step 3 → tick "no meter" checkbox; Next must enable
      await waitFor(() => {
        expect(
          screen.getByText(/This household does not have a meter/i)
        ).toBeTruthy();
      });
      const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
      fireEvent.click(checkbox);
      expect(checkbox.checked).toBe(true);
      const next = screen.getByRole("button", { name: /^Next$/ });
      expect(next).toHaveProperty("disabled", false);
      fireEvent.click(next);

      // Step 4 → review shows manual-billing string
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /Create household/i })
        ).toBeDefined()
      );
      expect(screen.getByText(/manual billing/i)).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: /Create household/i }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse(init?.body as string);
      // The submit body sends null (not "") for device_id when no_meter is on.
      expect(body.device_id).toBeNull();
    });

    it("checkbox unchecked → existing meter-required path preserved", async () => {
      // Step 3 with no checkbox toggle → must pick a meter to advance.
      renderWizard();
      fillDisplayName("Metered HH");
      fillPhone("+256700000002");
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
      await waitFor(() =>
        expect(screen.getByLabelText(/Address line 1/i)).toBeDefined()
      );
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      // Step 3 — Next is disabled until a radio is picked
      await waitFor(() =>
        expect(screen.getAllByRole("radio").length).toBe(METERS.length)
      );
      const next = screen.getByRole("button", { name: /^Next$/ });
      expect(next).toHaveProperty("disabled", true);
      // Picking a meter enables Next
      fireEvent.click(screen.getByRole("radio", { name: /Household A Meter/i }));
      expect(next).toHaveProperty("disabled", false);
    });

    it("checkbox checked + zero available meters → Save (Create) is enabled (manual-billing path)", async () => {
      renderWizard({ availableMeters: [] });
      fillDisplayName("Manual-only");
      fillPhone("+256700000003");
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
      await waitFor(() =>
        expect(screen.getByLabelText(/Address line 1/i)).toBeDefined()
      );
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      // Step 3 — empty-state banner shows by default; tick the no-meter
      // checkbox to fall into the manual-billing branch.
      await waitFor(() =>
        expect(
          screen.getByText(/This household does not have a meter/i)
        ).toBeTruthy()
      );
      const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
      fireEvent.click(checkbox);

      // Banner is replaced by the manual-billing info panel
      expect(screen.queryByText(/No available meters/i)).toBeNull();

      // Next is enabled
      const next = screen.getByRole("button", { name: /^Next$/ });
      expect(next).toHaveProperty("disabled", false);
      fireEvent.click(next);

      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: /Create household/i })
        ).toBeDefined()
      );
      const submit = screen.getByRole("button", { name: /Create household/i });
      expect(submit).toHaveProperty("disabled", false);
    });

    it("blank phone STILL blocks Submit when no_meter is checked (#155 preserved)", async () => {
      // Coordinated #155 + #158: phone-required gates step 1 regardless of
      // step-3 path. Verify by setting display_name and going manual-billing
      // — without phone, Next stays disabled in step 1 and the user never
      // reaches step 3.
      renderWizard();
      fillDisplayName("No-phone HH");
      // Leave phone blank
      const next = screen.getByRole("button", { name: /^Next$/ });
      expect(next).toHaveProperty("disabled", true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // (g) Cancel with all-empty fields closes immediately
  // ──────────────────────────────────────────────────────────────────────
  describe("(g) cancel with all-empty fields", () => {
    it("closes immediately without ConfirmDialog", async () => {
      const { onOpenChange } = renderWizard();
      fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));

      // onOpenChange(false) should be called synchronously
      await waitFor(() => {
        expect(onOpenChange).toHaveBeenCalledWith(false);
      });

      // And the confirm dialog should NOT be shown
      expect(screen.queryByText(/Discard unsaved household/i)).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // (k) #200 — inline DiscoverMeterInline integration
  // URL-dispatching mock pattern: two endpoints
  //   /api/edges/<id>/discover-devices  →  GET — discovery
  //   /api/devices                       →  POST — persist single meter
  //   /api/households/with-meter         →  POST — wizard submit
  // ──────────────────────────────────────────────────────────────────────
  describe("(k) #200 inline discovery", () => {
    const EDGE_1 = {
      id: "edge-1",
      name: "Metering Pi",
      openems_edge_id: "edge1",
    };
    const EDGE_2 = {
      id: "edge-2",
      name: "Aux Edge",
      openems_edge_id: "edge2",
    };

    /**
     * Build a fetch mock that dispatches by URL substring. Each endpoint
     * has a queue of responses; the first call to the matching URL pops
     * the head of the queue.
     */
    type Resp = { ok: boolean; status: number; jsonBody: unknown };
    function makeUrlDispatcher(
      handlers: Record<
        "discover" | "devices" | "household",
        Resp[] | ((url: string) => Resp)
      >
    ) {
      const counts = { discover: 0, devices: 0, household: 0 };
      const impl = vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        const route = url.includes("/discover-devices")
          ? "discover"
          : url.includes("/api/devices")
          ? "devices"
          : url.includes("/api/households/with-meter")
          ? "household"
          : null;
        if (!route) {
          throw new Error(`Unhandled fetch URL: ${url}`);
        }
        counts[route]++;
        const handler = handlers[route];
        const r =
          typeof handler === "function" ? handler(url) : handler.shift();
        if (!r) {
          throw new Error(`No mock response queued for ${route} at ${url}`);
        }
        return {
          ok: r.ok,
          status: r.status,
          json: async () => r.jsonBody,
        } as Response;
      });
      return { impl, counts };
    }

    function discoveryResponse(devices: object[], online = true) {
      return {
        ok: true,
        status: 200,
        jsonBody: {
          edgeId: "edge1",
          online,
          devices,
        },
      };
    }

    function consumptionMeter(
      componentId: string,
      alias = "Discovered Meter"
    ) {
      return {
        componentId,
        factoryId: "io.openems.impl.meter.consumption.ConsumptionMeter",
        alias,
        nature: "io.openems.edge.meter.api.ElectricityMeter",
        openemsChannelAddress: `${componentId}/ActiveConsumptionEnergy`,
        suggestedDeviceType: "consumption_meter",
        alreadyAdded: false,
      };
    }

    it("renders the discovery section with edge1 pre-selected (single-edge collapses to label)", async () => {
      renderWizard({
        availableMeters: [],
        edges: [EDGE_1],
        edgeIdsWithoutConsumptionMeter: [EDGE_1.id],
      });
      // navigate to step 3
      fillDisplayName("HH");
      fillPhone("+256");
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
      await waitFor(() =>
        expect(screen.getByLabelText(/Address line 1/i)).toBeDefined()
      );
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      // Discovery section visible
      await waitFor(() =>
        expect(
          screen.getByText(/Discover meters on an edge/i)
        ).toBeDefined()
      );
      // Single-edge label shows the name (not a Select)
      expect(screen.getByText(/Metering Pi/i)).toBeDefined();
      // Discover button visible
      expect(
        screen.getByRole("button", { name: /Discover meters/i })
      ).toBeDefined();
    });

    it("happy path: discover → pick → save → meter appears + auto-selected, step stays on 3", async () => {
      const { impl } = makeUrlDispatcher({
        discover: [discoveryResponse([consumptionMeter("meter9", "M9")])],
        devices: [
          {
            ok: true,
            status: 200,
            jsonBody: {
              saved: [
                {
                  id: "dev-new",
                  name: "M9",
                  device_type: "consumption_meter",
                  openems_component_id: "meter9",
                },
              ],
            },
          },
        ],
        household: [],
      });
      fetchMock.mockImplementation(impl as never);

      renderWizard({
        availableMeters: [],
        edges: [EDGE_1],
        edgeIdsWithoutConsumptionMeter: [EDGE_1.id],
      });
      fillDisplayName("HH");
      fillPhone("+256");
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
      await waitFor(() =>
        expect(screen.getByLabelText(/Address line 1/i)).toBeDefined()
      );
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      // Click Discover
      fireEvent.click(
        await screen.findByRole("button", { name: /Discover meters/i })
      );

      // Wait for the candidate radio to render
      await waitFor(() =>
        expect(screen.getByText("M9")).toBeDefined()
      );
      // Pick the candidate
      const candidateRadios = screen.getAllByRole("radio");
      // The first radio in the wizard's own RadioGroup may not exist (no
      // available meters yet) — DiscoverMeterInline owns the only group.
      fireEvent.click(candidateRadios[0]);

      // Save & select
      fireEvent.click(screen.getByRole("button", { name: /Save & select/i }));

      // The new meter should now appear in the wizard's own RadioGroup —
      // identified by the meter name "M9". It is also auto-selected.
      await waitFor(() => {
        const radios = screen.getAllByRole("radio");
        // After append, the radio list should include the new meter card.
        const checked = radios.filter(
          (r) => r.getAttribute("aria-checked") === "true"
        );
        expect(checked.length).toBeGreaterThanOrEqual(1);
      });

      // Still on step 3 (Next button is the visible advance, not Create)
      expect(
        screen.queryByRole("button", { name: /Create household/i })
      ).toBeNull();
      // Next is enabled (wrapped in waitFor — the enable transition is async after Save & select)
      await waitFor(() => {
        const next = screen.getByRole("button", { name: /^Next$/ });
        expect(next).toHaveProperty("disabled", false);
      });
    });

    it("empty discovery (no consumption meters after filter) renders the no-meters message", async () => {
      const { impl } = makeUrlDispatcher({
        discover: [discoveryResponse([])],
        devices: [],
        household: [],
      });
      fetchMock.mockImplementation(impl as never);

      renderWizard({
        availableMeters: [],
        edges: [EDGE_1],
        edgeIdsWithoutConsumptionMeter: [EDGE_1.id],
      });
      fillDisplayName("HH");
      fillPhone("+256");
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
      await waitFor(() =>
        expect(screen.getByLabelText(/Address line 1/i)).toBeDefined()
      );
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      fireEvent.click(
        await screen.findByRole("button", { name: /Discover meters/i })
      );
      await waitFor(() =>
        expect(
          screen.getByText(/No new consumption meters on this edge/i)
        ).toBeDefined()
      );
    });

    it("offline edge response renders the offline notice", async () => {
      const { impl } = makeUrlDispatcher({
        discover: [discoveryResponse([], false)],
        devices: [],
        household: [],
      });
      fetchMock.mockImplementation(impl as never);

      renderWizard({
        availableMeters: [],
        edges: [EDGE_1],
        edgeIdsWithoutConsumptionMeter: [EDGE_1.id],
      });
      fillDisplayName("HH");
      fillPhone("+256");
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
      await waitFor(() =>
        expect(screen.getByLabelText(/Address line 1/i)).toBeDefined()
      );
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      fireEvent.click(
        await screen.findByRole("button", { name: /Discover meters/i })
      );
      await waitFor(() =>
        expect(
          screen.getByText(/Edge is offline — retry when it reconnects/i)
        ).toBeDefined()
      );
    });

    it("network error renders Retry; clicking it re-fires the GET", async () => {
      let calls = 0;
      const impl = vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/discover-devices")) {
          calls++;
          if (calls === 1) {
            throw new Error("network down");
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              edgeId: "edge1",
              online: true,
              devices: [],
            }),
          } as Response;
        }
        throw new Error(`Unhandled URL: ${url}`);
      });
      fetchMock.mockImplementation(impl as never);

      renderWizard({
        availableMeters: [],
        edges: [EDGE_1],
        edgeIdsWithoutConsumptionMeter: [EDGE_1.id],
      });
      fillDisplayName("HH");
      fillPhone("+256");
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
      await waitFor(() =>
        expect(screen.getByLabelText(/Address line 1/i)).toBeDefined()
      );
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      fireEvent.click(
        await screen.findByRole("button", { name: /Discover meters/i })
      );
      const retry = await screen.findByRole("button", { name: /^Retry$/i });
      fireEvent.click(retry);

      await waitFor(() => expect(calls).toBe(2));
    });

    it("POST /api/devices 500 → renders inline error, preserves the user's pick", async () => {
      const { impl } = makeUrlDispatcher({
        discover: [discoveryResponse([consumptionMeter("meterX", "MX")])],
        devices: [
          {
            ok: false,
            status: 500,
            jsonBody: { error: "Could not save device" },
          },
        ],
        household: [],
      });
      fetchMock.mockImplementation(impl as never);

      renderWizard({
        availableMeters: [],
        edges: [EDGE_1],
        edgeIdsWithoutConsumptionMeter: [EDGE_1.id],
      });
      fillDisplayName("HH");
      fillPhone("+256");
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
      await waitFor(() =>
        expect(screen.getByLabelText(/Address line 1/i)).toBeDefined()
      );
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      fireEvent.click(
        await screen.findByRole("button", { name: /Discover meters/i })
      );
      await waitFor(() =>
        expect(screen.getByText("MX")).toBeDefined()
      );
      const candidateRadio = screen.getAllByRole("radio")[0];
      fireEvent.click(candidateRadio);
      fireEvent.click(screen.getByRole("button", { name: /Save & select/i }));

      // Inline error visible
      await waitFor(() =>
        expect(screen.getByText(/Could not save device/i)).toBeDefined()
      );

      // Pick is preserved — radio is still in the document AND the editable
      // name input is still rendered (it lives inside the picked-section
      // panel).
      expect(screen.getByDisplayValue("MX")).toBeDefined();
      // Wizard still on step 3 (no Create household button)
      expect(
        screen.queryByRole("button", { name: /Create household/i })
      ).toBeNull();
    });

    it("toggling no_meter ON hides discovery section; OFF re-shows in idle phase", async () => {
      const { impl } = makeUrlDispatcher({
        discover: [discoveryResponse([])],
        devices: [],
        household: [],
      });
      fetchMock.mockImplementation(impl as never);

      renderWizard({
        availableMeters: [],
        edges: [EDGE_1],
        edgeIdsWithoutConsumptionMeter: [EDGE_1.id],
      });
      fillDisplayName("HH");
      fillPhone("+256");
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
      await waitFor(() =>
        expect(screen.getByLabelText(/Address line 1/i)).toBeDefined()
      );
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      // Initially the discovery section is visible.
      await waitFor(() =>
        expect(
          screen.getByText(/Discover meters on an edge/i)
        ).toBeDefined()
      );

      // Toggle no_meter ON — section disappears.
      const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
      fireEvent.click(checkbox);
      expect(checkbox.checked).toBe(true);
      await waitFor(() =>
        expect(
          screen.queryByText(/Discover meters on an edge/i)
        ).toBeNull()
      );

      // Toggle OFF — section reappears in idle phase (no scan results).
      fireEvent.click(checkbox);
      await waitFor(() =>
        expect(
          screen.getByText(/Discover meters on an edge/i)
        ).toBeDefined()
      );
      // The discover button is in idle ("Discover meters", not "Scanning…")
      expect(
        screen.getByRole("button", { name: /^Discover meters$/i })
      ).toBeDefined();
    });

    /**
     * #200 regression: when `handleDevicePersisted` calls `router.refresh()`
     * after a successful inline-discover save, the parent server component
     * re-renders with a new `availableMeters` prop reference. The reset
     * effect MUST NOT fire on that prop change — it would wipe step state
     * and the user's typed values back to step 1. This test wraps the
     * wizard in a controlled parent that mutates the prop reference inside
     * `router.refresh()`, simulating the production re-render path that
     * the prior `vi.fn()` no-op mock missed.
     */
    it("router.refresh after inline-persist preserves step + form state (regression for reset-on-prop-change)", async () => {
      const { impl } = makeUrlDispatcher({
        discover: [discoveryResponse([consumptionMeter("meter9", "M9")])],
        devices: [
          {
            ok: true,
            status: 200,
            jsonBody: {
              saved: [
                {
                  id: "dev-new",
                  name: "M9",
                  device_type: "consumption_meter",
                  openems_component_id: "meter9",
                },
              ],
            },
          },
        ],
        household: [],
      });
      fetchMock.mockImplementation(impl as never);

      // Controlled wrapper: lets the test mutate the `availableMeters`
      // prop reference from inside `router.refresh()`, mimicking how a
      // server-component parent re-renders after `router.refresh()`.
      function Wrapper() {
        const [meters, setMeters] = React.useState<AvailableMeter[]>([]);
        // Hook the test-scoped refresh handler to push a new prop ref.
        React.useEffect(() => {
          refreshHandler = () => {
            // New array reference (would be returned by the server
            // component on its next render after the device was saved).
            setMeters([
              {
                id: "dev-new",
                name: "M9",
                device_type: "consumption_meter",
                edge_id: "edge-1",
                edge_name: "Metering Pi",
                linked_household_name: null,
              },
            ]);
          };
          return () => {
            refreshHandler = () => {};
          };
        }, []);
        return (
          <HouseholdWizard
            open
            onOpenChange={() => {}}
            microgridId={MICROGRID_ID}
            availableMeters={meters}
            edgesSetupHref={`/microgrids/${MICROGRID_ID}/setup/edges`}
            edges={[EDGE_1]}
            edgeIdsWithoutConsumptionMeter={[EDGE_1.id]}
          />
        );
      }

      render(<Wrapper />);

      // Step 1 — fill display name + phone
      fillDisplayName("My Household");
      fillPhone("+256700000111");
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      // Step 2 — wait for step 2 fields, then advance
      await waitFor(() =>
        expect(screen.getByLabelText(/Address line 1/i)).toBeDefined()
      );
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      // Step 3 — discover & save flow that triggers router.refresh()
      fireEvent.click(
        await screen.findByRole("button", { name: /Discover meters/i })
      );
      await waitFor(() => expect(screen.getByText("M9")).toBeDefined());
      const candidateRadios = screen.getAllByRole("radio");
      fireEvent.click(candidateRadios[0]);
      fireEvent.click(screen.getByRole("button", { name: /Save & select/i }));

      // After persist, the wrapper's refreshHandler fires, replacing the
      // `availableMeters` prop with a brand-new array. Pre-fix, this
      // wiped state back to step 1.
      await waitFor(() => {
        const radios = screen.getAllByRole("radio");
        const checked = radios.filter(
          (r) => r.getAttribute("aria-checked") === "true"
        );
        expect(checked.length).toBeGreaterThanOrEqual(1);
      });

      // Still on step 3 — the Create button is the step-4 advance, so its
      // absence is the proof we are NOT on step 4 either; combined with the
      // step-3-only Discover panel still in the DOM, we are on step 3.
      expect(
        screen.queryByRole("button", { name: /Create household/i })
      ).toBeNull();
      // Step 1 and Step 2 fields must NOT be visible (we'd see them if
      // the wizard had snapped back to step 1).
      expect(screen.queryByLabelText(/^Display name/i)).toBeNull();
      expect(screen.queryByLabelText(/Address line 1/i)).toBeNull();

      // Advance to step 4 — preserved values must show in the review.
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
      // Use findByRole with an extended timeout: the step-4 render follows
      // 4 step transitions + the fetch-mock dance, and the default 1s
      // waitFor occasionally races on contended CI/local runs.
      await screen.findByRole(
        "button",
        { name: /Create household/i },
        { timeout: 5000 }
      );
      // Display name and phone preserved on the review panel.
      expect(screen.getByText("My Household")).toBeDefined();
      expect(screen.getByText("+256700000111")).toBeDefined();
    });

    it("multi-edge: picker renders both edges; default-selects first edge in edgeIdsWithoutConsumptionMeter by (name, id)", async () => {
      // Edge naming: "Aux Edge" (a) < "Metering Pi" (m).
      // Both are in edgeIdsWithoutConsumptionMeter — alphabetical first
      // by name is Aux Edge.
      renderWizard({
        availableMeters: [],
        edges: [EDGE_1, EDGE_2],
        edgeIdsWithoutConsumptionMeter: [EDGE_1.id, EDGE_2.id],
      });
      fillDisplayName("HH");
      fillPhone("+256");
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
      await waitFor(() =>
        expect(screen.getByLabelText(/Address line 1/i)).toBeDefined()
      );
      fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));

      // The Select trigger displays the picked edge's name.
      // Aux Edge sorts first alphabetically by name.
      await waitFor(() => {
        const trigger = screen.getByRole("combobox");
        expect(trigger.textContent).toContain("Aux Edge");
      });
    });
  });
});

