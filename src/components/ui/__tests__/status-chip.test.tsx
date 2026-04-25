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

// #102 — OpenEMS Backend health chip (4 states).
describe("StatusChip — openemsBackendHealth kind", () => {
  it("renders 'healthy' with success background + dot", () => {
    const { container } = render(
      <StatusChip kind="openemsBackendHealth" status="healthy" />,
    );
    const chip = container.querySelector("span");
    expect(chip?.className).toContain("bg-success-muted");
    // Dot is a first child span with bg-success (per Chip.tsx dotByTone).
    expect(chip?.querySelector("span")?.className).toContain("bg-success");
    expect(container.textContent).toContain("Healthy");
  });

  it("renders 'stale' with warn background + dot", () => {
    const { container } = render(
      <StatusChip kind="openemsBackendHealth" status="stale" />,
    );
    const chip = container.querySelector("span");
    expect(chip?.className).toContain("bg-warning-muted");
    expect(chip?.querySelector("span")?.className).toContain("bg-warning");
    expect(container.textContent).toContain("Stale");
  });

  it("renders 'failing' with alert background + dot", () => {
    const { container } = render(
      <StatusChip kind="openemsBackendHealth" status="failing" />,
    );
    const chip = container.querySelector("span");
    expect(chip?.className).toContain("bg-destructive-muted");
    expect(chip?.querySelector("span")?.className).toContain("bg-destructive");
    expect(container.textContent).toContain("Failing");
  });

  it("renders 'not_configured' with neutral background + NO dot", () => {
    const { container } = render(
      <StatusChip kind="openemsBackendHealth" status="not_configured" />,
    );
    const chip = container.querySelector("span");
    expect(chip?.className).toContain("bg-muted");
    // No dot child → first child text node is the label, not a dot span.
    // Asserting no span descendant with a bg-* dot class:
    const dot = chip?.querySelector(
      "span.bg-success, span.bg-warning, span.bg-destructive, span.bg-muted-foreground",
    );
    expect(dot).toBeNull();
    expect(container.textContent).toContain("Not connected");
  });

  it("wraps the chip in a focusable tooltip trigger when `tooltip` is set", () => {
    const { container } = render(
      <StatusChip
        kind="openemsBackendHealth"
        status="healthy"
        tooltip="Last successful discovery: 2h ago"
      />,
    );
    // The outer wrapper span is tabIndex=0 (keyboard-focusable).
    const wrapper = container.querySelector("span[tabindex='0']");
    expect(wrapper).not.toBeNull();
    // Chip is inside the wrapper.
    const chip = wrapper?.querySelector("span");
    expect(chip?.className).toContain("bg-success-muted");
  });
});

// #124 — Billing line item payment status chip (4 states).
describe("StatusChip — billingLineItemPaymentStatus kind", () => {
  it("renders 'unpaid' with neutral background + NO dot", () => {
    const { container } = render(
      <StatusChip kind="billingLineItemPaymentStatus" status="unpaid" />,
    );
    const chip = container.querySelector("span");
    expect(chip?.className).toContain("bg-muted");
    const dot = chip?.querySelector(
      "span.bg-success, span.bg-warning, span.bg-destructive, span.bg-muted-foreground",
    );
    expect(dot).toBeNull();
    expect(container.textContent).toContain("Unpaid");
  });

  it("renders 'paid' with success background + dot", () => {
    const { container } = render(
      <StatusChip kind="billingLineItemPaymentStatus" status="paid" />,
    );
    const chip = container.querySelector("span");
    expect(chip?.className).toContain("bg-success-muted");
    expect(chip?.querySelector("span")?.className).toContain("bg-success");
    expect(container.textContent).toContain("Paid");
  });

  it("renders 'failed' with alert background + dot", () => {
    const { container } = render(
      <StatusChip kind="billingLineItemPaymentStatus" status="failed" />,
    );
    const chip = container.querySelector("span");
    expect(chip?.className).toContain("bg-destructive-muted");
    expect(chip?.querySelector("span")?.className).toContain("bg-destructive");
    expect(container.textContent).toContain("Failed");
  });

  it("renders 'refunded' with neutral background + NO dot", () => {
    const { container } = render(
      <StatusChip kind="billingLineItemPaymentStatus" status="refunded" />,
    );
    const chip = container.querySelector("span");
    expect(chip?.className).toContain("bg-muted");
    const dot = chip?.querySelector(
      "span.bg-success, span.bg-warning, span.bg-destructive, span.bg-muted-foreground",
    );
    expect(dot).toBeNull();
    expect(container.textContent).toContain("Refunded");
  });

  // Phase B (#157) — link_generated state.
  it("renders 'link_generated' with warn background + dot (Phase B)", () => {
    const { container } = render(
      <StatusChip kind="billingLineItemPaymentStatus" status="link_generated" />,
    );
    const chip = container.querySelector("span");
    expect(chip?.className).toContain("bg-warning-muted");
    expect(chip?.querySelector("span")?.className).toContain("bg-warning");
    expect(container.textContent).toContain("Link sent");
  });
});

// #119 — Community Payment-provider health chip (4 states).
describe("StatusChip — paymentHealth kind", () => {
  it("renders 'healthy' with success background + dot", () => {
    const { container } = render(
      <StatusChip kind="paymentHealth" status="healthy" />,
    );
    const chip = container.querySelector("span");
    expect(chip?.className).toContain("bg-success-muted");
    expect(chip?.querySelector("span")?.className).toContain("bg-success");
    expect(container.textContent).toContain("Healthy");
  });

  it("renders 'stale' with warn background + dot", () => {
    const { container } = render(
      <StatusChip kind="paymentHealth" status="stale" />,
    );
    const chip = container.querySelector("span");
    expect(chip?.className).toContain("bg-warning-muted");
    expect(chip?.querySelector("span")?.className).toContain("bg-warning");
    expect(container.textContent).toContain("Stale");
  });

  it("renders 'failing' with alert background + dot (Phase B — emitted on recent IPN failure)", () => {
    const { container } = render(
      <StatusChip kind="paymentHealth" status="failing" />,
    );
    const chip = container.querySelector("span");
    expect(chip?.className).toContain("bg-destructive-muted");
    expect(chip?.querySelector("span")?.className).toContain("bg-destructive");
    expect(container.textContent).toContain("Failing");
  });

  it("renders 'not_configured' with neutral background + NO dot", () => {
    const { container } = render(
      <StatusChip kind="paymentHealth" status="not_configured" />,
    );
    const chip = container.querySelector("span");
    expect(chip?.className).toContain("bg-muted");
    const dot = chip?.querySelector(
      "span.bg-success, span.bg-warning, span.bg-destructive, span.bg-muted-foreground",
    );
    expect(dot).toBeNull();
    expect(container.textContent).toContain("Not connected");
  });
});
