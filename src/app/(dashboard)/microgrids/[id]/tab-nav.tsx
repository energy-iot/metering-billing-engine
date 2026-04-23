"use client";

import { usePathname } from "next/navigation";

// Microgrid tab nav (D2 / #53).
//
// Tab order (Dashboard | Billing | Setup) mirrors the operator workflow:
//   1. Dashboard — landing / daily orientation.
//   2. Billing    — the monthly close job (primary working surface).
//   3. Setup      — configure-once (edges, households, rate schedule).
//
// Active-tab match:
//   - Dashboard is the microgrid index (/microgrids/[id]) with no child segment.
//     A raw `startsWith` on the index href would also match /billing and /setup.
//     We detect "on the index" by requiring the URL to end at the microgrid id.
//   - Billing + Setup use `startsWith` so their nested routes stay highlighted.

const tabs = [
  { label: "Dashboard", segment: "" },
  { label: "Billing",   segment: "billing" },
  { label: "Setup",     segment: "setup" },
] as const;

export function TabNav({ microgridId }: { microgridId: string }) {
  const pathname = usePathname();
  const base = `/microgrids/${microgridId}`;

  return (
    <nav
      className="flex space-x-1 border-b border-border"
      role="tablist"
      aria-label="Microgrid sections"
    >
      {tabs.map((tab) => {
        const href = tab.segment ? `${base}/${tab.segment}` : base;
        const isActive = tab.segment
          ? pathname.startsWith(href)
          : pathname === base || pathname === `${base}/`;

        return (
          <a
            key={tab.label}
            href={href}
            role="tab"
            aria-selected={isActive}
            className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              isActive
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
            }`}
          >
            {tab.label}
          </a>
        );
      })}
    </nav>
  );
}
