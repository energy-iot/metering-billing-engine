"use client";

/**
 * SidebarNavLinks — client child of SidebarNav (#97).
 *
 * Receives a pre-filtered entries array from the server parent (role-gating
 * happens server-side in sidebar-nav.tsx) and computes the active state via
 * usePathname(). Each entry carries a matchPrefix so the visible href and the
 * active-match target can differ (e.g. Settings links to /settings/profile but
 * highlights on any /settings/* route).
 *
 * Active link: bg-accent text-accent-foreground + aria-current="page"
 * Idle link:   text-muted-foreground hover:bg-accent hover:text-accent-foreground
 * Pending link (navigation announced, route not yet settled): inline spinner +
 *   aria-busy="true" + data-pending="true" so the click reads as recorded and
 *   double-clicks are visibly redundant. Clears when usePathname() settles.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";
import { announceNavigationStart } from "@/components/ui/navigation-progress";
import { NavSpinner } from "@/components/ui/nav-spinner";

export type SidebarEntry = {
  label: string;
  href: string;
  matchPrefix: string;
  exact?: boolean;
};

export function isActive(pathname: string, entry: SidebarEntry): boolean {
  if (entry.exact) return pathname === entry.matchPrefix;
  return (
    pathname === entry.matchPrefix ||
    pathname.startsWith(entry.matchPrefix + "/")
  );
}

export function SidebarNavLinks({ entries }: { entries: SidebarEntry[] }) {
  const pathname = usePathname();
  const [pendingHref, setPendingHref] = React.useState<string | null>(null);

  // Navigation settled → clear the pending affordance.
  React.useEffect(() => {
    setPendingHref(null);
  }, [pathname]);

  return (
    <nav aria-label="Primary" className="flex-1 space-y-1 px-3 py-4">
      {entries.map((entry) => {
        const active = isActive(pathname, entry);
        const pending = pendingHref === entry.href && !active;
        return (
          <Link
            key={entry.href}
            href={entry.href}
            aria-current={active ? "page" : undefined}
            aria-busy={pending || undefined}
            data-pending={pending || undefined}
            onClick={() => {
              if (entry.href !== pathname) {
                setPendingHref(entry.href);
                announceNavigationStart(entry.href);
              }
            }}
            className={
              active
                ? "flex items-center rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground"
                : "flex items-center rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            }
          >
            {entry.label}
            {pending && <NavSpinner className="ml-auto" />}
          </Link>
        );
      })}
    </nav>
  );
}
