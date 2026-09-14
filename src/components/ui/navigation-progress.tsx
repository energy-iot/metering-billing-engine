"use client";

// NavigationProgress — global top loading bar for route transitions.
//
// Contract:
//   • Any client-side navigation link dispatches `announceNavigationStart(href)`
//     (window CustomEvent `mbe:navigation-start`) on click. This component shows
//     an indeterminate top bar immediately, so the click reads as recorded.
//   • The bar hides shortly after `usePathname()` settles on the new route.
//     A 4s safety timeout hides it if the pathname never changes (failed nav).
//   • Token classes only (`bg-primary`); animation is `motion-safe` so
//     `prefers-reduced-motion` users get a static bar, not motion.
//   • `role="status"` + sr-only "Loading…" text announces the transition to
//     screen readers without moving focus.
//
// Invalidation: if App Router ever re-introduces router events, prefer them
// over this custom event — the event name is exported for that migration.

import * as React from "react";
import { usePathname } from "next/navigation";

export const MBE_NAVIGATION_START_EVENT = "mbe:navigation-start";

export function announceNavigationStart(href: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<string>(MBE_NAVIGATION_START_EVENT, { detail: href }),
  );
}

export function NavigationProgress() {
  const pathname = usePathname();
  const [visible, setVisible] = React.useState(false);
  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Show immediately on any announced navigation start.
  React.useEffect(() => {
    const onStart = () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setVisible(true);
      // Safety: never trap the bar on screen if the route never settles.
      hideTimer.current = setTimeout(() => setVisible(false), 4000);
    };
    window.addEventListener(MBE_NAVIGATION_START_EVENT, onStart);
    return () => {
      window.removeEventListener(MBE_NAVIGATION_START_EVENT, onStart);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  // Hide shortly after the pathname settles. Skips the mount render so the
  // bar doesn't flash on first load.
  const mounted = React.useRef(false);
  React.useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (!visible) return;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setVisible(false), 350);
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [pathname, visible]);

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-label="Loading page"
      className="fixed inset-x-0 top-0 z-[60] h-0.5 bg-transparent"
    >
      <div className="h-full w-1/3 bg-primary motion-safe:animate-[mbe-nav-progress_1s_ease-in-out_infinite]" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
