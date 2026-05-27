"use client";

/**
 * settings-subnav.tsx — Settings sub-navigation (UX5 / #79).
 *
 * Mirrors `src/app/(dashboard)/microgrids/[id]/setup/setup-subnav.tsx`:
 *   - Pill-style tablist sitting on a bg-muted container; active tab
 *     raises onto bg-card with shadow-elev-1.
 *   - role="tablist", per-tab role="tab", aria-selected, aria-controls.
 *   - ArrowLeft / ArrowRight cycle; Home / End jump to ends.
 *   - Longest-prefix active-tab match — future nested routes under
 *     /settings/<tab>/... keep the parent tab highlighted.
 *
 * Two tabs ship for MVP: Profile (self), Users (admin-side). Both
 * visible for both MVP roles (super_admin + org_manager can both
 * invite). Future `microgrid_manager` may need per-role visibility —
 * not now.
 *
 * Copy-paste-adapted per ticket Dev Notes ("don't extract a shared
 * <TabNav> until a third caller appears — YAGNI").
 */
import { usePathname, useRouter } from "next/navigation";
import { useRef, type KeyboardEvent } from "react";

type SubTab = { label: string; segment: string };

const TABS: SubTab[] = [
  { label: "Profile", segment: "profile" },
  { label: "Users", segment: "users" },
  { label: "API tokens", segment: "api-tokens" },
];

export function SettingsSubNav() {
  const pathname = usePathname();
  const router = useRouter();
  const tabRefs = useRef<Array<HTMLAnchorElement | null>>([]);

  const base = "/settings";

  const activeIndex = (() => {
    const hits = TABS.map((t, i) =>
      pathname.startsWith(`${base}/${t.segment}`) ? i : -1
    ).filter((i) => i >= 0);
    if (hits.length === 0) return 0;
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
      aria-label="Settings sections"
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
            aria-controls="settings-panel"
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
