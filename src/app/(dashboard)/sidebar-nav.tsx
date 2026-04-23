import { createClient } from "@/lib/supabase/server";
import { currentUserIsSuperAdmin } from "@/lib/auth/access";
import { SidebarNavLinks } from "./sidebar-nav-links";
import type { SidebarEntry } from "./sidebar-nav-links";

/**
 * SidebarNav — dashboard sidebar navigation (#76, #97).
 *
 * Server component: resolves the user's super_admin status via the auth
 * access module, builds a pre-filtered entries array, and delegates
 * rendering (including active-state via usePathname) to SidebarNavLinks.
 *
 * The Organizations entry is omitted from the entries array when the user is
 * not a super_admin — role gating stays entirely server-side so a tampered
 * client cannot reveal hidden links by inspecting the DOM.
 *
 * Settings links to /settings/profile (lands the user on a real page) but
 * uses matchPrefix="/settings" so any /settings/* route keeps it highlighted.
 */
export async function SidebarNav() {
  const supabase = await createClient();
  const isSuperAdmin = await currentUserIsSuperAdmin(supabase);

  const entries: SidebarEntry[] = [
    { label: "Dashboard", href: "/", matchPrefix: "/", exact: true },
    ...(isSuperAdmin
      ? [
          {
            label: "Organizations",
            href: "/organizations",
            matchPrefix: "/organizations",
          } satisfies SidebarEntry,
        ]
      : []),
    { label: "Communities", href: "/communities", matchPrefix: "/communities" },
    { label: "Microgrids", href: "/microgrids", matchPrefix: "/microgrids" },
    {
      label: "Settings",
      href: "/settings/profile",
      matchPrefix: "/settings",
    },
  ];

  return <SidebarNavLinks entries={entries} />;
}
