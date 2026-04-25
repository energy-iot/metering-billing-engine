// ClosePeriodDialog unit tests
//
// Pin the post-collapse contract:
//   - Single open surface: totals + checkbox + "Close period" button visible
//     immediately on open. Button starts disabled.
//   - Checkbox tick toggles button enable.
//   - Click confirm dispatches onConfirm exactly once with no preceding screen.
//   - Pending state shows "Closing…" footer + disabled button.
//   - Success state renders green "Closed: <periodLabel>" header + CSV CTA.
//   - Error state renders destructive banner + "Retry close" that re-invokes.
//   - Re-open after error resets state (checkbox unchecked, banner gone, button
//     back to disabled "Close period").
//   - Cancel-first focus order on open.

import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LocaleProvider } from "../format/locale-context";
import { ClosePeriodDialog, type ClosePeriodSummaryRow } from "../ui/close-period-dialog";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SUMMARY_ROWS: ClosePeriodSummaryRow[] = [
  { label: "Households", value: "12" },
  { label: "Total kWh", value: "487.3" },
  { label: "Tier 1 kWh", value: "392.1" },
  { label: "Tier 2 kWh", value: "95.2" },
];
const GRAND_TOTAL = 4_216_800;
const PERIOD_LABEL = "April 2026";

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <LocaleProvider locale="en-UG" currency="UGX">
      {children}
    </LocaleProvider>
  );
}

/**
 * A controlled wrapper around ClosePeriodDialog so tests can flip `open`
 * (closed → open) to exercise the reset-on-open useEffect, and so they can
 * provide an `onConfirm` whose resolution timing is controlled per-test.
 */
function ControlledHarness(props: {
  initialOpen?: boolean;
  onConfirm: () => Promise<void>;
  onExportCsv?: () => void;
}) {
  const [open, setOpen] = React.useState(props.initialOpen ?? true);
  return (
    <Wrapper>
      <button onClick={() => setOpen(true)} data-testid="harness-reopen">
        reopen
      </button>
      <button onClick={() => setOpen(false)} data-testid="harness-close">
        close
      </button>
      <ClosePeriodDialog
        open={open}
        onOpenChange={setOpen}
        periodLabel={PERIOD_LABEL}
        summaryRows={SUMMARY_ROWS}
        grandTotal={GRAND_TOTAL}
        onConfirm={props.onConfirm}
        onExportCsv={props.onExportCsv}
      />
    </Wrapper>
  );
}

// Helper: a deferred promise — caller controls when it resolves/rejects.
function defer<T = void>() {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ClosePeriodDialog — collapsed surface", () => {
  it("on open, totals + grand total + checkbox + disabled 'Close period' are all visible", () => {
    render(<ControlledHarness onConfirm={() => Promise.resolve()} />);

    // Totals grid: every label and value renders.
    for (const row of SUMMARY_ROWS) {
      expect(screen.getByText(row.label)).toBeTruthy();
      expect(screen.getByText(String(row.value))).toBeTruthy();
    }
    // Grand total label.
    expect(screen.getByText("Grand total")).toBeTruthy();

    // Checkbox visible.
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeTruthy();
    expect((checkbox as HTMLInputElement).checked).toBe(false);

    // The confirm CTA renders as "Close period" (no ellipsis, no "Review &").
    const closeBtn = screen.getByRole("button", { name: /^Close period$/ });
    expect(closeBtn).toBeTruthy();
    expect((closeBtn as HTMLButtonElement).disabled).toBe(true);

    // No phase-1 ceremony: there is NO "Review & close…" trigger.
    expect(screen.queryByRole("button", { name: /Review/i })).toBeNull();

    // Eyebrow shows the new "Final review" copy in primary tone.
    const eyebrow = screen.getByText("Final review");
    expect(eyebrow).toBeTruthy();
    expect(eyebrow.className).toContain("text-primary");
  });

  it("ticking the checkbox enables the button; unticking re-disables", () => {
    render(<ControlledHarness onConfirm={() => Promise.resolve()} />);
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    const closeBtn = screen.getByRole("button", { name: /^Close period$/ }) as HTMLButtonElement;

    expect(closeBtn.disabled).toBe(true);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);
    expect(closeBtn.disabled).toBe(false);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
    expect(closeBtn.disabled).toBe(true);
  });

  it("clicking 'Close period' invokes onConfirm exactly once with no arguments", async () => {
    const onConfirm = vi.fn(() => Promise.resolve());
    render(<ControlledHarness onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /^Close period$/ }));

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
    expect(onConfirm.mock.calls[0]).toEqual([]);
  });

  it("rail and confirm button render in primary tone (token-class drift sanity)", () => {
    const { container } = render(<ControlledHarness onConfirm={() => Promise.resolve()} />);

    // Rail: aria-hidden div with bg-primary; not bg-destructive.
    const rail = container.ownerDocument.querySelector('[aria-hidden="true"].bg-primary');
    expect(rail).not.toBeNull();
    expect(container.ownerDocument.querySelector('[aria-hidden="true"].bg-destructive')).toBeNull();

    // Confirm button: bg-primary tokens (pre-click; not destructive).
    const closeBtn = screen.getByRole("button", { name: /^Close period$/ });
    expect(closeBtn.className).toContain("bg-primary");
    expect(closeBtn.className).toContain("text-primary-foreground");
    expect(closeBtn.className).not.toContain("bg-destructive");

    // Checkbox accent uses --primary, not --destructive.
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.className).toContain("accent-[color:var(--primary)]");
    expect(checkbox.className).not.toContain("accent-[color:var(--destructive)]");
  });
});

describe("ClosePeriodDialog — pending / success / error states", () => {
  it("pending: while onConfirm is in-flight, shows 'Closing…' and disables the button", async () => {
    const d = defer<void>();
    const onConfirm = vi.fn(() => d.promise);
    render(<ControlledHarness onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /^Close period$/ }));

    // Pending state: footer copy + button label "Closing…"
    await waitFor(() => {
      // Multiple "Closing…" matches possible (footer + button) — both indicate pending.
      expect(screen.getAllByText(/Closing…/).length).toBeGreaterThanOrEqual(1);
    });
    const closingBtn = screen.getByRole("button", { name: /^Closing…$/ }) as HTMLButtonElement;
    expect(closingBtn.disabled).toBe(true);

    // Resolve to clean up.
    d.resolve();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /^Closing…$/ })).toBeNull();
    });
  });

  it("success: after onConfirm resolves, green 'Closed:' header + 'Export CSV for URA' CTA render and dispatch onExportCsv", async () => {
    const onConfirm = vi.fn(() => Promise.resolve());
    const onExportCsv = vi.fn();
    render(<ControlledHarness onConfirm={onConfirm} onExportCsv={onExportCsv} />);

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /^Close period$/ }));

    await waitFor(() => {
      expect(screen.getByText(`Closed: ${PERIOD_LABEL}`)).toBeTruthy();
    });
    // Eyebrow flips to success tone.
    const eyebrow = screen.getByText("Closed");
    expect(eyebrow.className).toContain("text-success-fg");

    const csvBtn = screen.getByRole("button", { name: /Export CSV for URA/i });
    fireEvent.click(csvBtn);
    expect(onExportCsv).toHaveBeenCalledTimes(1);
  });

  it("error: when onConfirm rejects, destructive banner + 'Retry close' render; retry re-invokes onConfirm", async () => {
    let attempt = 0;
    const onConfirm = vi.fn(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error("boom"))
        : Promise.resolve();
    });
    render(<ControlledHarness onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /^Close period$/ }));

    // Banner shows the rejection message in destructive tone.
    await waitFor(() => {
      expect(screen.getByText(/Couldn't close period\./)).toBeTruthy();
    });
    expect(screen.getByText(/boom/)).toBeTruthy();

    const retryBtn = screen.getByRole("button", { name: /Retry close/i });
    // Retry button keeps destructive tone (genuine failure state).
    expect(retryBtn.className).toContain("bg-destructive");

    fireEvent.click(retryBtn);
    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledTimes(2);
    });
    // Second attempt resolves → success surface.
    await waitFor(() => {
      expect(screen.getByText(`Closed: ${PERIOD_LABEL}`)).toBeTruthy();
    });
  });

  it("re-open after error resets state (checkbox unchecked, banner gone, button back to disabled 'Close period')", async () => {
    const onConfirm = vi.fn(() => Promise.reject(new Error("boom")));
    render(<ControlledHarness onConfirm={onConfirm} />);

    // Tick + click → error surface.
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /^Close period$/ }));
    await waitFor(() => {
      expect(screen.getByText(/Couldn't close period\./)).toBeTruthy();
    });

    // Close, then reopen via the harness controls.
    fireEvent.click(screen.getByTestId("harness-close"));
    await waitFor(() => {
      expect(screen.queryByText(/Couldn't close period\./)).toBeNull();
    });
    fireEvent.click(screen.getByTestId("harness-reopen"));

    // After reopen: error banner gone, checkbox unchecked, confirm button disabled
    // and labelled "Close period" again.
    await waitFor(() => {
      const reopenedBtn = screen.queryByRole("button", { name: /^Close period$/ });
      expect(reopenedBtn).not.toBeNull();
    });
    expect(screen.queryByText(/Couldn't close period\./)).toBeNull();
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    const closeBtn = screen.getByRole("button", { name: /^Close period$/ }) as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(true);
    // No "Retry close" button — error state cleared.
    expect(screen.queryByRole("button", { name: /Retry close/i })).toBeNull();
  });
});

describe("ClosePeriodDialog — a11y", () => {
  it("on open, focus lands on the Cancel button (cancel-first), not the checkbox", async () => {
    render(<ControlledHarness onConfirm={() => Promise.resolve()} />);

    // Radix runs onOpenAutoFocus async-microtask-ish; wait until cancel is focused.
    await waitFor(() => {
      const cancelBtn = screen.getByRole("button", { name: /^Cancel$/ });
      expect(document.activeElement).toBe(cancelBtn);
    });

    // And NOT the checkbox.
    const checkbox = screen.getByRole("checkbox");
    expect(document.activeElement).not.toBe(checkbox);
  });
});
