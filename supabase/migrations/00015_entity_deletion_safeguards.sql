-- 00015_entity_deletion_safeguards.sql
-- Entity deletion semantics (#89).
--
-- Two correctness gaps in the pre-existing schema are addressed here:
--
-- 1. AC-ROLES-1 — `user_roles.scope_id` is declared as plain `UUID` (no FK)
--    in 00001_schema.sql:270. When an Organization is deleted (CASCADE being
--    the PM-decided behavior for #89), the `user_roles` rows that scope
--    `org_manager` access to that org are left dangling — `scope_id` still
--    carries the deleted org's UUID. Add a proper FK constraint so the
--    cascade chain reaches user_roles.
--
--    The column today is only ever populated with organization ids (the
--    `role_scope_type` enum has a single value — `'org'`). That changes when
--    `microgrid_manager` / `household_*` scopes ship, which will introduce
--    additional scope types whose FKs must be added separately (see comment
--    on the constraint below).
--
-- 2. AC-ROLES-3 — `fn_user_roles_before_delete_guard` (installed in
--    00013_invite_user_rpc.sql) raises `42501` on self-revocation. When the
--    above CASCADE path fires for an `org_manager` deleting *their own* org,
--    the trigger sees `OLD.user_id = auth.uid()` and rolls the whole delete
--    back. We introduce a per-transaction GUC (`app.entity_cascade_delete`)
--    that the DELETE routes flip on via `SET LOCAL` so the guard can tell
--    "this is a cascade from an entity delete I already authorized" apart
--    from "someone is trying to mutate user_roles directly via the invite
--    flow." SET LOCAL scopes to the current transaction only — it cannot
--    leak between sessions, and `current_setting(name, true)` returns NULL
--    (rather than erroring) if it was never set, so the invite RPCs and
--    every other path continue to enforce both guards unchanged.
--
--    The bypass flag is ONLY set in the four entity DELETE routes shipped
--    in #89 (`DELETE /api/{organizations|communities|microgrids|edges}/[id]`).
--    It must NOT be set anywhere else.
--
-- Idempotent / re-run-safe: the ADD CONSTRAINT is preceded by a defensive
-- DROP IF EXISTS so `supabase db reset` replays cleanly, and the orphan
-- cleanup deletes zero rows after the first run.

-- ── 1. Clean up any orphan user_roles rows (defensive — production DB
--    predates the FK and may have dangling scope_ids from manual cleanup).
DELETE FROM user_roles
 WHERE scope_type = 'org'
   AND scope_id IS NOT NULL
   AND scope_id NOT IN (SELECT id FROM organizations);

-- ── 2. Add the FK with ON DELETE CASCADE.
--
-- Note: this constraint assumes `scope_id` only ever references
-- `organizations.id`. Today that is enforced by the single-value
-- `role_scope_type` enum. When additional scope types land (e.g.
-- 'microgrid'), this constraint must be revisited — either converted to a
-- partial FK (via a dropped-column + check constraint migration) or
-- replaced with per-scope-type FKs. Re-evaluate at that point.
ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_scope_org_fkey;
ALTER TABLE user_roles
  ADD CONSTRAINT user_roles_scope_org_fkey
  FOREIGN KEY (scope_id)
  REFERENCES organizations(id)
  ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE;

-- ── 3. Extend the BEFORE DELETE guard with the cascade-bypass flag.
--
-- The replacement below is a strict superset of the original: the first
-- check short-circuits to RETURN OLD when `app.entity_cascade_delete =
-- 'on'`, otherwise the logic is byte-for-byte identical to what was
-- installed in 00013_invite_user_rpc.sql. The original trigger binding
-- (`trg_user_roles_before_delete_guard`) is preserved — we only rewrite
-- the function body.
CREATE OR REPLACE FUNCTION fn_user_roles_before_delete_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_remaining INT;
  v_session_role TEXT;
BEGIN
  -- NEW (AC-ROLES-3): honor the per-transaction cascade bypass. Only the
  -- four entity-deletion routes in #89 set this GUC via `SET LOCAL` inside
  -- their transaction wrapper. `current_setting(..., true)` (the trailing
  -- `true` = missing_ok) returns NULL when unset, so the invite RPCs and
  -- every other caller fall straight through to the original guards.
  IF current_setting('app.entity_cascade_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;

  -- Bypass guards for DB-superuser cascade paths:
  --   - `postgres` (local dev, migration tooling, test harness cleanup)
  --   - `supabase_admin` (Supabase cloud admin operations)
  -- When auth.users is purged externally (admin console / cleanup script),
  -- the ON DELETE CASCADE propagates into user_roles and fires this
  -- trigger. If the purged user happens to be the last super_admin, the
  -- trigger would block the cleanup, leaving orphan auth rows. Bypass is
  -- safe: these roles already have full DB access by definition.
  --
  -- IMPORTANT: use session_user, NOT current_user. Both fn_finalize_user_invitation
  -- and fn_change_user_role are SECURITY DEFINER owned by `postgres`, so
  -- current_user evaluates to 'postgres' inside those function bodies — which
  -- would silently bypass ALL trigger guards (self-revoke + last-super_admin)
  -- for any call via those RPCs. session_user returns the original LOGIN role
  -- (e.g. `authenticated` for normal users) and is NOT changed by SECURITY
  -- DEFINER. The bypass is only triggered when literally connecting as postgres
  -- or supabase_admin (migrations, direct admin operations).
  v_session_role := session_user;
  IF v_session_role IN ('postgres', 'supabase_admin') THEN
    RETURN OLD;
  END IF;

  -- Self-revocation guard. auth.uid() is NULL for service-role callers; we
  -- intentionally scope this guard to user-bound callers only — the
  -- service role is an out-of-band admin and can force a revoke if it
  -- really needs to (e.g. manual cleanup script). Routes MUST NOT use the
  -- service-role client for user-initiated deletes (documented in the
  -- route comment).
  IF auth.uid() IS NOT NULL AND OLD.user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot revoke your own access. Ask another administrator.'
      USING ERRCODE = '42501';
  END IF;

  -- Last-super_admin guard. If the row being removed is a super_admin row,
  -- and it is the last remaining super_admin row in the table, block.
  -- Counts rows where role='super_admin' excluding the row being deleted.
  IF OLD.role = 'super_admin' THEN
    SELECT COUNT(*) INTO v_remaining
    FROM user_roles
    WHERE role = 'super_admin'
      AND id <> OLD.id;

    IF v_remaining = 0 THEN
      RAISE EXCEPTION 'Cannot revoke the last super admin. Promote another user first.'
        USING ERRCODE = '40000';
    END IF;
  END IF;

  RETURN OLD;
END;
$$;
