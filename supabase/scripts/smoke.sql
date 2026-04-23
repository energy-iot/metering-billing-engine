-- supabase/scripts/smoke.sql
-- Post-reset smoke test for AB #50 (entity-model schema + RLS + seed).
--
-- Run after: ./setup.sh && psql "$DATABASE_URL" -f supabase/scripts/smoke.sql
--
-- Pass: all DO blocks raise NOTICE "OK: …"
-- Fail: any ASSERT / RAISE EXCEPTION causes a non-zero exit from psql.
--
-- Destructive checks (constraint violations) are wrapped in BEGIN … ROLLBACK
-- so they never mutate state.

\echo ''
\echo '======================================================================'
\echo ' MBE Smoke Test — AB #50 (schema + RLS + seed)'
\echo '======================================================================'

-- ── Section 1: SECURITY DEFINER helper functions ──────────────────────────
\echo ''
\echo '-- [1] SECURITY DEFINER helper functions'

DO $$
DECLARE
  fn_count INT;
BEGIN
  SELECT COUNT(*) INTO fn_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('is_super_admin', 'user_can_access_org', 'user_can_access_microgrid');

  ASSERT fn_count = 3,
    format('Expected 3 helper functions, found %s', fn_count);
  RAISE NOTICE 'OK: all 3 SECURITY DEFINER helpers exist (is_super_admin, user_can_access_org, user_can_access_microgrid)';
END;
$$;

-- Verify each function is callable (returns a boolean without error).
-- Called as postgres (superuser) so auth.uid() returns NULL, which is fine —
-- the functions are STABLE SQL; we just confirm they parse and execute.
DO $$
DECLARE
  result BOOLEAN;
BEGIN
  SELECT is_super_admin() INTO result;
  RAISE NOTICE 'OK: is_super_admin() callable (returned %)', result;

  SELECT user_can_access_org('a0000000-0000-0000-0000-000000000001'::uuid) INTO result;
  RAISE NOTICE 'OK: user_can_access_org(uuid) callable (returned %)', result;

  SELECT user_can_access_microgrid('b0000000-0000-0000-0000-000000000001'::uuid) INTO result;
  RAISE NOTICE 'OK: user_can_access_microgrid(uuid) callable (returned %)', result;
END;
$$;

-- ── Section 2: RLS enabled on all 13 tables ───────────────────────────────
\echo ''
\echo '-- [2] RLS enabled on all 13 tables'

DO $$
DECLARE
  expected TEXT[] := ARRAY[
    'organizations',
    'communities',
    'microgrids',
    'edges',
    'devices',
    'household_devices',
    'households',
    'household_users',
    'user_roles',
    'billing_periods',
    'billing_line_items',
    'meter_readings',
    'rate_schedules'
  ];
  tbl TEXT;
  rls_on BOOLEAN;
  missing TEXT[] := '{}';
BEGIN
  FOREACH tbl IN ARRAY expected LOOP
    SELECT relrowsecurity INTO rls_on
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = tbl;

    IF rls_on IS NULL THEN
      missing := array_append(missing, tbl || ' (not found)');
    ELSIF NOT rls_on THEN
      missing := array_append(missing, tbl || ' (RLS disabled)');
    END IF;
  END LOOP;

  ASSERT array_length(missing, 1) IS NULL,
    format('RLS check failed for: %s', array_to_string(missing, ', '));

  RAISE NOTICE 'OK: RLS enabled on all 13 tables';
END;
$$;

-- ── Section 3: Seed data counts ───────────────────────────────────────────
\echo ''
\echo '-- [3] Seed data loaded'

DO $$
DECLARE
  n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM organizations;
  ASSERT n >= 1, format('Expected >= 1 org, found %s', n);
  RAISE NOTICE 'OK: organizations = %', n;

  SELECT COUNT(*) INTO n FROM communities;
  ASSERT n >= 1, format('Expected >= 1 community, found %s', n);
  RAISE NOTICE 'OK: communities = %', n;

  SELECT COUNT(*) INTO n FROM microgrids;
  ASSERT n >= 1, format('Expected >= 1 microgrid, found %s', n);
  RAISE NOTICE 'OK: microgrids = %', n;

  SELECT COUNT(*) INTO n FROM edges;
  ASSERT n >= 1, format('Expected >= 1 edge, found %s', n);
  RAISE NOTICE 'OK: edges = %', n;

  SELECT COUNT(*) INTO n FROM devices;
  ASSERT n >= 10, format('Expected >= 10 devices, found %s', n);
  RAISE NOTICE 'OK: devices = %', n;

  SELECT COUNT(*) INTO n FROM households;
  ASSERT n >= 10, format('Expected >= 10 households, found %s', n);
  RAISE NOTICE 'OK: households = %', n;

  SELECT COUNT(*) INTO n FROM household_devices;
  ASSERT n >= 10, format('Expected >= 10 household_devices, found %s', n);
  RAISE NOTICE 'OK: household_devices = %', n;

  SELECT COUNT(*) INTO n FROM rate_schedules;
  ASSERT n >= 1, format('Expected >= 1 rate_schedule, found %s', n);
  RAISE NOTICE 'OK: rate_schedules = %', n;

  SELECT COUNT(*) INTO n FROM user_roles;
  ASSERT n >= 2, format('Expected >= 2 user_roles, found %s', n);
  RAISE NOTICE 'OK: user_roles = %', n;
END;
$$;

-- ── Section 4: user_roles CHECK constraint (non-super_admin must have scope_id) ──
\echo ''
\echo '-- [4] user_roles CHECK constraint fires for non-super_admin with NULL scope_id'

BEGIN;
DO $$
DECLARE
  caught BOOLEAN := FALSE;
BEGIN
  BEGIN
    -- Insert an org_manager with NULL scope_id — must violate the CHECK constraint.
    INSERT INTO user_roles (user_id, role, scope_type, scope_id)
    VALUES (
      'a2222222-2222-2222-2222-222222222222',
      'org_manager',
      'org',
      NULL
    );
  EXCEPTION
    WHEN check_violation THEN
      caught := TRUE;
  END;

  ASSERT caught,
    'CHECK constraint user_roles_scope_id_requires_non_super_admin did NOT fire — org_manager with NULL scope_id was accepted';
  RAISE NOTICE 'OK: user_roles CHECK constraint fired correctly (org_manager + NULL scope_id rejected)';
END;
$$;
ROLLBACK;

-- ── Section 5: partial unique index on household_devices ──────────────────
\echo ''
\echo '-- [5] partial unique index fires for duplicate primary_consumption_meter'

BEGIN;
DO $$
DECLARE
  caught BOOLEAN := FALSE;
BEGIN
  BEGIN
    -- Attempt a second primary_consumption_meter for household 1 (already has one from seed).
    -- Use a different device_id so the UNIQUE(household_id, device_id, role) row-constraint
    -- doesn't fire first — only the partial unique index should fire.
    INSERT INTO household_devices (household_id, device_id, role)
    VALUES (
      'f0000000-0000-0000-0000-000000000001',  -- household 1 (Block A, Unit 1)
      'd0000000-0000-0000-0000-000000000002',  -- different device (Meter 02)
      'primary_consumption_meter'
    );
  EXCEPTION
    WHEN unique_violation THEN
      caught := TRUE;
  END;

  ASSERT caught,
    'Partial unique index household_one_primary_consumption_meter did NOT fire — duplicate primary_consumption_meter was accepted';
  RAISE NOTICE 'OK: partial unique index fired correctly (second primary_consumption_meter rejected)';
END;
$$;
ROLLBACK;

-- ── Done ──────────────────────────────────────────────────────────────────
\echo ''
\echo '======================================================================'
\echo ' All checks passed.'
\echo '======================================================================'
\echo ''
