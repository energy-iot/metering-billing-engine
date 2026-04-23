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
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

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

  return (
    <nav aria-label="Primary" className="flex-1 space-y-1 px-3 py-4">
      {entries.map((entry) => {
        const active = isActive(pathname, entry);
        return (
          <Link
            key={entry.href}
            href={entry.href}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "flex items-center rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground"
                : "flex items-center rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            }
          >
            {entry.label}
          </Link>
        );
      })}
    </nav>
  );
}
