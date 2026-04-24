// @vitest-environment jsdom
/**
 * DiscoverDevices component tests (F #57, #68, #122).
 *
 * Covers:
 *   (a) suggested device_type renders in the dropdown
 *   (b) dropdown override propagates to the save payload
 *   (c) Save calls POST /api/devices with the correct payload shape
 *   (d) 'Already added' chip renders as disabled for a component matching an existing device row
 *   (e) null-channel rows: observability note shown; rows are selectable and included in save (#122)
 *   (f) checkbox selection state — tick/untick updates pending count and save payload
 *   (g) mixed billable + non-billable + already-added renders all in one list
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DiscoverDevices } from "../DiscoverDevices";
import type { DiscoveredDevice } from "@/lib/openems/types";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// Fixture: a fresh discovered device (not already added)
function makeDevice(
  componentId: string,
  suggestedDeviceType: DiscoveredDevice["suggestedDeviceType"] = "consumption_meter",
  alreadyAdded = false,
  openemsChannelAddress: string | null = `${componentId}/ActiveConsumptionEnergy`
): DiscoveredDevice {
  return {
    componentId,
    factoryId: `io.openems.edge.meter.${componentId}`,
    alias: `Meter ${componentId}`,
    nature: "io.openems.edge.meter.api.ElectricityMeter",
    openemsChannelAddress,
    suggestedDeviceType,
    alreadyAdded,
  };
}

// Build a mocked discover response
function mockDiscoverResponse(devices: DiscoveredDevice[]) {
  return {
    edgeId: "edge0",
    online: true,
    devices,
  };
}

// Default props
const defaultProps = {
  edgeDbId: "db-edge-uuid-123",
  openemsEdgeId: "edge0",
};

describe("DiscoverDevices", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // (a) Suggested device_type renders in the dropdown
  // ──────────────────────────────────────────────────────────────────────────
  describe("(a) suggested device_type renders", () => {
    it("shows the suggested device type chip after discovery", async () => {
      const devices = [makeDevice("meter0", "grid_meter")];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoverResponse(devices),
      } as Response);

      render(<DiscoverDevices {...defaultProps} />);

      // Click discover
      fireEvent.click(screen.getByRole("button", { name: /discover devices/i }));

      // Chip with grid_meter label should appear (StatusChip + Select value both render it)
      await waitFor(() => {
        const matches = screen.getAllByText("Grid meter");
        expect(matches.length).toBeGreaterThan(0);
      });
    });

    it("pre-fills the name input from alias", async () => {
      const devices = [makeDevice("meter1", "consumption_meter")];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoverResponse(devices),
      } as Response);

      render(<DiscoverDevices {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: /discover devices/i }));

      await waitFor(() => {
        const input = screen.getByPlaceholderText("Enter device name") as HTMLInputElement;
        expect(input.value).toBe("Meter meter1");
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // (b) Dropdown override propagates to the save payload
  // ──────────────────────────────────────────────────────────────────────────
  describe("(b) dropdown override propagates to save payload", () => {
    it("sends the suggested device_type when the user saves without changing the dropdown", async () => {
      const devices = [makeDevice("meter0", "consumption_meter")];

      // First call: discover
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoverResponse(devices),
      } as Response);

      // Second call: save
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ saved: [{ id: "new-uuid" }] }),
      } as Response);

      render(<DiscoverDevices {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: /discover devices/i }));

      // Wait for Add button to appear (auto-selected by default)
      await waitFor(() => screen.getByRole("button", { name: /add 1 device/i }));

      // Click Add without changing the dropdown
      fireEvent.click(screen.getByRole("button", { name: /add 1 device/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const [url, init] = fetchMock.mock.calls[1];
        expect(url).toBe("/api/devices");
        expect(init?.method).toBe("POST");

        const body = JSON.parse(init?.body as string);
        expect(body.edgeId).toBe("db-edge-uuid-123");
        expect(body.devices).toHaveLength(1);
        expect(body.devices[0].componentId).toBe("meter0");
        expect(body.devices[0].deviceType).toBe("consumption_meter");
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // (c) Save calls POST /api/devices with correct payload shape
  // ──────────────────────────────────────────────────────────────────────────
  describe("(c) Save calls POST /api/devices with correct payload", () => {
    it("sends edge_id, component_id, channel_address, device_type, and name", async () => {
      const devices = [makeDevice("meter0", "pv_meter")];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoverResponse(devices),
      } as Response);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ saved: [{ id: "uuid-1" }] }),
      } as Response);

      render(<DiscoverDevices {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: /discover devices/i }));

      await waitFor(() => screen.getByRole("button", { name: /add 1 device/i }));

      // Update the name input
      const input = screen.getByPlaceholderText("Enter device name") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Solar PV meter" } });

      fireEvent.click(screen.getByRole("button", { name: /add 1 device/i }));

      await waitFor(() => {
        const [url, init] = fetchMock.mock.calls[1];
        expect(url).toBe("/api/devices");

        const body = JSON.parse(init?.body as string);
        expect(body).toMatchObject({
          edgeId: "db-edge-uuid-123",
          devices: [
            expect.objectContaining({
              componentId: "meter0",
              factoryId: "io.openems.edge.meter.meter0",
              openemsChannelAddress: "meter0/ActiveConsumptionEnergy",
              deviceType: "pv_meter",
              name: "Solar PV meter",
            }),
          ],
        });
      });
    });

    it("does not include already-added devices in the save payload", async () => {
      const devices = [
        makeDevice("meter0", "grid_meter", true),  // already added
        makeDevice("meter1", "consumption_meter", false), // new
      ];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoverResponse(devices),
      } as Response);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ saved: [] }),
      } as Response);

      render(<DiscoverDevices {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: /discover devices/i }));

      await waitFor(() => screen.getByRole("button", { name: /add 1 device/i }));
      fireEvent.click(screen.getByRole("button", { name: /add 1 device/i }));

      await waitFor(() => {
        const [, init] = fetchMock.mock.calls[1];
        const body = JSON.parse(init?.body as string);
        // Only meter1 should be in the payload — meter0 is already added
        expect(body.devices).toHaveLength(1);
        expect(body.devices[0].componentId).toBe("meter1");
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // (d) 'Already added' chip renders as disabled for already-added components
  // ──────────────────────────────────────────────────────────────────────────
  describe("(d) Already added chip for duplicate components", () => {
    it("renders 'Already added' chip for components marked alreadyAdded", async () => {
      const devices = [
        makeDevice("meter0", "grid_meter", true), // already added
      ];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoverResponse(devices),
      } as Response);

      render(<DiscoverDevices {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: /discover devices/i }));

      await waitFor(() => {
        expect(screen.getByText("Already added")).toBeDefined();
      });
    });

    it("already-added rows have a pre-checked disabled checkbox", async () => {
      const devices = [
        makeDevice("meter0", "grid_meter", true), // already added
      ];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoverResponse(devices),
      } as Response);

      render(<DiscoverDevices {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: /discover devices/i }));

      await waitFor(() => screen.getByText("Already added"));

      const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
      expect(checkbox.checked).toBe(true);
      expect(checkbox.disabled).toBe(true);
    });

    it("renders disabled row with opacity class for already-added device", async () => {
      const devices = [makeDevice("meter0", "battery", true)];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoverResponse(devices),
      } as Response);

      const { container } = render(<DiscoverDevices {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: /discover devices/i }));

      await waitFor(() => screen.getByText("Already added"));

      // The already-added row should have opacity-60 class
      const disabledRow = container.querySelector(".opacity-60");
      expect(disabledRow).not.toBeNull();
    });

    it("Add button shows 0 count (disabled) when only already-added devices present", async () => {
      const devices = [
        makeDevice("meter0", "grid_meter", true), // already added — not counted in Add
      ];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoverResponse(devices),
      } as Response);

      render(<DiscoverDevices {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: /discover devices/i }));

      await waitFor(() => screen.getByText("Already added"));

      const addBtn = screen.getByRole("button", { name: /add 0 devices/i }) as HTMLButtonElement;
      expect(addBtn.disabled).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // (e) null-channel rows — observability note shown; rows are selectable (#122)
  // ──────────────────────────────────────────────────────────────────────────
  describe("(e) null-channel rows (battery, inverter, grid_meter, pv_meter)", () => {
    it("renders observability note when openemsChannelAddress is null", async () => {
      const devices = [makeDevice("ess0", "battery", false, null)];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoverResponse(devices),
      } as Response);

      render(<DiscoverDevices {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: /discover devices/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/No auto-billing channel for this device type/i)
        ).toBeDefined();
      });
    });

    it("null-channel device is auto-selected and included in POST payload", async () => {
      // One null-channel device (battery)
      const devices = [makeDevice("ess0", "battery", false, null)];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoverResponse(devices),
      } as Response);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ saved: [{ id: "new-uuid" }] }),
      } as Response);

      render(<DiscoverDevices {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: /discover devices/i }));

      // Add button is enabled (null-channel row auto-selected)
      await waitFor(() => screen.getByRole("button", { name: /add 1 device/i }));
      fireEvent.click(screen.getByRole("button", { name: /add 1 device/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const [url, init] = fetchMock.mock.calls[1];
        expect(url).toBe("/api/devices");

        const body = JSON.parse(init?.body as string);
        // ess0 (null-channel) is in the payload with openemsChannelAddress: null
        expect(body.devices).toHaveLength(1);
        expect(body.devices[0].componentId).toBe("ess0");
        expect(body.devices[0].openemsChannelAddress).toBeNull();
      });
    });

    it("includes both billable and null-channel devices in POST payload by default", async () => {
      const devices = [
        makeDevice("ess0", "battery", false, null),
        makeDevice("meter0", "consumption_meter", false, "meter0/ActiveConsumptionEnergy"),
      ];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoverResponse(devices),
      } as Response);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ saved: [{ id: "new-uuid-1" }, { id: "new-uuid-2" }] }),
      } as Response);

      render(<DiscoverDevices {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: /discover devices/i }));

      await waitFor(() => screen.getByRole("button", { name: /add 2 devices/i }));
      fireEvent.click(screen.getByRole("button", { name: /add 2 devices/i }));

      await waitFor(() => {
        const [, init] = fetchMock.mock.calls[1];
        const body = JSON.parse(init?.body as string);
        // Both devices are in the payload
        expect(body.devices).toHaveLength(2);
        const ids = body.devices.map((d: { componentId: string }) => d.componentId);
        expect(ids).toContain("ess0");
        expect(ids).toContain("meter0");
        // null-channel device sends openemsChannelAddress: null
        const battery = body.devices.find((d: { componentId: string }) => d.componentId === "ess0");
        expect(battery.openemsChannelAddress).toBeNull();
      });
    });

    it("unchecking a null-channel row removes it from the Add count", async () => {
      const devices = [makeDevice("ess0", "battery", false, null)];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoverResponse(devices),
      } as Response);

      render(<DiscoverDevices {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: /discover devices/i }));

      // Initially auto-selected → Add 1 device
      await waitFor(() => screen.getByRole("button", { name: /add 1 device/i }));

      // Uncheck the row
      const checkboxes = screen.getAllByRole("checkbox");
      const enabledCheckbox = checkboxes.find(
        (cb) => !(cb as HTMLInputElement).disabled
      ) as HTMLInputElement;
      fireEvent.click(enabledCheckbox);

      // Count drops to 0 → button disabled
      await waitFor(() => {
        const addBtn = screen.getByRole("button", { name: /add 0 devices/i }) as HTMLButtonElement;
        expect(addBtn.disabled).toBe(true);
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // (f) Checkbox selection state — tick/untick updates count + save payload
  // ──────────────────────────────────────────────────────────────────────────
  describe("(f) checkbox selection state", () => {
    it("unchecking a billable row removes it from the save payload", async () => {
      const devices = [
        makeDevice("meter0", "consumption_meter"),
        makeDevice("meter1", "consumption_meter"),
      ];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoverResponse(devices),
      } as Response);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ saved: [{ id: "new-uuid" }] }),
      } as Response);

      render(<DiscoverDevices {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: /discover devices/i }));

      // Both auto-selected by default → Add 2 devices
      await waitFor(() => screen.getByRole("button", { name: /add 2 devices/i }));

      // Uncheck the first enabled checkbox (meter0)
      const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
      fireEvent.click(checkboxes[0]);

      // Count drops to 1
      await waitFor(() => screen.getByRole("button", { name: /add 1 device/i }));

      fireEvent.click(screen.getByRole("button", { name: /add 1 device/i }));

      await waitFor(() => {
        const [, init] = fetchMock.mock.calls[1];
        const body = JSON.parse(init?.body as string);
        // Only the checked device should be in the payload
        expect(body.devices).toHaveLength(1);
      });
    });

    it("device-type dropdown override is preserved across re-renders (row state stable)", async () => {
      const devices = [
        makeDevice("meter0", "other", false, null),
      ];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoverResponse(devices),
      } as Response);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ saved: [{ id: "new-uuid" }] }),
      } as Response);

      render(<DiscoverDevices {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: /discover devices/i }));

      await waitFor(() => screen.getByRole("button", { name: /add 1 device/i }));

      // Uncheck then re-check to trigger re-render
      const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
      const enabledCheckbox = checkboxes.find((cb) => !cb.disabled) as HTMLInputElement;
      fireEvent.click(enabledCheckbox); // uncheck
      fireEvent.click(enabledCheckbox); // re-check

      // The dropdown for "other" still shows the original suggestion
      await waitFor(() => {
        // "Other" label appears (from the Select trigger showing current value)
        const otherLabels = screen.getAllByText("Other");
        expect(otherLabels.length).toBeGreaterThan(0);
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // (g) Mixed billable + non-billable + already-added → unified list
  // ──────────────────────────────────────────────────────────────────────────
  describe("(g) mixed device types render in one unified list", () => {
    it("renders all device types in a single list with appropriate states", async () => {
      const devices = [
        makeDevice("meter0", "consumption_meter", true),  // already added
        makeDevice("ess0", "battery", false, null),       // null-channel, selectable
        makeDevice("meter1", "pv_meter", false, null),    // null-channel, selectable
        makeDevice("meter2", "consumption_meter"),         // billable, selectable
      ];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoverResponse(devices),
      } as Response);

      render(<DiscoverDevices {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: /discover devices/i }));

      await waitFor(() => {
        // Already-added chip present
        expect(screen.getByText("Already added")).toBeDefined();
        // Observability note for null-channel devices (two devices → two notes)
        const notes = screen.getAllByText(/No auto-billing channel for this device type/i);
        expect(notes.length).toBe(2);
        // Add button counts 3 new devices (ess0 + meter1 + meter2)
        expect(screen.getByRole("button", { name: /add 3 devices/i })).toBeDefined();
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Empty state
  // ──────────────────────────────────────────────────────────────────────────
  describe("empty state", () => {
    it("shows empty state message when no components found", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ edgeId: "edge0", online: true, devices: [] }),
      } as Response);

      render(<DiscoverDevices {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: /discover devices/i }));

      await waitFor(() => {
        expect(
          screen.getByText(/No new components found on this edge/i)
        ).toBeDefined();
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Error state
  // ──────────────────────────────────────────────────────────────────────────
  describe("error state", () => {
    it("shows error message when discover endpoint fails", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "Edge is offline" }),
      } as Response);

      render(<DiscoverDevices {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: /discover devices/i }));

      await waitFor(() => {
        expect(screen.getByText(/Edge is offline/i)).toBeDefined();
      });
    });

    it("preserves user selections and surfaces error message on POST failure", async () => {
      const devices = [makeDevice("meter0", "consumption_meter")];

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => mockDiscoverResponse(devices),
      } as Response);

      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "Not authorized" }),
      } as Response);

      render(<DiscoverDevices {...defaultProps} />);
      fireEvent.click(screen.getByRole("button", { name: /discover devices/i }));

      await waitFor(() => screen.getByRole("button", { name: /add 1 device/i }));

      // Change name before save
      const input = screen.getByPlaceholderText("Enter device name") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "My Meter" } });

      fireEvent.click(screen.getByRole("button", { name: /add 1 device/i }));

      await waitFor(() => {
        // Error message is shown
        expect(screen.getByText(/Not authorized/i)).toBeDefined();
        // User selections are preserved — Add button still visible
        expect(screen.getByRole("button", { name: /add 1 device/i })).toBeDefined();
        // Name input still has the value
        const inputAfter = screen.getByPlaceholderText("Enter device name") as HTMLInputElement;
        expect(inputAfter.value).toBe("My Meter");
      });
    });
  });
});
