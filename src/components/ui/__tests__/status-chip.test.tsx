// StatusChip extensions — D2 / #53.
// Covers the new `edgeSource` and `deviceType` kinds added for the
// Microgrid Setup foundation.

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { StatusChip } from "../status-chip";

describe("StatusChip — edgeSource kind", () => {
  it("renders openems with brand background", () => {
    const { container } = render(
      <StatusChip kind="edgeSource" status="openems" />,
    );
    expect(container.querySelector("span")?.className).toContain("bg-accent");
  });

  it.each(["modbus_direct", "mqtt", "rest_api"] as const)(
    "renders %s with neutral background",
    (status) => {
      const { container } = render(
        <StatusChip kind="edgeSource" status={status} />,
      );
      expect(container.querySelector("span")?.className).toContain("bg-muted");
    },
  );

  it("renders a human-readable label for rest_api", () => {
    const { container } = render(
      <StatusChip kind="edgeSource" status="rest_api" />,
    );
    expect(container.textContent).toContain("REST API");
  });
});

describe("StatusChip — deviceType kind", () => {
  const CASES = [
    "consumption_meter",
    "grid_meter",
    "pv_meter",
    "battery",
    "inverter",
    "ev_charger",
    "other",
  ] as const;

  it.each(CASES)("renders chip for %s device type", (status) => {
    const { container } = render(<StatusChip kind="deviceType" status={status} />);
    const span = container.querySelector("span");
    expect(span).not.toBeNull();
    // Should have an aria-label referencing the device-type kind
    expect(span?.getAttribute("aria-label")).toContain("deviceType");
  });

  it("renders consumption_meter with warn background", () => {
    const { container } = render(
      <StatusChip kind="deviceType" status="consumption_meter" />,
    );
    expect(container.querySelector("span")?.className).toContain(
      "bg-warning-muted",
    );
  });

  it("renders grid_meter with brand background", () => {
    const { container } = render(
      <StatusChip kind="deviceType" status="grid_meter" />,
    );
    expect(container.querySelector("span")?.className).toContain("bg-accent");
  });

  it("renders pv_meter with success background", () => {
    const { container } = render(
      <StatusChip kind="deviceType" status="pv_meter" />,
    );
    expect(container.querySelector("span")?.className).toContain(
      "bg-success-muted",
    );
  });
});
