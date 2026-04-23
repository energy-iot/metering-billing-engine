-- 00013_invite_user_rpc.sql
-- UX5 (#79): invitation finalization + role-change RPCs, plus a
-- BEFORE DELETE safety-net trigger on `user_roles`.
--
-- Design:
--   * Both RPCs are SECURITY DEFINER (owned by postgres). This is
--     REQUIRED — the INSERT policy on user_profiles is
--     `WITH CHECK (FALSE)` (blocks direct inserts from tenant code),
--     so a SECURITY INVOKER function body would fail to INSERT the
--     profile row. SECURITY DEFINER bypasses RLS on the function body
--     while still letting the permission helpers read `auth.uid()`
--     (`auth.uid()` returns the caller's id even under SECURITY
--     DEFINER). search_path is pinned to `public, pg_temp` per the
--     Supabase SECURITY DEFINER best practice.
--   * The route MUST call these via the user-bound server client (NOT
--     the service-role client). A service-role caller has
--     `auth.uid() = NULL`, which short-circuits the "Not authenticated"
--     guard → ERRCODE 42501. This is intentional: only real session-
--     bearing users can invoke invitation.
--   * Permission checks raise with Postgres ERRCODE:
--       42501 — permission denied (role/scope not allowed)
--       22023 — invalid parameter (missing scope for org_manager, etc.)
--   * `fn_finalize_user_invitation`: the invite route first calls
--     `svc.auth.admin.inviteUserByEmail(...)` and then calls this RPC
--     against the caller's session. On RPC failure, the route calls
--     `svc.auth.admin.deleteUser(...)` to clean up the orphan.
--   * `fn_change_user_role`: wipes all user_roles rows for `p_user_id`
--     then inserts the new row. This enforces the single-role-per-user
--     MVP convention (see CLAUDE.md notes). Multi-scope org_manager is
--     a future extension and requires revisiting both the RPC body and
--     the Role tab UI.
--   * BEFORE DELETE trigger on user_roles:
--       - Self-revocation guard: raises 42501 if OLD.user_id = auth.uid().
--       - Last-super_admin guard: raises 40000 if deleting the last
--         super_admin.
--     Living in a trigger means these guards fire for ANY path into
--     user_roles deletion — the role-change RPC, future routes, or
--     direct SQL. auth.uid() inside the trigger evaluates against the
--     session of whoever issued the DELETE; the route MUST use the
--     user-bound client for DELETE /api/users/[id] (NOT the service-role
--     client — service-role has auth.uid() = NULL).

-- ── fn_finalize_user_invitation ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION fn_finalize_user_invitation(
  p_user_id    UUID,
  p_first_name TEXT,
  p_last_name  TEXT,
  p_phone      TEXT,
  p_role       user_role,
  p_scope_id   UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- 1) Caller must have any role row (i.e. be logged into MBE) — otherwise
  --    is_super_admin() / user_can_access_org() would both be false below
  --    and every branch surfaces as 42501. Spell it out for a clean error.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.'
      USING ERRCODE = '42501';
  END IF;

  -- 2) Role-specific permission checks.
  IF p_role = 'super_admin' THEN
    IF NOT is_super_admin() THEN
      RAISE EXCEPTION 'Only super admins can invite super admins.'
        USING ERRCODE = '42501';
    END IF;
    IF p_scope_id IS NOT NULL THEN
      RAISE EXCEPTION 'super_admin roles must have NULL scope_id.'
        USING ERRCODE = '22023';
    END IF;
  ELSIF p_role = 'org_manager' THEN
    IF p_scope_id IS NULL THEN
      RAISE EXCEPTION 'org_manager invitations require a scope_id (org).'
        USING ERRCODE = '22023';
    END IF;
    IF NOT user_can_access_org(p_scope_id) THEN
      RAISE EXCEPTION 'You do not have permission to invite into this organization.'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported role: %', p_role
      USING ERRCODE = '22023';
  END IF;

  -- 3) Insert the profile (idempotent-ish: if the row already exists from
  --    a prior partial invite, UPDATE the fields rather than failing).
  INSERT INTO user_profiles (user_id, first_name, last_name, phone)
    VALUES (p_user_id, p_first_name, p_last_name, p_phone)
    ON CONFLICT (user_id) DO UPDATE
      SET first_name = EXCLUDED.first_name,
          last_name  = EXCLUDED.last_name,
          phone      = EXCLUDED.phone;

  -- 4) Insert the role. scope_type is always 'org' in MVP — the enum
  --    only has one value (see 00001_schema.sql). A future
  --    microgrid_manager rollout introduces 'microgrid' and re-adds a
  --    p_scope_type parameter.
  INSERT INTO user_roles (user_id, role, scope_type, scope_id)
    VALUES (
      p_user_id,
      p_role,
      'org',
      p_scope_id
    );
END;
$$;

-- ── fn_change_user_role ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION fn_change_user_role(
  p_user_id  UUID,
  p_role     user_role,
  p_scope_id UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.'
      USING ERRCODE = '42501';
  END IF;

  -- Belt-and-suspenders self-targeting guard. The BEFORE DELETE trigger on
  -- user_roles catches self-revocation, but that guard fires at the DELETE
  -- stage — after the permission checks. Raising here gives a cleaner,
  -- earlier error and matches the fn_finalize_user_invitation pattern of
  -- rejecting self-targeted mutations at the RPC boundary.
  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot revoke your own access. Ask another administrator.'
      USING ERRCODE = '42501';
  END IF;

  -- Permission checks mirror the invite RPC.
  IF p_role = 'super_admin' THEN
    IF NOT is_super_admin() THEN
      RAISE EXCEPTION 'Only super admins can assign super_admin.'
        USING ERRCODE = '42501';
    END IF;
    IF p_scope_id IS NOT NULL THEN
      RAISE EXCEPTION 'super_admin roles must have NULL scope_id.'
        USING ERRCODE = '22023';
    END IF;
  ELSIF p_role = 'org_manager' THEN
    IF p_scope_id IS NULL THEN
      RAISE EXCEPTION 'org_manager requires a scope_id (org).'
        USING ERRCODE = '22023';
    END IF;
    IF NOT user_can_access_org(p_scope_id) THEN
      RAISE EXCEPTION 'You do not have permission to assign this organization.'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported role: %', p_role
      USING ERRCODE = '22023';
  END IF;

  -- Atomic DELETE + INSERT.
  -- The DELETE will fire the BEFORE DELETE trigger for EACH row removed
  -- — self-revocation and last-super_admin guards apply here too. A caller
  -- trying to demote the last super_admin (even via this RPC) will be
  -- blocked by the trigger.
  DELETE FROM user_roles WHERE user_id = p_user_id;

  INSERT INTO user_roles (user_id, role, scope_type, scope_id)
    VALUES (p_user_id, p_role, 'org', p_scope_id);
END;
$$;

-- ── BEFORE DELETE trigger: self-revoke + last-super_admin guards ─────────

CREATE OR REPLACE FUNCTION fn_user_roles_before_delete_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_remaining INT;
  v_session_role TEXT;
BEGIN
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

CREATE TRIGGER trg_user_roles_before_delete_guard
  BEFORE DELETE ON user_roles
  FOR EACH ROW
  EXECUTE FUNCTION fn_user_roles_before_delete_guard();

-- ── Additional user_roles RLS policy for org_manager DELETE ──────────────
--
-- The base "Super admins can manage all user_roles" (FOR ALL) policy from
-- 00002_rls.sql lets super_admins revoke any user. But the MVP permission
-- model also lets org_managers revoke users scoped to orgs they manage.
-- RLS has no DELETE-only policy for org_managers by default. Add one.
--
-- USING is evaluated against the row BEFORE deletion, so we can read
-- OLD.scope_id via the policy's NEW/OLD-less USING expression (simply
-- `scope_id` — Postgres treats it as the row being considered).
-- user_can_access_org() returns true for org_managers who have that scope.
--
-- For the DELETE to succeed, the BEFORE DELETE trigger (above) then also
-- fires — that's where the self-revoke / last-super_admin guards live.
CREATE POLICY "Org managers can delete user_roles in their orgs"
  ON user_roles FOR DELETE
  USING (
    scope_type = 'org'
    AND scope_id IS NOT NULL
    AND user_can_access_org(scope_id)
  );
