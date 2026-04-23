// SelectionDialog primitive tests (#103).
//
// Coverage:
//   (a) Renders title + body + footer when open=true.
//   (b) Does NOT render when open=false.
//   (c) role="dialog" (NOT alertdialog — selection is a task).
//   (d) aria-labelledby wired to title; aria-describedby includes body id.
//   (e) Unlocked: Esc fires onOpenChange(false).
//   (f) locked=true: Esc does NOT fire onOpenChange.
//   (g) Body region carries aria-live="polite".
//   (h) onOpenAutoFocus override honored.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { SelectionDialog } from "../selection-dialog";

afterEach(() => {
  cleanup();
});

describe("SelectionDialog", () => {
  it("(a) renders title, body, and footer when open", () => {
    render(
      <SelectionDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Add edges from OpenEMS"
        footer={<button>Cancel</button>}
      >
        <div>Body content</div>
      </SelectionDialog>,
    );

    expect(screen.getByText("Add edges from OpenEMS")).toBeTruthy();
    expect(screen.getByText("Body content")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("(b) renders nothing when open=false", () => {
    render(
      <SelectionDialog
        open={false}
        onOpenChange={vi.fn()}
        title="Add edges from OpenEMS"
        footer={<button>Cancel</button>}
      >
        <div data-testid="body">Body content</div>
      </SelectionDialog>,
    );
    expect(screen.queryByTestId("body")).toBeNull();
  });

  it("(c) uses role='dialog' (not 'alertdialog')", () => {
    render(
      <SelectionDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Add edges from OpenEMS"
        footer={<button>Cancel</button>}
      >
        <div>Body</div>
      </SelectionDialog>,
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("(d) aria-labelledby wired to title; aria-describedby includes body id", () => {
    render(
      <SelectionDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Add edges from OpenEMS"
        description="Choose one or more edges to register."
        footer={<button>Cancel</button>}
      >
        <div>Body</div>
      </SelectionDialog>,
    );

    const dialog = screen.getByRole("dialog");
    const labelledById = dialog.getAttribute("aria-labelledby");
    const describedByIds = dialog.getAttribute("aria-describedby") ?? "";

    expect(labelledById).toBeTruthy();
    expect(document.getElementById(labelledById!)?.textContent).toBe(
      "Add edges from OpenEMS",
    );
    expect(describedByIds).toContain("selection-dialog-body");
    expect(describedByIds).toContain("selection-dialog-desc");
  });

  it("(e) unlocked: Escape fires onOpenChange(false)", async () => {
    const onOpenChange = vi.fn();
    render(
      <SelectionDialog
        open={true}
        onOpenChange={onOpenChange}
        title="Add edges"
        footer={<button>Cancel</button>}
      >
        <div>Body</div>
      </SelectionDialog>,
    );

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("(f) locked=true: Escape does NOT fire onOpenChange", () => {
    const onOpenChange = vi.fn();
    render(
      <SelectionDialog
        open={true}
        onOpenChange={onOpenChange}
        title="Add edges"
        locked={true}
        footer={<button>Cancel</button>}
      >
        <div>Body</div>
      </SelectionDialog>,
    );

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("(g) body region carries aria-live='polite'", () => {
    render(
      <SelectionDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Add edges"
        footer={<button>Cancel</button>}
      >
        <div data-testid="inner">Body</div>
      </SelectionDialog>,
    );

    const inner = screen.getByTestId("inner");
    // The body wrapper owns the live region; walk up to find it.
    const liveRegion = inner.closest("[aria-live]");
    expect(liveRegion).not.toBeNull();
    expect(liveRegion?.getAttribute("aria-live")).toBe("polite");
  });

  it("(h) onOpenAutoFocus override is invoked on open", async () => {
    const handler = vi.fn((e: Event) => e.preventDefault());
    render(
      <SelectionDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Add edges"
        onOpenAutoFocus={handler}
        footer={<button>Cancel</button>}
      >
        <div>Body</div>
      </SelectionDialog>,
    );

    await waitFor(() => {
      expect(handler).toHaveBeenCalled();
    });
  });
});
