import { createBrowserClient } from "@supabase/ssr";

// When SUPABASE_INTERNAL_URL is set (Docker mode), the server uses a different
// URL than the browser. Force the same cookie name so both sides find the session.
const cookieName = process.env.NEXT_PUBLIC_SUPABASE_COOKIE_NAME;

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    cookieName ? { cookieOptions: { name: cookieName } } : undefined
  );
}
