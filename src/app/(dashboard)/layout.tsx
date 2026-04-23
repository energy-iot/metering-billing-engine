import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LogoutButton } from "./logout-button";
import { SidebarNav } from "./sidebar-nav";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // UX5 (#79) — gate revoked users. A logged-in auth.users row with no
  // user_roles rows has had their access revoked (or was never granted).
  // Send them to /no-access (outside this route group) so they get a
  // clear message + logout action instead of a broken sidebar. The
  // user_roles "Users can view their own roles" SELECT policy lets the
  // caller see their own rows, so this COUNT is accurate.
  const { count: roleCount } = await supabase
    .from("user_roles")
    .select("id", { head: true, count: "exact" })
    .eq("user_id", user.id);
  if ((roleCount ?? 0) === 0) {
    redirect("/no-access");
  }

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="flex w-64 flex-col border-r border-border bg-muted">
        <div className="border-b border-border px-6 py-4">
          <h2 className="text-lg font-semibold text-foreground">MBE</h2>
        </div>
        <SidebarNav />
      </aside>

      {/* Main content */}
      <div className="flex flex-1 flex-col">
        {/* Top bar */}
        <header className="flex items-center justify-between border-b border-border bg-card px-6 py-3">
          <div />
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">{user.email}</span>
            <LogoutButton />
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
