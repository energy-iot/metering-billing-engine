// RowBannerStack — component test (jsdom environment) — BC2 #174 AC7

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import {
  RowBannerStack,
  type RowBannerEntry,
} from "../row-banner-stack";

const baseEntry = (
  overrides?: Partial<RowBannerEntry>,
): RowBannerEntry => ({
  id: "e-1",
  lineItemId: "li-1",
  tone: "info",
  message: "Test message.",
  durationMs: 5000,
  ...overrides,
});

describe("RowBannerStack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when entries is empty", () => {
    const { container } = render(
      <RowBannerStack
        entries={[]}
        onDismiss={vi.fn()}
        getHouseholdName={() => "Test"}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("auto-dismisses after durationMs", async () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(
      <RowBannerStack
        entries={[baseEntry({ durationMs: 1000 })]}
        onDismiss={onDismiss}
        getHouseholdName={() => "Test"}
      />,
    );

    expect(onDismiss).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(onDismiss).toHaveBeenCalledWith("e-1");
    vi.useRealTimers();
  });

  it("manual dismiss button calls onDismiss with the entry id", async () => {
    const onDismiss = vi.fn();
    render(
      <RowBannerStack
        entries={[baseEntry({ id: "e-42" })]}
        onDismiss={onDismiss}
        getHouseholdName={() => "Alice"}
      />,
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /dismiss notification for alice/i }),
      );
    });

    expect(onDismiss).toHaveBeenCalledWith("e-42");
  });

  it("multiple entries for one line item stack vertically", () => {
    const entries: RowBannerEntry[] = [
      baseEntry({ id: "e-1", message: "First" }),
      baseEntry({ id: "e-2", message: "Second" }),
      baseEntry({ id: "e-3", message: "Third" }),
    ];
    render(
      <RowBannerStack
        entries={entries}
        onDismiss={vi.fn()}
        getHouseholdName={() => "Bob"}
      />,
    );

    const stack = screen.getByTestId("row-banner-stack");
    expect(stack.children.length).toBe(3);
  });

  it("prefixes the household name in the title", () => {
    render(
      <RowBannerStack
        entries={[baseEntry({ message: "Failed" })]}
        onDismiss={vi.fn()}
        getHouseholdName={() => "Carol Family"}
      />,
    );
    // Title uses householdName · message format.
    expect(screen.getByText(/Carol Family · Failed/)).toBeTruthy();
  });

  it("optional action button calls its onClick when clicked", async () => {
    const action = vi.fn();
    render(
      <RowBannerStack
        entries={[
          baseEntry({
            tone: "destructive",
            message: "Failed",
            action: { label: "Retry", onClick: action },
          }),
        ]}
        onDismiss={vi.fn()}
        getHouseholdName={() => "Dee"}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^retry$/i }));
    });

    expect(action).toHaveBeenCalled();
  });
});
