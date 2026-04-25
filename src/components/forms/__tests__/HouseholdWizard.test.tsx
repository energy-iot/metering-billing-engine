// @vitest-environment jsdom
/**
 * HouseholdWizard component tests (UX2 / #74 + #146).
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
 */

import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  HouseholdWizard,
  type AvailableMeter,
} from "../HouseholdWizard";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
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

    it("(#155) blank phone shows inline error AND blocks Next", () => {
      renderWizard();
      // Step 1 is visited from open → inline error visible immediately.
      expect(
        screen.getByText(/Phone is required for payment links/i)
      ).toBeTruthy();

      fillDisplayName("Block A, Unit 1");
      // display_name set, phone still blank → Next disabled
      const next = screen.getByRole("button", { name: /^Next$/ });
      expect(next).toHaveProperty("disabled", true);

      // Fill phone → error clears and Next enables
      const phone = screen.getByLabelText(
        /Primary phone/i
      ) as HTMLInputElement;
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
      const email = screen.getByLabelText(/Primary email/i) as HTMLInputElement;
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
});

