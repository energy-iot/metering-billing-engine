/**
 * manual-usage-cell.test.tsx (#227)
 *
 * Verifies that the editable input cell formats persisted values via
 * `toFixed(3)` instead of `String(value)`, so IEEE-754 dust never
 * surfaces in the input field. Covers (a) initial mount, (b) prop
 * re-sync, (c) revert paths (empty, escape), (d) commit (onChange ->
 * PATCH), and (e) the read-only branch is unaffected.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { ManualUsageCell } from "@/components/billing/manual-usage-cell";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const LI_ID = "li-227-test";

function passthroughFormat(v: number | null): string {
  if (v == null) return "—";
  return String(v);
}

describe("ManualUsageCell (#227 — formatForInput)", () => {
  beforeEach(() => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response("{}", { status: 200 })) as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders dust-bearing 178.3500000000002 as '178.350' in the input", () => {
    render(
      <ManualUsageCell
        lineItemId={LI_ID}
        field="usage_kwh"
        value={178.3500000000002}
        format={passthroughFormat}
        editable={true}
      />
    );
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(input.value).toBe("178.350");
  });

  it("renders a clean 15.117 unchanged (toFixed(3) is idempotent on 3-decimal input)", () => {
    render(
      <ManualUsageCell
        lineItemId={LI_ID}
        field="usage_kwh"
        value={15.117}
        format={passthroughFormat}
        editable={true}
      />
    );
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(input.value).toBe("15.117");
  });

  it("renders null as empty string", () => {
    render(
      <ManualUsageCell
        lineItemId={LI_ID}
        field="usage_kwh"
        value={null}
        format={passthroughFormat}
        editable={true}
      />
    );
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("renders trailing-zero padding for whole numbers (178 -> '178.000')", () => {
    render(
      <ManualUsageCell
        lineItemId={LI_ID}
        field="usage_kwh"
        value={178}
        format={passthroughFormat}
        editable={true}
      />
    );
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(input.value).toBe("178.000");
  });

  it("user typing passes through unchanged (onChange does not re-format)", () => {
    render(
      <ManualUsageCell
        lineItemId={LI_ID}
        field="usage_kwh"
        value={178.4}
        format={passthroughFormat}
        editable={true}
      />
    );
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(input.value).toBe("178.400");

    // Simulate user clearing + typing — the raw typing must persist
    // through onChange without re-formatting.
    fireEvent.change(input, { target: { value: "178.4" } });
    expect(input.value).toBe("178.4");
    fireEvent.change(input, { target: { value: "200" } });
    expect(input.value).toBe("200");
  });

  it("blur commits the typed value (parsed Number, not the toFixed(3) string)", async () => {
    render(
      <ManualUsageCell
        lineItemId={LI_ID}
        field="usage_kwh"
        value={178.4}
        format={passthroughFormat}
        editable={true}
      />
    );
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "200.5" } });
    fireEvent.blur(input);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/api/billing-line-items/${LI_ID}/usage`);
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ usage_kwh: 200.5 }));
  });

  it("empty blur reverts to formatted persisted value and does NOT fire PATCH", async () => {
    const onError = vi.fn();
    render(
      <ManualUsageCell
        lineItemId={LI_ID}
        field="usage_kwh"
        value={178.4}
        format={passthroughFormat}
        editable={true}
        onError={onError}
      />
    );
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    // Empty input: revert silently, no PATCH, onError clears.
    expect(global.fetch).not.toHaveBeenCalled();
    expect(input.value).toBe("178.400");
    expect(onError).toHaveBeenCalledWith(LI_ID, null);
  });

  it("Escape after edit reverts via formatForInput and does NOT fire PATCH", () => {
    render(
      <ManualUsageCell
        lineItemId={LI_ID}
        field="usage_kwh"
        value={178.3500000000002}
        format={passthroughFormat}
        editable={true}
      />
    );
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "999" } });
    expect(input.value).toBe("999");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("178.350");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("read-only branch (editable=false) renders the format() output, NOT the toFixed string", () => {
    const fmt = vi.fn(passthroughFormat);
    render(
      <ManualUsageCell
        lineItemId={LI_ID}
        field="usage_kwh"
        value={178.3500000000002}
        format={fmt}
        editable={false}
      />
    );
    // No spinbutton when read-only.
    expect(screen.queryByRole("spinbutton")).toBeNull();
    // The span renders the format() output of the persisted value.
    expect(fmt).toHaveBeenCalledWith(178.3500000000002);
  });

  it("prop re-sync: value changing from dust-bearing to clean updates the input to the new toFixed(3)", () => {
    const { rerender } = render(
      <ManualUsageCell
        lineItemId={LI_ID}
        field="usage_kwh"
        value={178.3500000000002}
        format={passthroughFormat}
        editable={true}
      />
    );
    let input = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(input.value).toBe("178.350");

    // Simulate a post-refresh prop change.
    rerender(
      <ManualUsageCell
        lineItemId={LI_ID}
        field="usage_kwh"
        value={178.4}
        format={passthroughFormat}
        editable={true}
      />
    );
    input = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(input.value).toBe("178.400");
  });
});
