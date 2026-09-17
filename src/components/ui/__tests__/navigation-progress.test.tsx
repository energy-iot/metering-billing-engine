// @vitest-environment jsdom
/**
 * navigation-progress.test.tsx — tests for <NavigationProgress>.
 *
 * Covers:
 *   - hidden on mount (no flash on first load)
 *   - appears on mbe:navigation-start event with role="status"
 *   - hides after pathname settles
 *   - announceNavigationStart dispatches the window event
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

let mockPathname = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

import {
  NavigationProgress,
  announceNavigationStart,
  MBE_NAVIGATION_START_EVENT,
} from "../navigation-progress";

beforeEach(() => {
  mockPathname = "/";
  vi.useRealTimers();
});

describe("NavigationProgress", () => {
  it("is hidden on mount (no first-load flash)", () => {
    render(<NavigationProgress />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("appears when a navigation start is announced", () => {
    render(<NavigationProgress />);
    act(() => {
      announceNavigationStart("/microgrids");
    });
    expect(screen.getByRole("status", { name: "Loading page" })).toBeDefined();
  });

  it("announceNavigationStart dispatches the window event with href detail", () => {
    const seen: string[] = [];
    const listener = (e: Event) =>
      seen.push((e as CustomEvent<string>).detail);
    window.addEventListener(MBE_NAVIGATION_START_EVENT, listener);
    announceNavigationStart("/communities");
    window.removeEventListener(MBE_NAVIGATION_START_EVENT, listener);
    expect(seen).toEqual(["/communities"]);
  });

  it("hides after the pathname settles", () => {
    vi.useFakeTimers();
    const { rerender } = render(<NavigationProgress />);
    act(() => {
      announceNavigationStart("/microgrids");
    });
    expect(screen.getByRole("status", { name: "Loading page" })).toBeDefined();

    // Simulate the route settling: pathname changes → 350ms → hidden.
    mockPathname = "/microgrids";
    rerender(<NavigationProgress />);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stays visible while a slow navigation is still in flight (pr-374)", () => {
    vi.useFakeTimers();
    render(<NavigationProgress />);
    act(() => {
      announceNavigationStart("/microgrids");
    });
    // 1s passes with NO pathname change — the 350ms settle-hide must not
    // fire; only a real transition or the 4s safety may hide the bar.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("status", { name: "Loading page" })).toBeDefined();
    // And the 4s safety still applies when the route never settles.
    act(() => {
      vi.advanceTimersByTime(3100);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
