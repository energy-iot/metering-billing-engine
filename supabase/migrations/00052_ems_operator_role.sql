-- 00052_ems_operator_role.sql
-- #316 part 2 of 2: microgrid-scoped OpenEMS configuration role.
--
-- Goal: an operator can configure OpenEMS on the microgrids they hold a grant
-- on, and only those. Today the only options are a super_admin app-layer gate
-- (nobody self-serves) or org-wide access (every org_manager can rewrite every
-- microgrid's stored cloud credentials).
--
-- ── Why a trigger and not a policy ───────────────────────────────────────
--
-- RLS is row-level. The `ems_*` columns live on `microgrids`, which has a
-- single FOR ALL policy gated on `user_can_access_microgrid` (00002_rls.sql).
-- A policy cannot say "may update this row, but not these columns", and column
-- privileges are granted to the `authenticated` role rather than per user.
-- So write enforcement is a BEFORE UPDATE trigger.
--
-- ── Why a new role value and not org_manager-at-microgrid-scope ──────────
--
-- `user_can_access_org` / `user_can_access_microgrid` carry 23 of the 30
-- policies in this schema, all FOR ALL, so read and write move together on
-- every one of them. Changing what those helpers mean would widen access
-- silently rather than fail visibly. A separate role value with its own helper
-- touches zero existing policies.
--
-- Contents:
--   1. user_roles: per-scope-type FKs + role-aware CHECK
--   2. microgrids.created_by + creator auto-grant
--   3. user_can_configure_ems() helper
--   4. BEFORE UPDATE trigger on the six ems_* config columns
--   5. fn_change_user_role: scope-aware, non-destructive
--   6. fn_list_visible_users: one row per user
--   7. fn_list_ems_operators: attributability surface
--
-- Idempotent throughout (guarded DROPs, CREATE OR REPLACE, IF NOT EXISTS):
-- migration tracking can disagree with actual database state, so we cannot
-- guarantee this file is applied exactly once. House convention — 00015,
-- 00018-00021 all do this.


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. user_roles: replace the single scope FK with per-scope-type FKs
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `user_roles_scope_org_fkey` (00015_entity_deletion_safeguards.sql) points
-- `scope_id` at `organizations.id`. An `ems_operator` row carries a microgrid
-- id there, so the insert fails against it.
--
-- Dropping the constraint would make the insert succeed while silently
-- regressing what an entity-deletion-safeguards migration exists to protect.
-- 00015's own header anticipated this and named per-scope-type FKs as the
-- replacement. That is what this does.
--
-- ── Why the new columns are GENERATED rather than plain ──────────────────
--
-- `scope_id` keeps its meaning and stays the single written column. The two
-- new columns are STORED generated projections of it, each carrying a real FK
-- with ON DELETE CASCADE. Referential integrity is enforced per scope type and
-- cascade still works, but nothing that reads `scope_id` has to change:
-- `user_can_access_org`, `user_can_see_user_profile`, the "Org managers can
-- delete user_roles in their orgs" policy (00013), `fn_list_visible_users` and
-- the app's `user_roles` reads all continue to mean what they meant.
--
-- That matters because the failure mode on this table is asymmetric: a helper
-- returning false is a visible lockout, but one returning true against a
-- column that no longer holds what it thinks is a silent widening — the exact
-- class of bug this migration exists to fix. Not rewriting the column the
-- helpers read removes that risk rather than managing it.
--
-- Verified on Postgres 15: ON DELETE CASCADE is permitted on a generated
-- column (only SET NULL / SET DEFAULT are rejected).

ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS scope_org_id UUID
    GENERATED ALWAYS AS (CASE WHEN scope_type = 'org' THEN scope_id END) STORED;

ALTER TABLE public.user_roles
  ADD COLUMN IF NOT EXISTS scope_microgrid_id UUID
    GENERATED ALWAYS AS (CASE WHEN scope_type = 'microgrid' THEN scope_id END) STORED;

-- Defensive orphan cleanup, mirroring 00015 step 1. Deletes zero rows after
-- the first run.
DELETE FROM public.user_roles
 WHERE scope_type = 'org'
   AND scope_id IS NOT NULL
   AND scope_id NOT IN (SELECT id FROM public.organizations);

-- Re-point the org FK at the org-only projection. The old constraint name is
-- reused so a re-run (or a database where 00015 applied but this file's record
-- did not) converges on the same end state.
ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_scope_org_fkey;
ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_scope_org_fkey
  FOREIGN KEY (scope_org_id)
  REFERENCES public.organizations(id)
  ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE;

ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_scope_microgrid_fkey;
ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_scope_microgrid_fkey
  FOREIGN KEY (scope_microgrid_id)
  REFERENCES public.microgrids(id)
  ON DELETE CASCADE
  DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS idx_user_roles_scope_microgrid_id
  ON public.user_roles(scope_microgrid_id);

-- Role-aware pairing of role to scope_type.
--
-- Written role-aware on purpose: existing `super_admin` rows carry
-- scope_type = 'org' with a NULL scope_id, so a naive
-- "scope_type='org' implies scope_org_id IS NOT NULL" rejects them at
-- migration time. Keeping super_admin on the 'org' scope type also avoids
-- inventing a third scope type for it, which would be a wider change than
-- this needs.
--
-- The pre-existing `user_roles_scope_id_requires_non_super_admin` CHECK
-- (00001_schema.sql) is left in place and still holds: ems_operator rows
-- always carry a non-NULL scope_id.
ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_role_scope_type_consistent;
ALTER TABLE public.user_roles
  ADD CONSTRAINT user_roles_role_scope_type_consistent CHECK (
    CASE role
      WHEN 'super_admin'  THEN scope_type = 'org'
      WHEN 'org_manager'  THEN scope_type = 'org'       AND scope_id IS NOT NULL
      WHEN 'ems_operator' THEN scope_type = 'microgrid' AND scope_id IS NOT NULL
    END
  );


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. microgrids.created_by + creator auto-grant
-- ═══════════════════════════════════════════════════════════════════════════
--
-- What makes this self-serve without putting a grant UI on the critical path:
-- every microgrid an operator stands up, they configure — and they cannot
-- reach one they did not create.
--
-- ── Backfill grants nobody. This is a decision, not an omission. ─────────
--
-- Granting existing microgrids to their org's managers would deliver exactly
-- the org-wide configuration access this migration exists to prevent, and it
-- would arrive as a side effect of a schema change. Existing microgrids get
-- their operator through the explicit super_admin grant path in section 5,
-- which is one audited action per grant.

ALTER TABLE public.microgrids
  ADD COLUMN IF NOT EXISTS created_by UUID DEFAULT auth.uid()
    REFERENCES auth.users(id) ON DELETE SET NULL;

-- SECURITY DEFINER owned by `postgres`: the insert has to bypass the
-- user_roles RLS policies (a non-super_admin cannot write user_roles), the
-- same way fn_change_user_role does.
--
-- Fires only when created_by is populated. Service-role and API-token inserts
-- run with a NULL auth.uid() and therefore grant nobody — correct, since there
-- is no human creator to attribute in those paths.
CREATE OR REPLACE FUNCTION public.fn_microgrids_grant_creator_ems_operator()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.created_by IS NOT NULL THEN
    INSERT INTO user_roles (user_id, role, scope_type, scope_id)
    VALUES (NEW.created_by, 'ems_operator', 'microgrid', NEW.id)
    ON CONFLICT (user_id, role, scope_type, scope_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_microgrids_grant_creator_ems_operator ON public.microgrids;
CREATE TRIGGER trg_microgrids_grant_creator_ems_operator
  AFTER INSERT ON public.microgrids
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_microgrids_grant_creator_ems_operator();


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. user_can_configure_ems()
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Shape mirrors is_super_admin() / user_can_access_org() in 00002_rls.sql:
-- SECURITY DEFINER, STABLE, pinned search_path.
--
-- Deliberately NOT chained through user_can_access_microgrid: org access is
-- not configuration access, and conflating them is the widening this ticket
-- exists to prevent. super_admin is included so rollout and support paths work
-- — if the super_admin short-circuit in is_super_admin() is ever narrowed,
-- revisit this.
--
-- Cheap to call from a route despite user_roles SELECT being self-only: a
-- caller checking their own grant is reading their own rows, which the
-- "Users can view their own roles" policy permits.
CREATE OR REPLACE FUNCTION public.user_can_configure_ems(_microgrid_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    is_super_admin()
    OR EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_id = auth.uid()
        AND role = 'ems_operator'
        AND scope_type = 'microgrid'
        AND scope_id = _microgrid_id
    );
$$;

REVOKE EXECUTE ON FUNCTION public.user_can_configure_ems(UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.user_can_configure_ems(UUID) TO authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Write enforcement: BEFORE UPDATE trigger on the six config columns
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Note the asymmetry, because it is easy to misread: WRITES are enforced here,
-- at the database. READS are enforced in the route (see
-- src/lib/openems/config.ts and the openems-backend routes) — there is no
-- read-side equivalent of this trigger.
--
-- ── The guarded set is exactly six columns, enumerated literally ─────────
--
--   ems_type, ems_backend_url, ems_aws_region, ems_aws_access_key_id,
--   ems_aws_secret_access_key_encrypted, ems_known_edge_ids
--
-- NOT the four ems_last_discover_* health columns. Discover writes those on
-- the *user* client after the call completes
-- (src/app/api/microgrids/[id]/openems-backend/discover/route.ts), so guarding
-- them would break Discover for every non-operator who can legitimately run
-- it. No prefix matching and no information_schema loop: a rule that says
-- "columns starting with ems_" would silently absorb the health columns and
-- any ems_* column added later.
--
-- ── Both mechanisms, on purpose ──────────────────────────────────────────
--
-- `BEFORE UPDATE OF <six>` is the statement-level filter: the trigger does not
-- fire at all for an UPDATE that does not mention those columns. The per-column
-- `IS DISTINCT FROM` checks inside the function are the value-level filter, so
-- a statement that *mentions* a guarded column but does not change its value is
-- allowed through. `UPDATE OF` alone is only accidentally sufficient today —
-- it keys off the columns named in the statement, not the values, and ORMs and
-- hand-written PATCH handlers routinely resend unchanged fields.
--
-- ── Why service_role is exempt ───────────────────────────────────────────
--
-- service_role already bypasses RLS and can write these columns today. This
-- trigger is a NEW restriction; exempting service_role declines to add one
-- there, rather than removing protection that existed. Server-side remediation
-- paths that legitimately need to write a credential keep working, and that is
-- decided here rather than discovered during an incident.
--
-- session_user is bypassed for the same reason the user_roles delete guard
-- bypasses it (00013): `postgres` / `supabase_admin` are migration tooling,
-- seed and test-harness paths that already have full database access.
CREATE OR REPLACE FUNCTION public.fn_microgrids_guard_ems_config()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF session_user IN ('postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF (NEW.ems_type                            IS DISTINCT FROM OLD.ems_type)
     OR (NEW.ems_backend_url                  IS DISTINCT FROM OLD.ems_backend_url)
     OR (NEW.ems_aws_region                   IS DISTINCT FROM OLD.ems_aws_region)
     OR (NEW.ems_aws_access_key_id            IS DISTINCT FROM OLD.ems_aws_access_key_id)
     OR (NEW.ems_aws_secret_access_key_encrypted
                                              IS DISTINCT FROM OLD.ems_aws_secret_access_key_encrypted)
     OR (NEW.ems_known_edge_ids               IS DISTINCT FROM OLD.ems_known_edge_ids)
  THEN
    IF NOT user_can_configure_ems(NEW.id) THEN
      RAISE EXCEPTION
        'You do not have permission to configure the OpenEMS connection for this microgrid.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_microgrids_guard_ems_config ON public.microgrids;
CREATE TRIGGER trg_microgrids_guard_ems_config
  BEFORE UPDATE OF
    ems_type,
    ems_backend_url,
    ems_aws_region,
    ems_aws_access_key_id,
    ems_aws_secret_access_key_encrypted,
    ems_known_edge_ids
  ON public.microgrids
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_microgrids_guard_ems_config();


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. fn_change_user_role: scope-aware and non-destructive
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The previous body ran `DELETE FROM user_roles WHERE user_id = p_user_id`
-- and then inserted one row with scope_type hardcoded to 'org'. That was
-- correct only under a one-row-per-user invariant that this migration removes:
-- unchanged, an ordinary org-role edit would silently delete every
-- ems_operator grant the target holds, with no warning at the point of action
-- and no self-service recovery.
--
-- The DELETE is now scoped to the scope_type being changed, so editing an org
-- role touches only org rows. The table was already built for this —
-- UNIQUE (user_id, role, scope_type, scope_id) is tuple uniqueness, and every
-- RLS helper reads through EXISTS(...), which is multi-row-safe. The
-- constraint was confined to this one function.
--
-- Signature gains p_scope_type. DROP + CREATE rather than CREATE OR REPLACE:
-- adding a parameter would otherwise leave both overloads resolvable and make
-- PostgREST calls ambiguous.

DROP FUNCTION IF EXISTS public.fn_change_user_role(UUID, public.user_role, UUID);

CREATE OR REPLACE FUNCTION public.fn_change_user_role(
  p_user_id    UUID,
  p_role       public.user_role,
  p_scope_id   UUID DEFAULT NULL,
  p_scope_type public.role_scope_type DEFAULT 'org'
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

  -- Self-targeting guard, unchanged in intent but now limited to the org
  -- path. That path is destructive (it replaces the caller's own org role and
  -- can lock them out); a microgrid grant is purely additive and carries no
  -- self-lockout risk.
  IF p_user_id = auth.uid() AND p_scope_type = 'org' THEN
    RAISE EXCEPTION 'Cannot revoke your own access. Ask another administrator.'
      USING ERRCODE = '42501';
  END IF;

  IF p_role = 'super_admin' THEN
    IF NOT is_super_admin() THEN
      RAISE EXCEPTION 'Only super admins can assign super_admin.'
        USING ERRCODE = '42501';
    END IF;
    IF p_scope_type <> 'org' THEN
      RAISE EXCEPTION 'super_admin roles must use the org scope type.'
        USING ERRCODE = '22023';
    END IF;
    IF p_scope_id IS NOT NULL THEN
      RAISE EXCEPTION 'super_admin roles must have NULL scope_id.'
        USING ERRCODE = '22023';
    END IF;

  ELSIF p_role = 'org_manager' THEN
    IF p_scope_type <> 'org' THEN
      RAISE EXCEPTION 'org_manager roles must use the org scope type.'
        USING ERRCODE = '22023';
    END IF;
    IF p_scope_id IS NULL THEN
      RAISE EXCEPTION 'org_manager requires a scope_id (org).'
        USING ERRCODE = '22023';
    END IF;
    IF NOT user_can_access_org(p_scope_id) THEN
      RAISE EXCEPTION 'You do not have permission to assign this organization.'
        USING ERRCODE = '42501';
    END IF;

  ELSIF p_role = 'ems_operator' THEN
    -- The rollout grant. Existing microgrids have no creator, so nobody holds
    -- the grant on them; a super_admin grants explicitly rather than the
    -- migration inferring an owner from data that does not carry one.
    --
    -- Restricted to super_admin because the general grant-management surface
    -- is out of scope for #316 — widen this when someone needs access to a
    -- microgrid they did not create.
    IF NOT is_super_admin() THEN
      RAISE EXCEPTION 'Only super admins can assign ems_operator.'
        USING ERRCODE = '42501';
    END IF;
    IF p_scope_type <> 'microgrid' THEN
      RAISE EXCEPTION 'ems_operator roles must use the microgrid scope type.'
        USING ERRCODE = '22023';
    END IF;
    IF p_scope_id IS NULL THEN
      RAISE EXCEPTION 'ems_operator requires a scope_id (microgrid).'
        USING ERRCODE = '22023';
    END IF;

  ELSE
    RAISE EXCEPTION 'Unsupported role: %', p_role
      USING ERRCODE = '22023';
  END IF;

  IF p_scope_type = 'org' THEN
    -- Replace the target's org role. Scoped DELETE: microgrid-scoped grants
    -- are not part of what the caller asked to change, so they survive.
    -- The BEFORE DELETE trigger still fires per row, so the self-revocation
    -- and last-super_admin guards continue to apply.
    DELETE FROM user_roles
     WHERE user_id = p_user_id
       AND scope_type = 'org';

    INSERT INTO user_roles (user_id, role, scope_type, scope_id)
      VALUES (p_user_id, p_role, 'org', p_scope_id);
  ELSE
    -- Additive grant. No DELETE at all: granting one microgrid must not
    -- revoke another.
    INSERT INTO user_roles (user_id, role, scope_type, scope_id)
      VALUES (p_user_id, p_role, p_scope_type, p_scope_id)
      ON CONFLICT (user_id, role, scope_type, scope_id) DO NOTHING;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION
  public.fn_change_user_role(UUID, public.user_role, UUID, public.role_scope_type)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.fn_change_user_role(UUID, public.user_role, UUID, public.role_scope_type)
  TO authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. fn_list_visible_users: one row per user
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The previous body was a bare LEFT JOIN onto user_roles with no aggregation,
-- emitting one row per role row. Correct only under the one-row-per-user
-- invariant this migration removes; a user holding two grants would appear
-- twice in the users list, and every row-level action there hangs off those
-- rows.
--
-- The org-scoped role stays in the same three columns it always occupied, so
-- consumers keep their meaning. Multiple grants are summarised as a count
-- rather than expanded — presentation of individual grants is deliberately out
-- of scope for #316.
--
-- Return type changes (new column), so DROP + CREATE; CREATE OR REPLACE
-- cannot alter a function's return type.

DROP FUNCTION IF EXISTS public.fn_list_visible_users(UUID[]);

CREATE OR REPLACE FUNCTION public.fn_list_visible_users(
  _target_user_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (
  user_id            UUID,
  email              TEXT,
  email_confirmed_at TIMESTAMPTZ,
  last_sign_in_at    TIMESTAMPTZ,
  first_name         TEXT,
  last_name          TEXT,
  phone              TEXT,
  role               public.user_role,
  scope_type         public.role_scope_type,
  scope_id           UUID,
  ems_operator_count INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    au.id                        AS user_id,
    au.email::TEXT               AS email,
    au.email_confirmed_at,
    au.last_sign_in_at,
    up.first_name,
    up.last_name,
    up.phone,
    org_role.role,
    org_role.scope_type,
    org_role.scope_id,
    COALESCE(ems.cnt, 0)::INTEGER AS ems_operator_count
  FROM auth.users au
  LEFT JOIN public.user_profiles up ON up.user_id = au.id
  -- At most one org-scoped row per user by construction (fn_change_user_role
  -- replaces rather than appends on the org path). super_admin is ordered
  -- first defensively so a user carrying both surfaces as super_admin, which
  -- is what the users list means by "role".
  LEFT JOIN LATERAL (
    SELECT ur.role, ur.scope_type, ur.scope_id
    FROM public.user_roles ur
    WHERE ur.user_id = au.id
      AND ur.scope_type = 'org'
    ORDER BY (ur.role = 'super_admin') DESC, ur.created_at
    LIMIT 1
  ) org_role ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS cnt
    FROM public.user_roles ur2
    WHERE ur2.user_id = au.id
      AND ur2.role = 'ems_operator'
  ) ems ON TRUE
  WHERE user_can_see_user_profile(au.id)
    AND (_target_user_ids IS NULL OR au.id = ANY(_target_user_ids));
$$;

REVOKE EXECUTE ON FUNCTION public.fn_list_visible_users(UUID[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_list_visible_users(UUID[]) TO authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 7. fn_list_ems_operators: attributability surface
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Surfaced on the OpenEMS Backend screen next to the connection it governs,
-- and referenced by the read-only banner copy ("the people listed below") —
-- if this function stops being rendered there, that copy needs rewriting.
--
-- Routes through this function rather than fn_list_visible_users because
-- `user_can_see_user_profile` filters `scope_type = 'org'` and would omit
-- microgrid-scoped operators; if that filter changes, revisit.
--
-- ── The internal gate is the only gate ───────────────────────────────────
--
-- The moment this is granted to `authenticated` it is a directly-callable
-- PostgREST endpoint, so `user_can_access_microgrid(_microgrid_id)` in the
-- WHERE clause has to hold on its own — it returns zero rows for a microgrid
-- the caller cannot access, rather than relying on any caller-side check.
--
-- SECURITY DEFINER, and deliberately NOT implemented by widening the
-- user_roles SELECT policy: that policy is self-only for non-super_admins
-- (00002_rls.sql), and widening it would expose the org's entire role graph to
-- every org_manager. A version reading user_roles directly under the current
-- policy would show a super_admin the real list and show everyone else a
-- shorter one that looks authoritative — an attributability surface that
-- under-reports is worse than none.
--
-- is_super_admin() short-circuits inside user_can_access_microgrid, so a
-- super_admin viewing another org's microgrid sees the list. Rollout depends
-- on that path.
CREATE OR REPLACE FUNCTION public.fn_list_ems_operators(_microgrid_id UUID)
RETURNS TABLE (
  user_id    UUID,
  first_name TEXT,
  last_name  TEXT,
  email      TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    ur.user_id,
    up.first_name,
    up.last_name,
    au.email::TEXT AS email
  FROM user_roles ur
  JOIN auth.users au ON au.id = ur.user_id
  LEFT JOIN user_profiles up ON up.user_id = ur.user_id
  WHERE user_can_access_microgrid(_microgrid_id)
    AND ur.role = 'ems_operator'
    AND ur.scope_type = 'microgrid'
    AND ur.scope_id = _microgrid_id
  ORDER BY up.first_name NULLS LAST, up.last_name NULLS LAST, au.email;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_list_ems_operators(UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_list_ems_operators(UUID) TO authenticated, service_role;
