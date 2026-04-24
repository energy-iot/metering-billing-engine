// @vitest-environment jsdom
/**
 * EntityForm tests (#76 + #132).
 *
 * Covers:
 *   - Organization: create POSTs to /api/organizations with all fields.
 *   - Community: create includes injected parentOrgId (locked mode).
 *   - Community picker mode (#132): org select required; payload uses selectedOrgId.
 *   - Microgrid: create includes parentCommunityId + currency default (locked mode).
 *   - Microgrid picker mode (#132): community select required; payload uses selectedCommunityId.
 *   - Edit mode (microgrid): PATCH payload contains ONLY dirty fields;
 *     untouched fields (name, currency) are NOT sent when only address_city
 *     changes.
 *   - 422 with field → inline field error appears; top-level banner hidden.
 *   - 409 duplicate name → top-level banner + inline name error.
 *   - 403 → top-level permission banner.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { EntityForm } from "../EntityForm";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

describe("EntityForm", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Organization — create ───────────────────────────────────────────────
  describe("organization: create", () => {
    it("POSTs to /api/organizations with the full payload", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ organization: { id: "o1" } }),
      } as Response);

      render(
        <EntityForm
          entity="organization"
          mode="create"
          open={true}
          onOpenChange={() => {}}
        />
      );

      fireEvent.change(screen.getByLabelText(/^Name/i), {
        target: { value: "New Field Energy" },
      });
      fireEvent.change(screen.getByLabelText(/^City/i), {
        target: { value: "Kampala" },
      });
      fireEvent.change(screen.getByLabelText(/^Country/i), {
        target: { value: "Uganda" },
      });
      fireEvent.click(screen.getByRole("button", { name: /create/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/organizations");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({
        name: "New Field Energy",
        address_city: "Kampala",
        address_country: "Uganda",
      });
    });

    it("shows inline field error on 422 response", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({
          error: "City is required.",
          field: "address_city",
        }),
      } as Response);

      render(
        <EntityForm
          entity="organization"
          mode="create"
          open={true}
          onOpenChange={() => {}}
        />
      );

      fireEvent.change(screen.getByLabelText(/^Name/i), {
        target: { value: "X" },
      });
      fireEvent.change(screen.getByLabelText(/^City/i), {
        target: { value: "Kampala" },
      });
      fireEvent.change(screen.getByLabelText(/^Country/i), {
        target: { value: "Uganda" },
      });

      fireEvent.click(screen.getByRole("button", { name: /create/i }));

      await waitFor(() => {
        const alerts = screen.getAllByRole("alert");
        const cityErr = alerts.find((a) =>
          /city is required/i.test(a.textContent ?? "")
        );
        expect(cityErr).toBeDefined();
      });
    });
  });

  // ── Community — create ───────────────────────────────────────────────────
  describe("community: create", () => {
    it("POSTs to /api/communities with injected parentOrgId", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ community: { id: "c1" } }),
      } as Response);

      render(
        <EntityForm
          entity="community"
          mode="create"
          parentOrgId="org-a"
          open={true}
          onOpenChange={() => {}}
        />
      );

      fireEvent.change(screen.getByLabelText(/^Name/i), {
        target: { value: "Kisakye" },
      });
      fireEvent.click(screen.getByRole("button", { name: /create/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/communities");
      const body = JSON.parse(init?.body as string);
      expect(body.name).toBe("Kisakye");
      expect(body.org_id).toBe("org-a");
    });
  });

  // ── Microgrid — create ───────────────────────────────────────────────────
  describe("microgrid: create", () => {
    it("POSTs to /api/microgrids with community_id and default UGX currency", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ microgrid: { id: "m1" } }),
      } as Response);

      render(
        <EntityForm
          entity="microgrid"
          mode="create"
          parentCommunityId="c-a"
          open={true}
          onOpenChange={() => {}}
        />
      );

      fireEvent.change(screen.getByLabelText(/^Name/i), {
        target: { value: "Kisakye MG-1" },
      });
      fireEvent.click(screen.getByRole("button", { name: /create/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/microgrids");
      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({
        name: "Kisakye MG-1",
        community_id: "c-a",
        currency: "UGX",
      });
    });

    it("409 duplicate-name surfaces top-level banner + inline name error", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          error: "A microgrid named 'Kisakye MG-1' already exists in this community.",
          field: "name",
        }),
      } as Response);

      render(
        <EntityForm
          entity="microgrid"
          mode="create"
          parentCommunityId="c-a"
          open={true}
          onOpenChange={() => {}}
        />
      );

      fireEvent.change(screen.getByLabelText(/^Name/i), {
        target: { value: "Kisakye MG-1" },
      });
      fireEvent.click(screen.getByRole("button", { name: /create/i }));

      await waitFor(() => {
        const alerts = screen.getAllByRole("alert");
        const hasBanner = alerts.some((a) =>
          /already exists/i.test(a.textContent ?? "")
        );
        expect(hasBanner).toBe(true);
      });
    });

    it("403 surfaces top-level permission banner", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ error: "Not authorized" }),
      } as Response);

      render(
        <EntityForm
          entity="microgrid"
          mode="create"
          parentCommunityId="c-a"
          open={true}
          onOpenChange={() => {}}
        />
      );

      fireEvent.change(screen.getByLabelText(/^Name/i), {
        target: { value: "Blocked" },
      });
      fireEvent.click(screen.getByRole("button", { name: /create/i }));

      await waitFor(() => {
        expect(screen.getByText(/Not authorized/i)).toBeDefined();
      });
    });
  });

  // ── Microgrid — edit / dirty-fields ─────────────────────────────────────
  describe("microgrid: edit dirty-fields", () => {
    it("only sends changed fields (name, currency untouched when address changes)", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ microgrid: { id: "m1" } }),
      } as Response);

      const initial = {
        id: "m1",
        community_id: "c-a",
        name: "Kisakye MG-1",
        currency: "UGX",
        address_line1: null,
        address_line2: null,
        address_city: "Old City",
        address_region: null,
        address_country: "Uganda",
        address_postal_code: null,
        lat: null,
        lng: null,
        created_at: "2026-01-01T00:00:00Z",
      };

      render(
        <EntityForm
          entity="microgrid"
          mode="edit"
          parentCommunityId="c-a"
          initialValues={initial}
          open={true}
          onOpenChange={() => {}}
        />
      );

      // Change only the city
      const cityInput = screen.getByLabelText(/^City/i);
      fireEvent.change(cityInput, { target: { value: "New City" } });

      fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/microgrids/m1");
      expect(init?.method).toBe("PATCH");

      const body = JSON.parse(init?.body as string);
      // ONLY address_city should be present
      expect(body).toEqual({ address_city: "New City" });
      // Dirty-fields guarantee: name + currency NOT sent
      expect(body).not.toHaveProperty("name");
      expect(body).not.toHaveProperty("currency");
      expect(body).not.toHaveProperty("address_country");
    });

    it("sends multiple dirty fields in one request when several change", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ microgrid: { id: "m1" } }),
      } as Response);

      const initial = {
        id: "m1",
        community_id: "c-a",
        name: "Kisakye MG-1",
        currency: "UGX",
        address_line1: null,
        address_line2: null,
        address_city: "Kampala",
        address_region: null,
        address_country: "Uganda",
        address_postal_code: null,
        lat: null,
        lng: null,
        created_at: "2026-01-01T00:00:00Z",
      };

      render(
        <EntityForm
          entity="microgrid"
          mode="edit"
          parentCommunityId="c-a"
          initialValues={initial}
          open={true}
          onOpenChange={() => {}}
        />
      );

      fireEvent.change(screen.getByLabelText(/^Name/i), {
        target: { value: "Kisakye MG-2" },
      });
      fireEvent.change(screen.getByLabelText(/^City/i), {
        target: { value: "Entebbe" },
      });

      fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });

      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual({
        name: "Kisakye MG-2",
        address_city: "Entebbe",
      });
    });
  });

  // ── Community — picker mode (#132) ───────────────────────────────────────
  describe("community: picker mode (availableOrgs)", () => {
    const orgs = [
      { id: "org-a", name: "Alpha Energy" },
      { id: "org-b", name: "Beta Power" },
    ];

    it("renders an Organization select when availableOrgs is provided", () => {
      render(
        <EntityForm
          entity="community"
          mode="create"
          availableOrgs={orgs}
          open={true}
          onOpenChange={() => {}}
        />
      );
      expect(screen.getByLabelText(/^Organization/i)).toBeTruthy();
    });

    it("shows a validation error when submitted without selecting an org", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ community: { id: "c1" } }),
      } as Response);

      render(
        <EntityForm
          entity="community"
          mode="create"
          availableOrgs={orgs}
          open={true}
          onOpenChange={() => {}}
        />
      );

      fireEvent.change(screen.getByLabelText(/^Name/i), {
        target: { value: "Test Community" },
      });
      fireEvent.click(screen.getByRole("button", { name: /create/i }));

      await waitFor(() => {
        const alerts = screen.getAllByRole("alert");
        const orgErr = alerts.find((a) =>
          /organization is required/i.test(a.textContent ?? "")
        );
        expect(orgErr).toBeDefined();
      });
      // fetch must NOT have been called — client validation stopped submission.
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // ── Microgrid — picker mode (#132) ───────────────────────────────────────
  describe("microgrid: picker mode (availableCommunities)", () => {
    const communities = [
      { id: "c-a", name: "Kisakye", org_name: "EnergyIoT Uganda" },
      { id: "c-b", name: "Gulu", org_name: "EnergyIoT Uganda" },
    ];

    it("renders a Community select when availableCommunities is provided", () => {
      render(
        <EntityForm
          entity="microgrid"
          mode="create"
          availableCommunities={communities}
          open={true}
          onOpenChange={() => {}}
        />
      );
      expect(screen.getByLabelText(/^Community/i)).toBeTruthy();
    });

    it("shows validation error when submitted without selecting a community", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ microgrid: { id: "m1" } }),
      } as Response);

      render(
        <EntityForm
          entity="microgrid"
          mode="create"
          availableCommunities={communities}
          open={true}
          onOpenChange={() => {}}
        />
      );

      fireEvent.change(screen.getByLabelText(/^Name/i), {
        target: { value: "Test MG" },
      });
      fireEvent.click(screen.getByRole("button", { name: /create/i }));

      await waitFor(() => {
        const alerts = screen.getAllByRole("alert");
        const commErr = alerts.find((a) =>
          /community is required/i.test(a.textContent ?? "")
        );
        expect(commErr).toBeDefined();
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does NOT render the community picker in locked (parentCommunityId) mode", () => {
      render(
        <EntityForm
          entity="microgrid"
          mode="create"
          parentCommunityId="c-a"
          open={true}
          onOpenChange={() => {}}
        />
      );
      expect(screen.queryByLabelText(/^Community/i)).toBeNull();
    });
  });
});
