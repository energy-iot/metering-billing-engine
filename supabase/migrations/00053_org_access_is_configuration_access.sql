-- 00053_org_access_is_configuration_access.sql
-- #321, migration A of two.
--
-- The rule, stated by the operator:
--
--   "An org manager can configure OpenEMS on any microgrid in their own org,
--    and on nothing else."
--
-- That is `user_can_access_microgrid` exactly, and it predates #316. The
-- microgrid-scoped `ems_operator` grant added a second concept to express a
-- rule the schema already had, and left a newly-created org manager unable to
-- configure anything until someone granted them each microgrid by hand.
--
-- What 00052 got right and this migration keeps: write enforcement lives in a
-- BEFORE UPDATE trigger on the config columns rather than in the app. That
-- survives unchanged here because it calls a predicate rather than a role —
-- only the predicate moves.
--
-- ── Deploy ordering: this migration lands BEFORE the app change ──────────
--
-- `currentUserCanConfigureEms` does `if (error) return false`. Dropping
-- `user_can_configure_ems` while the deployed code still calls it would make
-- every caller return false — the configuration surface goes read-only for
-- every user including super admins, at every call site, with nothing logged
-- and nothing 500ing. It would read as a deliberate permissions decision.
--
-- So this migration KEEPS `user_can_configure_ems` as a thin alias for
-- `user_can_access_microgrid`. Deployed code keeps working through it
-- unchanged. The app change drops the call sites; migration B (a follow-up)
-- drops the alias once nothing calls it.
--
-- The previous migration in this area needed the opposite order, because it
-- removed a grant the old code relied on. "We did it the other way last time"
-- is the reasoning that gets this wrong.
--
-- Contents:
--   1. user_can_configure_ems() → thin alias (CREATE OR REPLACE, grants kept)
--   2. Guard trigger repointed at user_can_access_microgrid + anon revoke
--   3. Creator auto-grant trigger dropped (created_by column kept)
--   4. fn_list_ems_operators → org managers of the microgrid's parent org
--   5. Existing ems_operator rows deleted
--
-- Permanent residue, out of reach of any migration: the `ems_operator` and
-- `microgrid` enum values. `ALTER TYPE … ADD VALUE` cannot be undone; removing
-- them would mean recreating both types and rewriting every dependent column.
-- Inert once nothing references them, which is what this migration achieves.
--
-- Idempotent throughout (guarded DROPs, CREATE OR REPLACE): migration tracking
-- can disagree with actual database state, so we cannot guarantee this file is
-- applied exactly once. House convention — 00015, 00018-00021, 00052.


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. user_can_configure_ems(): a thin alias, not a rename
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every property below is load-bearing, because the caller does
-- `if (error) return false` and does not distinguish "no such function" from
-- "permission denied" — both surface as *nobody can configure anything,
-- nothing logged*. The alias exists to prevent exactly that outcome, and
-- getting any one of these wrong reproduces it:
--
--   • same signature `(uuid)` and same return type BOOLEAN — a changed
--     signature is a missing function to PostgREST;
--   • SECURITY DEFINER — callers invoke it as `authenticated` over PostgREST
--     and the helper it wraps is SECURITY DEFINER for the same reason;
--   • SET search_path, consistent with the other helpers (00048);
--   • its grants. CREATE OR REPLACE preserves privileges; DROP + CREATE does
--     not, and a dropped-and-recreated alias would silently lose its grant to
--     `authenticated`. The re-GRANT below is belt-and-braces, so the end state
--     is explicit rather than inherited.
--
-- Verified against pg_proc after apply — signature, return type, prosecdef and
-- the ACL — not against this file's text and not against the tracking table.
CREATE OR REPLACE FUNCTION public.user_can_configure_ems(_microgrid_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT user_can_access_microgrid(_microgrid_id);
$$;

COMMENT ON FUNCTION public.user_can_configure_ems(UUID) IS
  'DEPRECATED (#321): thin alias for user_can_access_microgrid. Kept only so '
  'code deployed before #321 keeps working; dropped by the follow-up migration '
  'once no caller remains. New code must call user_can_access_microgrid.';

REVOKE EXECUTE ON FUNCTION public.user_can_configure_ems(UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.user_can_configure_ems(UUID) TO authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Guard trigger: repointed at user_can_access_microgrid
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Unchanged from 00052 and deliberately so: the guarded column set is still
-- the six config columns enumerated literally (NOT the four
-- ems_last_discover_* health columns, which Discover writes on the user
-- client); both the `UPDATE OF` statement-level filter and the per-column
-- `IS DISTINCT FROM` value-level checks are retained; service_role and the
-- migration/seed session users stay exempt. See 00052 § 4 for why each of
-- those is the way it is — none of that reasoning depends on which predicate
-- the check calls.
--
-- What changed is one line: `user_can_configure_ems(NEW.id)` →
-- `user_can_access_microgrid(NEW.id)`. Chaining through the org helper is now
-- the intent rather than the hazard — see the note at the top of this file and
-- the superseded-comment markers in 00052.
--
-- is_super_admin() short-circuits inside user_can_access_microgrid, so support
-- and rollout paths keep working.
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
    IF NOT user_can_access_microgrid(NEW.id) THEN
      RAISE EXCEPTION
        'You do not have permission to configure the OpenEMS connection for this microgrid.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- The trigger definition is unchanged, but re-issued so a database that
-- somehow lost it converges. DROP … IF EXISTS keeps the file re-runnable.
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

-- This function was created in 00052 WITHOUT a revoke and therefore took the
-- PUBLIC default, which on this database resolves to an EXECUTE grant that
-- reaches `anon`. It predates this ticket; nothing else here would clear it,
-- and 00052 is already applied so amending that file would not.
--
-- Inert in practice — PostgREST does not expose trigger-returning functions,
-- and this one is SECURITY INVOKER so a caller holding EXECUTE gains nothing
-- they could not already do. It is still a grant nobody chose, on the function
-- that enforces the configuration boundary.
--
-- Revoking from PUBLIC also removes `authenticated`'s inherited access, which
-- is correct and safe: trigger functions are resolved and executed by the
-- trigger machinery, and EXECUTE is checked at CREATE TRIGGER time rather than
-- at fire time.
--
-- Same pattern as 00047 § 2d. The half that transfers is "regardless of EXECUTE
-- grants" — true of any trigger function. § 2d's other half, "fires with the
-- function-owner's privileges", is a SECURITY DEFINER property; this function is
-- SECURITY INVOKER and fires as the caller.
--
-- Statement order in this section — function, then trigger, then revoke — is
-- safe to change only while migrations apply as the function's owner: REVOKE …
-- FROM PUBLIC leaves owner rights intact, and CREATE TRIGGER requires EXECUTE on
-- the function. An applier that is not the owner and revokes first fails at
-- CREATE TRIGGER. If this repo ever applies migrations as a non-owner role,
-- revisit the order here.
REVOKE EXECUTE ON FUNCTION public.fn_microgrids_guard_ems_config() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_microgrids_guard_ems_config() TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Creator auto-grant: dropped. The created_by column stays.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The auto-grant existed to make the per-microgrid grant self-serve. With no
-- per-microgrid grant there is nothing to hand out: the creator is an org
-- manager on the org they created the microgrid in, so they can already
-- configure it.
--
-- `microgrids.created_by` is kept. It is independently useful and is the only
-- record of who stood a microgrid up.
DROP TRIGGER   IF EXISTS trg_microgrids_grant_creator_ems_operator ON public.microgrids;
DROP FUNCTION  IF EXISTS public.fn_microgrids_grant_creator_ems_operator();


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. fn_list_ems_operators: org managers of the microgrid's parent org
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Rewritten rather than deleted. The surface is arguably MORE useful under the
-- simpler rule, because "who can configure this" stops being self-evident.
--
-- Left alone it would be wrong in both directions: keeping the old rows lists
-- exactly the people granted historically (correct by coincidence, wrong the
-- moment another org manager is added), and deleting them — which § 5 does —
-- leaves it showing nobody on a microgrid several people can configure.
--
-- Name and shape are unchanged on purpose: same identity arguments (UUID),
-- same two-column return type, so CREATE OR REPLACE applies, PostgREST
-- resolution is unaffected, and the page rendering it needs no migration-
-- ordered change. The name now reads as a role that no longer exists; renaming
-- it is a separate, app-coordinated change and not worth a second deploy
-- window here.
--
-- Everything below is inherited from 00052 § 7 and still holds:
--   • SECURITY DEFINER, because the user_roles SELECT policy is self-only for
--     non-super_admins and widening it would expose the org's entire role
--     graph. A version reading user_roles under the current policy would show
--     a super_admin the real list and everyone else a shorter one that looks
--     authoritative.
--   • `user_can_access_microgrid(_microgrid_id)` in the WHERE clause is the
--     only gate: this is a directly-callable PostgREST endpoint the moment it
--     is granted to `authenticated`, so it must hold on its own. It returns
--     zero rows for a microgrid the caller cannot access.
--   • The projection is exactly what the surface renders — a single resolved
--     display_name. The COALESCE fallback to the address must not be dropped:
--     both user_profiles name columns are nullable, and an
--     invited-but-incomplete user would otherwise render as a blank entry in a
--     list whose entire purpose is naming who can configure.
--
-- super_admins are deliberately NOT listed. They can configure every
-- microgrid, so listing them everywhere would be noise; the surface's copy
-- names them separately ("plus super admins"). Unchanged from 00052, which
-- listed grant-holders and not super_admins for the same reason.
CREATE OR REPLACE FUNCTION public.fn_list_ems_operators(_microgrid_id UUID)
RETURNS TABLE (
  user_id      UUID,
  display_name TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    ur.user_id,
    COALESCE(
      NULLIF(TRIM(CONCAT_WS(' ', up.first_name, up.last_name)), ''),
      au.email
    )::TEXT AS display_name
  FROM microgrids m
  JOIN communities c   ON c.id = m.community_id
  JOIN user_roles  ur  ON ur.role = 'org_manager'
                      AND ur.scope_type = 'org'
                      AND ur.scope_id = c.org_id
  JOIN auth.users  au  ON au.id = ur.user_id
  LEFT JOIN user_profiles up ON up.user_id = ur.user_id
  WHERE user_can_access_microgrid(_microgrid_id)
    AND m.id = _microgrid_id
  ORDER BY 2, au.email;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_list_ems_operators(UUID) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_list_ems_operators(UUID) TO authenticated, service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. Delete the ems_operator rows
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Nothing reads them after § 1, § 2 and § 4. Left in place they would be a
-- role graph that looks like it grants something and does not — the kind of
-- residue that gets read as authoritative during an incident.
--
-- Safe with respect to configuration access: everyone who held one of these
-- grants held it on a microgrid in an org they manage, and now reaches the
-- same microgrid through user_can_access_microgrid.
DELETE FROM public.user_roles WHERE role = 'ems_operator';
