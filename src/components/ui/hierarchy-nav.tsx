"use client";

// HierarchyNav — breadcrumb for org → community → microgrid → edge.
//
// Contract:
//   • Every segment is a link. Single-child segments (count === 1)
//     navigate but don't open a switcher; multi-sibling segments
//     (count > 1) add a count badge + chevron and open a Radix
//     DropdownMenu listing the siblings.
//   • The active segment is marked with `aria-current="page"` and
//     a left "you-are-here" pin (4×14 primary-colored rectangle) +
//     bordered muted background. Never `opacity: 0.6` (reads as
//     disabled).
//   • URL invariant: every level is a slug in the URL; every URL
//     renders the breadcrumb. Slugs (NOT UUIDs) are required — the
//     URL is a shareable artifact for the entrepreneur.
//
// A11y:
//   • <nav aria-label="Hierarchy breadcrumb">
//   • Each link's chevron + count are announced via composed text.

import * as React from "react";
import Link from "next/link";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";
import { announceNavigationStart } from "@/components/ui/navigation-progress";

export type HierarchyKind = "Organization" | "Community" | "Microgrid" | "Edge" | "Household";

export type HierarchyLevel = {
  kind: HierarchyKind;
  label: string;
  /** Number of siblings at this level (≥1). 1 = no switcher. */
  count: number;
  href: string;
  /** True for the level the current page belongs to. */
  active?: boolean;
  /** Sibling links used to populate the switcher when count > 1. */
  siblings?: { label: string; href: string }[];
};

export interface HierarchyNavProps {
  levels: HierarchyLevel[];
  className?: string;
}

export function HierarchyNav({ levels, className }: HierarchyNavProps) {
  const [pendingHref, setPendingHref] = React.useState<string | null>(null);
  const clearTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // No usePathname() here on purpose: this breadcrumb renders inside dozens
  // of server pages whose tests mock next/navigation partially. Pending
  // clears via unmount (successful nav swaps the page) plus a safety timeout
  // (failed nav stays mounted) — no router subscription needed.
  React.useEffect(() => {
    return () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
    };
  }, []);

  const handleNavClick = (href: string, active?: boolean) => {
    if (active) return;
    if (clearTimer.current) clearTimeout(clearTimer.current);
    setPendingHref(href);
    announceNavigationStart(href);
    // Safety: clear the affordance if the navigation never settles.
    clearTimer.current = setTimeout(() => setPendingHref(null), 4000);
  };

  return (
    <nav
      aria-label="Hierarchy breadcrumb"
      className={cn("flex flex-wrap items-center gap-1 bg-card", className)}
    >
      {levels.map((it, i) => {
        const hasSiblings = it.count > 1;
        const pending = pendingHref === it.href && !it.active;
        const segment = (
          <Link
            href={it.href}
            aria-current={it.active ? "page" : undefined}
            aria-busy={pending || undefined}
            data-pending={pending || undefined}
            onClick={() => handleNavClick(it.href, it.active)}
            className={cn(
              "inline-flex flex-col items-start rounded-md px-2.5 py-1 no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              it.active
                ? "border border-border bg-muted"
                : "border border-transparent hover:bg-muted",
            )}
          >
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {it.kind}
            </span>
            <span className="flex items-center gap-1 text-[13px] font-semibold text-foreground">
              {it.active && (
                <span aria-hidden="true" className="mr-0.5 h-3.5 w-1 rounded-sm bg-primary" />
              )}
              {it.label}
              {pending && (
                <svg
                  aria-hidden="true"
                  className="h-3 w-3 animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                </svg>
              )}
              {!pending && hasSiblings && (
                <>
                  <span
                    aria-label={`${it.count} ${it.kind.toLowerCase()}s`}
                    className="rounded-pill bg-accent px-1.5 py-px text-[11px] font-semibold text-accent-foreground"
                  >
                    {it.count}
                  </span>
                  <ChevronDown />
                </>
              )}
            </span>
          </Link>
        );
        return (
          <React.Fragment key={`${it.kind}-${it.href}`}>
            {hasSiblings && it.siblings && it.siblings.length > 0 ? (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>{segment}</DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="start"
                    sideOffset={4}
                    className="z-50 min-w-[200px] rounded-md border border-border bg-card p-1 shadow-elev-2"
                  >
                    <DropdownMenu.Label className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Switch {it.kind.toLowerCase()}
                    </DropdownMenu.Label>
                    {it.siblings.map((s) => (
                      <DropdownMenu.Item key={s.href} asChild>
                        <Link
                          href={s.href}
                          onClick={() => handleNavClick(s.href)}
                          className="flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-[13px] text-foreground outline-none data-[highlighted]:bg-muted"
                        >
                          {s.label}
                        </Link>
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            ) : (
              segment
            )}
            {i < levels.length - 1 && (
              <span aria-hidden="true" className="text-sm text-border">
                /
              </span>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

function ChevronDown() {
  return (
    <svg
      aria-hidden="true"
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6 L8 10 L12 6" />
    </svg>
  );
}
