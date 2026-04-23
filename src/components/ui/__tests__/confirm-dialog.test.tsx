import { describe, it, expect, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
import { ConfirmDialog } from "../confirm-dialog";

// Radix Dialog requires a portal target in jsdom.
// @testing-library/react automatically appends to document.body, which works.

describe("ConfirmDialog", () => {
  it("(a) onConfirm resolves → onOpenChange(false) called exactly once", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();

    render(
      <ConfirmDialog
        open={true}
        onOpenChange={onOpenChange}
        title="Delete meter?"
        confirmLabel="Delete"
        tone="destructive"
        onConfirm={onConfirm}
      />
    );

    const confirmBtn = screen.getByRole("button", { name: "Delete" });
    await act(async () => {
      confirmBtn.click();
    });

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledTimes(1);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("(b) onConfirm rejects with Error('boom') → 'boom' in dialog + Retry button visible + onOpenChange NOT called", async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error("boom"));
    const onOpenChange = vi.fn();

    render(
      <ConfirmDialog
        open={true}
        onOpenChange={onOpenChange}
        title="Delete meter?"
        confirmLabel="Delete"
        tone="destructive"
        onConfirm={onConfirm}
      />
    );

    const confirmBtn = screen.getByRole("button", { name: "Delete" });
    await act(async () => {
      confirmBtn.click();
    });

    await waitFor(() => {
      expect(screen.getByText("boom")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
      expect(onOpenChange).not.toHaveBeenCalled();
    });
  });

  it("(c) on initial mount with open=true, document.activeElement matches Cancel button", async () => {
    render(
      <ConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Delete meter?"
        confirmLabel="Delete"
        tone="destructive"
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />
    );

    // Radix Dialog fires onOpenAutoFocus asynchronously after mount.
    await waitFor(() => {
      const cancelBtn = screen.getByRole("button", { name: "Cancel" });
      expect(document.activeElement).toBe(cancelBtn);
    });
  });
});
