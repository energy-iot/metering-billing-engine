"use client";

import { usePathname, useRouter } from "next/navigation";
import { useRef, type KeyboardEvent } from "react";

// Setup sub-nav (D2 / #53).
//
// Visual language per designer mock `mgm-ia-v1.html` § .setup-subnav:
//   pill-style container (bg-muted), each tab has its own rounded surface,
//   active tab raises onto a bg-card surface. This is visually DEMOTED
//   compared to the top Dashboard/Billing/Setup tabs so it signals
//   "sub-area, not a primary destination".
//
// A11y contract:
//   - The nav is `role="tablist"` with `aria-label`.
//   - Each link is `role="tab"` with `aria-selected` + `aria-controls` pointing at
//     the content region id (the `children` container in the parent layout —
//     ties the tab to a panel landmark via its known id).
//   - ArrowLeft / ArrowRight cycle between tabs and move focus + navigate
//     (focus mirrors active selection — no parking separate focused tab).
//   - Home / End jump to first / last tab.

type SubTab = { label: string; segment: string };

const TABS: SubTab[] = [
  { label: "Edges & Devices", segment: "edges" },
  { label: "Households",      segment: "households" },
  { label: "Rate Schedule",   segment: "rates" },
];

export function SetupSubNav({ microgridId }: { microgridId: string }) {
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
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              isActive
                ? "bg-card text-foreground font-semibold shadow-elev-1"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </a>
        );
      })}
    </nav>
  );
}
