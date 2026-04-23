-- 00016_restore_default_grants.sql
-- Restore Supabase's standard privilege grants on the `public` schema.
--
-- Why this exists:
--
-- Supabase normally installs these grants at project init (outside the
-- `supabase/migrations/` tree). They survive normal operations including
-- `supabase db reset` and regular migration replays. They do NOT survive
-- `DROP SCHEMA public CASCADE`, region migrations, or any recovery path
-- that recreates the `public` schema manually. When that happens, every
-- table ends up with zero grants for `authenticated` / `anon` /
-- `service_role`, and RLS policies become irrelevant — the user-bound
-- Supabase client gets "permission denied" on every query, which
-- typically surfaces as /no-access redirects or silently-empty queries.
--
-- First observed 2026-04-23 after a Path-C cloud migration replay left
-- `metering-billing-engine.vercel.app` 403ing every authenticated request
-- despite the `user_roles` rows being present. See
-- `mbe-docs/docs/learnings.md` and memory `feedback_drop_schema_public.md`.
--
-- This migration is idempotent: `GRANT` against an already-granted target
-- is a no-op, so running it against a fresh Supabase project (where these
-- grants are already present) causes no side effects.
--
-- The `ALTER DEFAULT PRIVILEGES` clause is the future-proofing: any table
-- added by a future migration (run as `postgres`, which is the default)
-- automatically inherits the grants without that migration having to
-- remember.

-- Schema-level usage.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Existing objects.
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO anon, authenticated, service_role;

-- Future objects created by `postgres` (the default migration role).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON ROUTINES TO anon, authenticated, service_role;
