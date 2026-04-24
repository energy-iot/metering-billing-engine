// CopyTable — component tests (jsdom environment)
//
// Covers:
//   - ActionColumnDef variant: render(row) content appears in the cell
//   - Action column excluded from keyboard nav (no focus ring / copy-pulse styling)
//   - Action cell has no aria-label, no copy-pulse class
//   - Existing value columns still work

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CopyTable, type ColumnDef } from "../copy-table";

// Mock clipboard
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  writable: true,
  configurable: true,
});

type Row = { name: string; amount: number; id: string };

const rows: Row[] = [
  { name: "Alice", amount: 100, id: "a" },
  { name: "Bob",   amount: 200, id: "b" },
];

const columnsWithAction: ColumnDef<Row>[] = [
  { kind: "row-header", header: "Household", accessor: (r) => r.name },
  { kind: "value",      header: "Amount",    accessor: (r) => r.amount },
  {
    kind: "action",
    header: "Payment",
    render: (r) => <button data-testid={`pay-${r.id}`}>Pay {r.name}</button>,
  },
];

describe("CopyTable — ActionColumnDef", () => {
  it("renders action column header", () => {
    render(
      <CopyTable
        rows={rows}
        columns={columnsWithAction}
        caption="Test table"
      />
    );
    // Column header "Payment" should be present
    const headers = screen.getAllByRole("columnheader");
    const paymentHeader = headers.find((h) => h.textContent === "Payment");
    expect(paymentHeader).not.toBeUndefined();
  });

  it("renders action cell content via render(row) for each row", () => {
    render(
      <CopyTable
        rows={rows}
        columns={columnsWithAction}
        caption="Test table"
      />
    );
    // Each row gets the action button
    expect(screen.getByTestId("pay-a")).toBeTruthy();
    expect(screen.getByTestId("pay-b")).toBeTruthy();
  });

  it("action cell has no aria-label (only value cells get aria-label)", () => {
    const { container } = render(
      <CopyTable
        rows={rows}
        columns={columnsWithAction}
        caption="Test table"
      />
    );
    // Find all <td> elements in tbody — action cell should NOT have aria-label
    const tbody = container.querySelector("tbody");
    const tds = Array.from(tbody?.querySelectorAll("td") ?? []);

    // The action td contains the pay button, not an aria-label on the td itself
    const actionTds = tds.filter((td) => td.querySelector("[data-testid^='pay-']"));
    actionTds.forEach((td) => {
      expect(td.getAttribute("aria-label")).toBeNull();
    });
  });

  it("action cell has no copy-pulse styling (bg-success-muted absent on action cells)", () => {
    const { container } = render(
      <CopyTable
        rows={rows}
        columns={columnsWithAction}
        caption="Test table"
      />
    );
    const tbody = container.querySelector("tbody");
    const tds = Array.from(tbody?.querySelectorAll("td") ?? []);

    // Action cells should not have cursor-pointer (that's only on value cells)
    const actionTds = tds.filter((td) => td.querySelector("[data-testid^='pay-']"));
    actionTds.forEach((td) => {
      expect(td.className).not.toContain("cursor-pointer");
      expect(td.className).not.toContain("bg-success-muted");
    });
  });

  it("clicking action cell content does not trigger copy nav (value focus unchanged)", () => {
    const onCopy = vi.fn();
    render(
      <CopyTable
        rows={rows}
        columns={columnsWithAction}
        caption="Test table"
        onCopy={onCopy}
      />
    );

    // Click the action button — should NOT trigger onCopy
    fireEvent.click(screen.getByTestId("pay-a"));
    expect(onCopy).not.toHaveBeenCalled();
  });

  it("existing value columns still work (clicking value cell triggers copy)", () => {
    const onCopy = vi.fn();
    const { container } = render(
      <CopyTable
        rows={rows}
        columns={columnsWithAction}
        caption="Test table"
        onCopy={onCopy}
      />
    );

    // Click a value cell (Amount for Alice = 100)
    const valueCell = container.querySelector("td[aria-label*='Amount']");
    expect(valueCell).not.toBeNull();
    fireEvent.click(valueCell!);
    expect(onCopy).toHaveBeenCalledOnce();
    expect(onCopy).toHaveBeenCalledWith("100", expect.anything(), expect.anything());
  });

  it("valueColIdxs excludes action column (Tab stays in value columns only)", () => {
    const { container } = render(
      <CopyTable
        rows={rows}
        columns={columnsWithAction}
        caption="Test table"
      />
    );

    // Focus the wrapper (the tabIndex=0 div)
    const wrapper = container.querySelector("[tabindex='0']") as HTMLElement | null;
    expect(wrapper).not.toBeNull();
    wrapper!.focus();

    // Tab through all value cells — we only have 1 value column × 2 rows = 2 cells
    // After 2 Tabs we should get "End of table" announced, not jump to action column
    const liveRegion = container.querySelector("[aria-live='polite']");

    // Tab forward past last row → should announce "End of table"
    fireEvent.keyDown(wrapper!, { key: "Tab" });
    fireEvent.keyDown(wrapper!, { key: "Tab" });
    // End of table announcement means the tab did NOT land on the action column
    expect(liveRegion?.textContent).toContain("End of table");
  });
});
