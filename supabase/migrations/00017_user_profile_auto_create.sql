-- 00017_user_profile_auto_create.sql
-- Issue #96: Ensure every auth.users row has a user_profiles row.
--
-- Root cause: user_profiles.INSERT policy is WITH CHECK (FALSE), so only the
-- invite RPC (fn_finalize_user_invitation, 00013) can create profile rows via
-- its SECURITY DEFINER body. Users seeded via 00003, created from the Supabase
-- dashboard, or entering via any path other than the invite RPC end up orphaned
-- — no profile row — which surfaces as a misleading 403 on the Profile settings
-- page.
--
-- Two-part fix:
--
--   1. BACKFILL: a one-time INSERT that creates empty profile rows for every
--      existing auth.users row that lacks one. ON CONFLICT (user_id) DO NOTHING
--      is safe because user_id is the PRIMARY KEY.
--
--   2. TRIGGER: an AFTER INSERT trigger on auth.users that auto-creates an
--      empty profile row whenever a new auth user appears (via inviteUserByEmail,
--      createUser, signUp, or any future path).
--
-- Interaction with fn_finalize_user_invitation (00013:93-98):
--   The invite flow is: (1) auth.admin.inviteUserByEmail → auth.users INSERT
--   → trigger fires → empty user_profiles row created; then (2) the invite RPC
--   runs and does INSERT ... ON CONFLICT (user_id) DO UPDATE SET first_name=...,
--   last_name=..., phone=.... The RPC's existing UPSERT semantics overwrite the
--   empty trigger-created row with the real values. No change to the RPC is
--   needed.
--
-- Idempotent: uses CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS + CREATE
-- TRIGGER, so supabase db reset (which replays all migrations) is safe.

-- ── 1. Backfill existing orphans ─────────────────────────────────────────────

-- Creates an empty profile row (all nullable fields NULL) for every auth.users
-- row that does not already have one. The trigger (below) handles new rows going
-- forward; this handles the historical gap.
INSERT INTO public.user_profiles (user_id)
  SELECT id FROM auth.users
  ON CONFLICT (user_id) DO NOTHING;

-- ── 2. Trigger function ───────────────────────────────────────────────────────

-- SECURITY DEFINER: runs as the function owner (postgres), bypassing the
-- user_profiles INSERT policy WITH CHECK (FALSE). This mirrors the approach
-- used by fn_finalize_user_invitation (00013) which also writes user_profiles
-- under SECURITY DEFINER semantics.
--
-- SET search_path = public, pg_temp: guards against search_path injection,
-- consistent with every other SECURITY DEFINER function in this schema.
--
-- ON CONFLICT (user_id) DO NOTHING: makes the trigger safe under concurrent /
-- out-of-order insert paths. If a profile row somehow exists already (e.g. a
-- future migration path we haven't thought of), the trigger silently skips.
--
-- RETURN NEW: required for AFTER ROW triggers on INSERT — the return value is
-- ignored by Postgres for AFTER triggers, but must be non-NULL.
CREATE OR REPLACE FUNCTION fn_create_profile_on_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.user_profiles (user_id)
    VALUES (NEW.id)
    ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- ── 3. Trigger on auth.users ──────────────────────────────────────────────────

-- DROP + CREATE is idempotent (safe for supabase db reset). We cannot use
-- CREATE OR REPLACE TRIGGER (Postgres 14 feature not universally available in
-- Supabase's managed Postgres versions).
DROP TRIGGER IF EXISTS trg_create_profile_on_auth_user ON auth.users;

CREATE TRIGGER trg_create_profile_on_auth_user
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION fn_create_profile_on_auth_user();
