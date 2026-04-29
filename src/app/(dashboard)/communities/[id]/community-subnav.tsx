"use client";

import { usePathname, useRouter } from "next/navigation";
import { useRef, type KeyboardEvent } from "react";
import { StatusChip } from "@/components/ui/status-chip";
import type { PaymentHealth } from "./payment/health";

// Community sub-nav (#119).
//
// Sibling to `src/app/(dashboard)/microgrids/[id]/setup/setup-subnav.tsx`;
// intentionally NOT a refactor of that component — the OpenEMS chip wiring
// there is load-bearing and the two sub-navs live at different URL scopes.
//
// Visual language matches SetupSubNav (pill-style container `bg-muted`,
// active tab raises onto `bg-card shadow-elev-1`).
//
// A11y contract (mirrors SetupSubNav):
//   - role="tablist" + aria-label
//   - each link is role="tab" + aria-selected
//   - ArrowLeft/Right cycle; Home/End jump to first/last
//   - The Payment tab chip is rendered INSIDE the anchor; Radix Tooltip
//     wraps the chip and adds a focusable span (tabindex=0). Screen readers
//     follow the anchor as the primary control.

type SubTab = { label: string; segment: string };

const TABS: SubTab[] = [
  { label: "Overview", segment: "" },
  { label: "Payment", segment: "payment" },
];

// Invoice tab is appended to the visible-tabs array conditionally based on
// the `showInvoiceTab` prop — see PDF2 (#204). Hidden, not just disabled, when
// the caller is not org_manager-of-parent-org / super_admin.
const INVOICE_TAB: SubTab = { label: "Invoice", segment: "invoice" };

export type PaymentChipData = {
  status: PaymentHealth;
  lastConfiguredAt: string | null;
  relativeTime: string | null;
};

function tooltipFor(data: PaymentChipData): string | null {
  switch (data.status) {
    case "healthy":
      return data.relativeTime
        ? `Last successful save: ${data.relativeTime}`
        : "Connection healthy";
    case "stale":
      return data.relativeTime
        ? `Last save: ${data.relativeTime}. Run Save & test again to verify.`
        : "Run Save & test again to verify.";
    case "failing":
      // Phase B (#157): emitted when the most recent IPN webhook for any
      // microgrid in this community reported `to_status='failed'` within
      // the last 24h.
      return "Recent payment failed. Investigate the latest IPN delivery in payment_events.";
    case "not_configured":
      return "No payment provider connected yet.";
  }
}

export function CommunitySubNav({
  communityId,
  paymentHealth,
  showInvoiceTab = false,
}: {
  communityId: string;
  paymentHealth?: PaymentChipData;
  /**
   * When true, append the Invoice tab to the sub-nav (#204 / PDF2). Defaults
   * to false so existing callers (and tests that mount the component without
   * the prop) keep their 2-tab shape unchanged.
   */
  showInvoiceTab?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const base = `/communities/${communityId}`;
  const tabRefs = useRef<Array<HTMLAnchorElement | null>>([]);

  // Build the visible-tabs array from props rather than mutating the module
  // constant. Keyboard cycling (ArrowLeft/Right + Home/End) derives `last`
  // from `visibleTabs.length` so the cycle covers Invoice when present.
  const visibleTabs: SubTab[] = showInvoiceTab ? [...TABS, INVOICE_TAB] : TABS;

  // Active-tab resolution:
  //   - Invoice tab wins when pathname starts with `${base}/invoice`
  //   - Payment tab wins when pathname starts with `${base}/payment`
  //   - Otherwise Overview (default / exact-match).
  const activeIndex = (() => {
    for (let i = 0; i < visibleTabs.length; i++) {
      const t = visibleTabs[i];
      if (t.segment === "") continue;
      if (pathname.startsWith(`${base}/${t.segment}`)) return i;
    }
    return 0;
  })();

  function hrefFor(tab: SubTab): string {
    return tab.segment === "" ? base : `${base}/${tab.segment}`;
  }

  function onKeyDown(e: KeyboardEvent<HTMLAnchorElement>, current: number) {
    const last = visibleTabs.length - 1;
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
    router.push(hrefFor(visibleTabs[next]));
  }

  return (
    <nav
      role="tablist"
      aria-label="Community sections"
      className="inline-flex w-fit gap-1 rounded-lg bg-muted p-1"
    >
      {visibleTabs.map((tab, i) => {
        const isActive = i === activeIndex;
        const chipData = tab.segment === "payment" ? paymentHealth : undefined;
        return (
          <a
            key={tab.segment || "overview"}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            href={hrefFor(tab)}
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
                kind="paymentHealth"
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
