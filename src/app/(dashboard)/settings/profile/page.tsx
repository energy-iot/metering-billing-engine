import { createClient } from "@/lib/supabase/server";
import { ProfileForm } from "./profile-form";

/**
 * /settings/profile — edit your own profile (UX5 / #79).
 *
 * Server component: reads the caller's user_profiles row (RLS SELECT
 * policy allows self). Email comes from auth.users and is read-only.
 */
export default async function SettingsProfilePage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // Dashboard layout already redirects to /login — belt-and-braces.
    return null;
  }

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  return (
    <div className="max-w-xl space-y-4">
      <h2 className="text-lg font-semibold text-foreground">Profile</h2>
      <ProfileForm
        userId={user.id}
        email={user.email ?? ""}
        initial={{
          first_name: profile?.first_name ?? null,
          last_name: profile?.last_name ?? null,
          phone: profile?.phone ?? null,
        }}
      />
    </div>
  );
}
