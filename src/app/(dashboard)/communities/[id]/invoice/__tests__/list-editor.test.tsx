// @vitest-environment jsdom
/**
 * ListEditor — integration tests (#204 / PDF2 AC-7).
 *
 * Verifies:
 *   - Add row appends a new row built by `emptyRow()`.
 *   - Remove row deletes by index.
 *   - Up/Down reorder preserves data (no clobber).
 *   - Max-rows guard prevents adding beyond the limit.
 *   - Empty-state CTA shows when rows.length === 0.
 */

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { ListEditor } from "../list-editor";

function makeStringEditor(rows: string[], onChange: (next: string[]) => void) {
  return (
    <ListEditor<string>
      rows={rows}
      onChange={onChange}
      renderRow={(row, _i, update) => (
        <input
          aria-label="row"
          value={row}
          onChange={(e) => update(e.target.value)}
        />
      )}
      emptyRow={() => ""}
      maxRows={3}
      addLabel="Add row"
    />
  );
}

describe("ListEditor", () => {
  it("renders empty-state CTA when rows is empty", () => {
    const onChange = vi.fn();
    render(makeStringEditor([], onChange));
    const cta = screen.getByRole("button", { name: /add row/i });
    expect(cta).toBeDefined();
  });

  it("Add appends a new row built by emptyRow()", () => {
    const onChange = vi.fn();
    render(makeStringEditor(["a", "b"], onChange));
    fireEvent.click(screen.getByRole("button", { name: /add row/i }));
    expect(onChange).toHaveBeenCalledWith(["a", "b", ""]);
  });

  it("Remove deletes by index", () => {
    const onChange = vi.fn();
    render(makeStringEditor(["a", "b", "c"], onChange));
    const removeButtons = screen.getAllByRole("button", {
      name: /remove row/i,
    });
    fireEvent.click(removeButtons[1]); // Remove "b".
    expect(onChange).toHaveBeenCalledWith(["a", "c"]);
  });

  it("Up reorder preserves data", () => {
    const onChange = vi.fn();
    render(makeStringEditor(["a", "b", "c"], onChange));
    const upButtons = screen.getAllByRole("button", { name: /move row \d+ up/i });
    fireEvent.click(upButtons[1]); // Move "b" up.
    expect(onChange).toHaveBeenCalledWith(["b", "a", "c"]);
  });

  it("Down reorder preserves data", () => {
    const onChange = vi.fn();
    render(makeStringEditor(["a", "b", "c"], onChange));
    const downButtons = screen.getAllByRole("button", {
      name: /move row \d+ down/i,
    });
    fireEvent.click(downButtons[0]); // Move "a" down.
    expect(onChange).toHaveBeenCalledWith(["b", "a", "c"]);
  });

  it("max-rows guard disables Add at the limit", () => {
    const onChange = vi.fn();
    render(makeStringEditor(["a", "b", "c"], onChange));
    const addButton = screen.getByRole("button", { name: /add row/i });
    expect(addButton.hasAttribute("disabled")).toBe(true);
  });

  it("Up at row 0 is disabled (boundary)", () => {
    const onChange = vi.fn();
    render(makeStringEditor(["a", "b"], onChange));
    const upButtons = screen.getAllByRole("button", { name: /move row \d+ up/i });
    expect(upButtons[0].hasAttribute("disabled")).toBe(true);
  });

  it("Down at last row is disabled (boundary)", () => {
    const onChange = vi.fn();
    render(makeStringEditor(["a", "b"], onChange));
    const downButtons = screen.getAllByRole("button", {
      name: /move row \d+ down/i,
    });
    expect(downButtons[downButtons.length - 1].hasAttribute("disabled")).toBe(
      true,
    );
  });
});
