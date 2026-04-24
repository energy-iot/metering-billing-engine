// @vitest-environment jsdom
/**
 * AddEntityButton tests (#132).
 *
 * Covers:
 *   - community locked mode: button renders; EntityForm receives parentOrgId.
 *   - community picker mode: button renders; EntityForm receives availableOrgs.
 *   - microgrid locked mode: button renders; EntityForm receives parentCommunityId.
 *   - microgrid picker mode: button renders; EntityForm receives availableCommunities.
 *   - organization: button renders (no parent).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { AddEntityButton } from "../AddEntityButton";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

afterEach(() => {
  cleanup();
});

describe("AddEntityButton", () => {
  describe("entity=organization", () => {
    it("renders the Add Organization button", () => {
      render(<AddEntityButton entity="organization" />);
      expect(screen.getByRole("button", { name: /\+ Add Organization/i })).toBeTruthy();
    });
  });

  describe("entity=community — locked mode (single parentOrgId)", () => {
    it("renders the Add Community button", () => {
      render(<AddEntityButton entity="community" parentOrgId="org-1" />);
      expect(screen.getByRole("button", { name: /\+ Add Community/i })).toBeTruthy();
    });

    it("clicking opens the form dialog", async () => {
      render(<AddEntityButton entity="community" parentOrgId="org-1" />);
      fireEvent.click(screen.getByRole("button", { name: /\+ Add Community/i }));
      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeTruthy();
      });
      // Should NOT render the org picker in locked mode.
      expect(screen.queryByLabelText(/^Organization/i)).toBeNull();
    });
  });

  describe("entity=community — picker mode (availableOrgs)", () => {
    const orgs = [
      { id: "org-a", name: "Alpha Energy" },
      { id: "org-b", name: "Beta Power" },
    ];

    it("renders the Add Community button", () => {
      render(<AddEntityButton entity="community" availableOrgs={orgs} />);
      expect(screen.getByRole("button", { name: /\+ Add Community/i })).toBeTruthy();
    });

    it("clicking opens the form with an Organization picker", async () => {
      render(<AddEntityButton entity="community" availableOrgs={orgs} />);
      fireEvent.click(screen.getByRole("button", { name: /\+ Add Community/i }));
      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeTruthy();
        expect(screen.getByLabelText(/^Organization/i)).toBeTruthy();
      });
    });

    it("supports a custom label", () => {
      render(
        <AddEntityButton
          entity="community"
          availableOrgs={orgs}
          label="+ Add the first Community"
        />
      );
      expect(screen.getByRole("button", { name: /Add the first Community/i })).toBeTruthy();
    });
  });

  describe("entity=microgrid — locked mode (single parentCommunityId)", () => {
    it("renders the Add Microgrid button", () => {
      render(<AddEntityButton entity="microgrid" parentCommunityId="c-1" />);
      expect(screen.getByRole("button", { name: /\+ Add Microgrid/i })).toBeTruthy();
    });

    it("clicking opens the form dialog without community picker", async () => {
      render(<AddEntityButton entity="microgrid" parentCommunityId="c-1" />);
      fireEvent.click(screen.getByRole("button", { name: /\+ Add Microgrid/i }));
      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeTruthy();
      });
      // Should NOT render the community picker in locked mode.
      expect(screen.queryByLabelText(/^Community/i)).toBeNull();
    });
  });

  describe("entity=microgrid — picker mode (availableCommunities)", () => {
    const communities = [
      { id: "c-a", name: "Kisakye", org_name: "EnergyIoT Uganda" },
      { id: "c-b", name: "Gulu", org_name: "EnergyIoT Uganda" },
    ];

    it("renders the Add Microgrid button", () => {
      render(
        <AddEntityButton entity="microgrid" availableCommunities={communities} />
      );
      expect(screen.getByRole("button", { name: /\+ Add Microgrid/i })).toBeTruthy();
    });

    it("clicking opens the form with a Community picker", async () => {
      render(
        <AddEntityButton entity="microgrid" availableCommunities={communities} />
      );
      fireEvent.click(screen.getByRole("button", { name: /\+ Add Microgrid/i }));
      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeTruthy();
        expect(screen.getByLabelText(/^Community/i)).toBeTruthy();
      });
    });
  });
});
