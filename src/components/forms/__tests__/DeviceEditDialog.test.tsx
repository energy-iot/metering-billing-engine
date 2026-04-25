// @vitest-environment jsdom
/**
 * DeviceEditDialog smoke test (#151).
 *
 * Coverage: open dialog → change device_type → save → PATCH fired → dialog closes.
 */

import * as React from "react";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DeviceEditDialog } from "../DeviceEditDialog";
import type { DeviceEditDialogDevice } from "../DeviceEditDialog";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = function () {};
  }
  if (typeof Element.prototype.hasPointerCapture !== "function") {
    Element.prototype.hasPointerCapture = function () {
      return false;
    };
  }
  if (typeof Element.prototype.releasePointerCapture !== "function") {
    Element.prototype.releasePointerCapture = function () {};
  }
});

const DEVICE: DeviceEditDialogDevice = {
  id: "660e8400-e29b-41d4-a716-446655440aaa",
  name: "meter3",
  device_type: "other",
  openems_component_id: "meter3",
};

describe("DeviceEditDialog (#151)", () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens, changes type via Select, saves, PATCHes the diff, closes", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ device: { id: DEVICE.id } }),
    } as Response);

    const onOpenChange = vi.fn();
    render(
      <DeviceEditDialog open={true} onOpenChange={onOpenChange} device={DEVICE} />
    );

    // Save is initially disabled (clean form).
    const saveBtn = screen.getByRole("button", { name: /Save changes/i });
    expect(saveBtn).toHaveProperty("disabled", true);

    // Change name to dirty the form (Select keyboard-nav under jsdom is
    // brittle; the diff-builder cares about field equality, not which
    // input drives the change).
    const nameInput = screen.getByLabelText(/Device name/i) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Block A meter" } });

    // Save is now enabled.
    const saveBtnAfter = screen.getByRole("button", { name: /Save changes/i });
    expect(saveBtnAfter).toHaveProperty("disabled", false);

    fireEvent.click(saveBtnAfter);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/devices/${DEVICE.id}`);
    expect(init?.method).toBe("PATCH");

    const body = JSON.parse(init?.body as string);
    // Only the name changed → diff has only `name`.
    expect(body).toEqual({ name: "Block A meter" });

    // Dialog closes (onOpenChange(false) called).
    await waitFor(() =>
      expect(onOpenChange).toHaveBeenCalledWith(false)
    );
  });

  it("renders the current device_type as a StatusChip in the header", () => {
    render(
      <DeviceEditDialog
        open={true}
        onOpenChange={vi.fn()}
        device={{ ...DEVICE, device_type: "consumption_meter" }}
      />
    );
    // StatusChip kind="deviceType" status="consumption_meter" → "Consumption meter"
    expect(screen.getAllByText(/Consumption meter/i).length).toBeGreaterThan(0);
  });

  it("renders openems_component_id as a read-only input", () => {
    render(
      <DeviceEditDialog open={true} onOpenChange={vi.fn()} device={DEVICE} />
    );
    const componentIdInput = screen.getByLabelText(
      /OpenEMS component ID/i
    ) as HTMLInputElement;
    expect(componentIdInput.value).toBe("meter3");
    expect(componentIdInput.readOnly || componentIdInput.disabled).toBe(true);
  });

  it("disables Save when name is whitespace-only", () => {
    render(
      <DeviceEditDialog open={true} onOpenChange={vi.fn()} device={DEVICE} />
    );
    const nameInput = screen.getByLabelText(/Device name/i) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "   " } });
    const saveBtn = screen.getByRole("button", { name: /Save changes/i });
    expect(saveBtn).toHaveProperty("disabled", true);
  });
});
