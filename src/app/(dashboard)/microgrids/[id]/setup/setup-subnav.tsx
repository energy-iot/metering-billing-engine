"use client";

import { usePathname, useRouter } from "next/navigation";
import { useRef, type KeyboardEvent } from "react";
import { StatusChip } from "@/components/ui/status-chip";
import type { OpenemsBackendHealth } from "./openems-backend/health";

// Setup sub-nav (D2 / #53, extended #102).
//
// Visual language per designer mock `mgm-ia-v1.html` § .setup-subnav:
//   pill-style container (bg-muted), each tab has its own rounded surface,
//   active tab raises onto a bg-card surface.
//
// A11y contract:
//   - The nav is `role="tablist"` with `aria-label`.
//   - Each link is `role="tab"` with `aria-selected` + `aria-controls` pointing
//     at the content region id.
//   - ArrowLeft / ArrowRight cycle between tabs and move focus + navigate.
//   - Home / End jump to first / last tab.
//   - The OpenEMS Backend tab chip is rendered INSIDE the single <a> element.
//     Radix Tooltip wraps the chip and adds a focusable span (tabindex=0)
//     inside the anchor. Screen readers follow the anchor as the primary
//     control; the tooltip surfaces status copy on hover/focus.

type SubTab = { label: string; segment: string };

const TABS: SubTab[] = [
  { label: "Edges & Devices",  segment: "edges" },
  { label: "Households",       segment: "households" },
  { label: "OpenEMS Backend",  segment: "openems-backend" },
  { label: "Rate Schedule",    segment: "rates" },
];

export type OpenemsBackendChipData = {
  status: OpenemsBackendHealth;
  lastDiscoverAt: string | null;
  lastDiscoverError: string | null;
  relativeTime: string | null;
};

function tooltipFor(data: OpenemsBackendChipData): string | null {
  switch (data.status) {
    case "healthy":
      return data.relativeTime
        ? `Last successful discovery: ${data.relativeTime}`
        : "Connection healthy";
    case "stale":
      return data.relativeTime
        ? `Last successful discovery: ${data.relativeTime}. Run 'Test again' to verify.`
        : "Run 'Test again' to verify the connection.";
    case "failing":
      return data.lastDiscoverError
        ? `Discovery failed: ${data.lastDiscoverError}. Reconfigure or test again.`
        : "Discovery failed. Reconfigure or test again.";
    case "not_configured":
      return "No OpenEMS backend connected yet.";
  }
}

export function SetupSubNav({
  microgridId,
  openemsBackendHealth,
}: {
  microgridId: string;
  openemsBackendHealth?: OpenemsBackendChipData;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const base = `/microgrids/${microgridId}/setup`;
  const tabRefs = useRef<Array<HTMLAnchorElement | null>>([]);

  // Determine the active tab: match longest-prefix so nested routes
  // (e.g. setup/edges/[edgeId]) keep the Edges tab highlighted.
  const activeIndex = (() => {
    const hits = TABS.map((t, i) =>
      pathname.startsWith(`${base}/${t.segment}`) ? i : -1
    ).filter((i) => i >= 0);
    if (hits.length === 0) return 0;
    // Pick the tab whose full prefix matches most specifically.
    return hits.reduce((best, i) =>
      TABS[i].segment.length > TABS[best].segment.length ? i : best
    );
  })();

  function onKeyDown(e: KeyboardEvent<HTMLAnchorElement>, current: number) {
    const last = TABS.length - 1;
    let next = current;
    switch (e.key) {
      case "ArrowRight":
        next = current === last ? 0 : current + 1;
        break;
      case "ArrowLeft":
        next = current === 0 ? last : current - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    e.preventDefault();
    const el = tabRefs.current[next];
    el?.focus();
    router.push(`${base}/${TABS[next].segment}`);
  }

  return (
    <nav
      role="tablist"
      aria-label="Setup sections"
      className="inline-flex w-fit gap-1 rounded-lg bg-muted p-1"
    >
      {TABS.map((tab, i) => {
        const isActive = i === activeIndex;
        const href = `${base}/${tab.segment}`;
        const chipData =
          tab.segment === "openems-backend" ? openemsBackendHealth : undefined;
        return (
          <a
            key={tab.segment}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            href={href}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              isActive
                ? "bg-card text-foreground font-semibold shadow-elev-1"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <span>{tab.label}</span>
            {chipData && (
              <StatusChip
                kind="openemsBackendHealth"
                status={chipData.status}
                size="sm"
                tooltip={tooltipFor(chipData)}
              />
            )}
          </a>
        );
      })}
    </nav>
  );
}
