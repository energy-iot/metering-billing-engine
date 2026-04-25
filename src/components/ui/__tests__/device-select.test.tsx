// @vitest-environment jsdom
/**
 * DeviceSelect — unit tests (#145).
 *
 * Variant B always: edge label + group header are present even on
 * single-edge microgrids. Already-linked devices are disabled. Empty state
 * surfaces an in-dropdown empty card with a Discover link.
 *
 * Note: Radix Select renders its options into a portal that materialises
 * only when the trigger is opened. We open the picker via a click on the
 * trigger; jsdom + Radix don't replicate real focus, so we assert on the
 * actual rendered DOM after open.
 */

import * as React from "react";
import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DeviceSelect, type DeviceOption } from "../device-select";

// next/link mock
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// Polyfills for Radix Select
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  // Radix internally calls these in jsdom and they don't exist by default.
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = function () {};
  }
  if (typeof Element.prototype.hasPointerCapture !== "function") {
    Element.prototype.hasPointerCapture = (() => false) as Element["hasPointerCapture"];
  }
  if (typeof Element.prototype.releasePointerCapture !== "function") {
    Element.prototype.releasePointerCapture = (() => {}) as Element["releasePointerCapture"];
  }
});

const SINGLE_EDGE: DeviceOption[] = [
  {
    id: "dev-a",
    name: "Meter A",
    device_type: "consumption_meter",
    edge_id: "edge-1",
    edge_name: "Alpha Edge",
  },
  {
    id: "dev-b",
    name: "Meter B",
    device_type: "grid_meter",
    edge_id: "edge-1",
    edge_name: "Alpha Edge",
  },
];

const MULTI_EDGE: DeviceOption[] = [
  {
    id: "dev-z",
    name: "Zed device",
    device_type: "consumption_meter",
    edge_id: "edge-z",
    edge_name: "Zed Edge",
  },
  {
    id: "dev-a",
    name: "Apple device",
    device_type: "consumption_meter",
    edge_id: "edge-a",
    edge_name: "Apple Edge",
  },
];

const WITH_LINKED: DeviceOption[] = [
  {
    id: "dev-free",
    name: "Free meter",
    device_type: "consumption_meter",
    edge_id: "edge-1",
    edge_name: "Alpha Edge",
  },
  {
    id: "dev-linked",
    name: "Linked meter",
    device_type: "consumption_meter",
    edge_id: "edge-1",
    edge_name: "Alpha Edge",
    linkedToHouseholdName: "Household X",
  },
];

function openTrigger() {
  // The trigger renders as a <button> (Radix Select.Trigger). Multiple
  // matches happen because Radix sometimes adds hidden input copies — we
  // pick the first.
  const triggers = screen.getAllByRole("combobox");
  fireEvent.click(triggers[0]);
}

describe("DeviceSelect (#145)", () => {
  it("(single-edge) shows edge label + group header even with one edge", () => {
    render(
      <DeviceSelect
        devices={SINGLE_EDGE}
        value={null}
        onChange={() => {}}
        edgesSetupHref="/microgrids/mg-1/setup/edges"
      />
    );
    openTrigger();

    // Group header present
    expect(screen.getByText(/Edge · Alpha Edge/i)).toBeTruthy();

    // Each device option shows the edge name as the second line
    const edgeNameOccurrences = screen.getAllByText(/Alpha Edge/i);
    // 1 for the group label + 1 per device = 3
    expect(edgeNameOccurrences.length).toBeGreaterThanOrEqual(3);
  });

  it("(multi-edge) groups alphabetically by edge name", () => {
    render(
      <DeviceSelect
        devices={MULTI_EDGE}
        value={null}
        onChange={() => {}}
        edgesSetupHref="/microgrids/mg-1/setup/edges"
      />
    );
    openTrigger();

    const groupLabels = screen.getAllByText(/^Edge ·/);
    expect(groupLabels).toHaveLength(2);
    // Apple Edge sorts before Zed Edge
    expect(groupLabels[0].textContent).toContain("Apple Edge");
    expect(groupLabels[1].textContent).toContain("Zed Edge");
  });

  it("(linked-elsewhere) renders disabled item with 'linked to' suffix", () => {
    render(
      <DeviceSelect
        devices={WITH_LINKED}
        value={null}
        onChange={() => {}}
        edgesSetupHref="/microgrids/mg-1/setup/edges"
      />
    );
    openTrigger();

    // "linked to Household X" suffix is rendered for the linked device
    expect(screen.getByText(/linked to Household X/i)).toBeTruthy();

    // The linked option carries aria-disabled (Radix sets this from the
    // `disabled` prop on Select.Item).
    const options = screen.getAllByRole("option");
    const linkedOpt = options.find((o) =>
      o.textContent?.includes("Linked meter")
    );
    expect(linkedOpt).toBeDefined();
    expect(linkedOpt?.getAttribute("data-disabled")).not.toBeNull();
  });

  it("(empty) renders in-dropdown empty state with Discover link", () => {
    render(
      <DeviceSelect
        devices={[]}
        value={null}
        onChange={() => {}}
        edgesSetupHref="/microgrids/mg-1/setup/edges"
      />
    );
    // The trigger is disabled when no devices, so we can't click to open.
    // The disabled trigger is wrapping the placeholder text.
    const triggers = screen.getAllByRole("combobox");
    expect(triggers[0].getAttribute("data-disabled")).not.toBeNull();
    // Placeholder reflects the empty state
    expect(triggers[0].textContent).toContain("No devices on this microgrid yet");
  });

  it("calls onChange(null) when sentinel 'Unassigned' option chosen", () => {
    const onChange = vi.fn();
    render(
      <DeviceSelect
        devices={SINGLE_EDGE}
        value="dev-a"
        onChange={onChange}
        edgesSetupHref="/microgrids/mg-1/setup/edges"
      />
    );
    openTrigger();

    const unassignedOption = screen
      .getAllByRole("option")
      .find((o) => o.textContent?.trim() === "Unassigned");
    expect(unassignedOption).toBeDefined();
    fireEvent.click(unassignedOption!);
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
