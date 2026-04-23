"use client";

/**
 * no-access-logout.tsx — minimal logout button for /no-access.
 *
 * We inline a dedicated client component here rather than importing the
 * dashboard's LogoutButton so the /no-access route tree is fully
 * standalone — no accidental coupling to dashboard-only context
 * providers in the future.
 */
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function NoAccessLogout() {
  const router = useRouter();
  const supabase = createClient();

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <button
      onClick={handleLogout}
      className="inline-flex h-9 items-center rounded-md border border-border bg-card px-4 text-sm font-medium text-foreground shadow-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      Log out
    </button>
  );
}
