import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { currentUserIsSuperAdmin } from "@/lib/auth/access";

/**
 * SidebarNav — dashboard sidebar navigation (#76).
 *
 * Server component: resolves the user's super_admin status via the auth
 * access module, then renders the "Organizations" entry only for super_admin.
 *
 * Entries are server-rendered — there is no client-side role check that a
 * tampered browser could bypass. The route's server component is the
 * authoritative visibility gate.
 */
export async function SidebarNav() {
  const supabase = await createClient();
  const isSuperAdmin = await currentUserIsSuperAdmin(supabase);

  return (
    <nav className="flex-1 space-y-1 px-3 py-4">
      <Link
        href="/"
        className="flex items-center rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground"
      >
        Dashboard
      </Link>
      {isSuperAdmin && (
        <Link
          href="/organizations"
          className="flex items-center rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          Organizations
        </Link>
      )}
      <Link
        href="/communities"
        className="flex items-center rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        Communities
      </Link>
      <Link
        href="/microgrids"
        className="flex items-center rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        Microgrids
      </Link>
      <span className="flex items-center rounded-md px-3 py-2 text-sm text-muted-foreground cursor-not-allowed">
        Settings (coming soon)
      </span>
    </nav>
  );
}
