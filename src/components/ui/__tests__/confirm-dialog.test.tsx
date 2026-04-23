import { describe, it, expect, vi } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
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

  // ── #89 entity-delete extensions ──────────────────────────────────────

  it("(d) requireTypedConfirmation: confirm is disabled until input matches expected, then enabled", async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);

    render(
      <ConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Delete organization?"
        description='Type "NFE" to confirm.'
        confirmLabel="Delete organization"
        tone="destructive"
        requireTypedConfirmation={{
          label: "Type organization name to confirm",
          expected: "NFE",
        }}
        onConfirm={onConfirm}
      />
    );

    const confirmBtn = screen.getByRole("button", {
      name: "Delete organization",
    }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    const input = screen.getByLabelText(
      "Type organization name to confirm"
    ) as HTMLInputElement;

    // Wrong value → still disabled.
    fireEvent.change(input, { target: { value: "nfe" } });
    expect(confirmBtn.disabled).toBe(true);

    // Matching (case-sensitive, trimmed) → enabled.
    fireEvent.change(input, { target: { value: "NFE" } });
    expect(confirmBtn.disabled).toBe(false);

    // Click confirm → onConfirm fires.
    await act(async () => {
      confirmBtn.click();
    });
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  });

  it("(e) requireTypedConfirmation present: focus lands on the input (not Cancel)", async () => {
    render(
      <ConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Delete organization?"
        confirmLabel="Delete"
        tone="destructive"
        requireTypedConfirmation={{
          label: "Type organization name to confirm",
          expected: "NFE",
        }}
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />
    );

    await waitFor(() => {
      const input = screen.getByLabelText("Type organization name to confirm");
      expect(document.activeElement).toBe(input);
    });
  });

  it("(f) Dialog.Content carries role='alertdialog'", () => {
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

    const alertDialog = screen.getByRole("alertdialog");
    expect(alertDialog).toBeTruthy();
  });

  it("(g) body prop: renders under description and is referenced by aria-describedby", () => {
    render(
      <ConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        title="Delete organization?"
        description="Permanent action."
        body={
          <ul>
            <li data-testid="body-item">1 community</li>
          </ul>
        }
        confirmLabel="Delete"
        tone="destructive"
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByTestId("body-item")).toBeTruthy();

    const alertDialog = screen.getByRole("alertdialog");
    const describedBy = alertDialog.getAttribute("aria-describedby");
    expect(describedBy).toContain("confirm-dialog-body");
    expect(describedBy).toContain("confirm-dialog-desc");
  });
});
