-- 00049_ems_secret_decrypt_service_role_only.sql
-- Narrow the EMS secret decrypt surface to service_role.
--
-- See CLAUDE.md § "Migration conventions — SECURITY DEFINER grants".
--
-- ── What changed in the application ──────────────────────────────────────
--
-- The EMS secret decrypt now runs on the service-role client
-- (`src/lib/supabase/service.ts`) rather than the caller's cookie-scoped SSR
-- client. Authorization is performed ahead of it, by an RLS-evaluated read of
-- the `microgrids` row on the caller's own client — see
-- `getEmsSecretForMicrogrid` in `src/lib/openems/config.ts`, which owns that
-- ordering for every caller.
--
-- With no application path left that decrypts as `authenticated`, the
-- `authenticated` EXECUTE grants below are no longer load-bearing and are
-- withdrawn so the grants match the code.
--
-- ── Ordering invariant this migration depends on ─────────────────────────
--
-- `fn_get_ems_secret` short-circuits its permission gate for `service_role`,
-- so on the service-role path the function contributes no authorization of
-- its own. The RLS row read in `getEmsSecretForMicrogrid` step 1 is the only
-- authorization, and "no row" is terminal — it returns before the service
-- client is constructed. Reordering those two steps would leave the decrypt
-- ungated. Regression coverage:
-- `src/lib/openems/__tests__/config.test.ts` ("cross-org caller cannot reach
-- the decrypt").
--
-- ── Scope ────────────────────────────────────────────────────────────────
--
--   fn_get_ems_secret(UUID)       — microgrid-level accessor.
--   fn_ems_decrypt_secret(BYTEA)  — the underlying decrypt primitive.
--
-- Both are withdrawn together. Withdrawing only the accessor would leave the
-- primitive as an equivalent entry point, since the ciphertext column is
-- selectable by anyone RLS admits to the `microgrids` row. No application
-- code calls `fn_ems_decrypt_secret` as `authenticated`: it is invoked from
-- inside SECURITY DEFINER bodies (which execute as the function owner) and
-- from service-role contexts.
--
-- `fn_ems_encrypt_secret(TEXT)` KEEPS its `authenticated` grant — the Save
-- flow in `src/app/api/microgrids/[id]/openems-backend/route.ts` encrypts on
-- the user-bound client, and encryption releases nothing.
--
-- `anon` / `PUBLIC` were already revoked in 00047; the clauses are re-issued
-- here so this migration is self-contained and idempotent regardless of the
-- order it is applied in.
--
-- ── PostgREST surface after this migration ───────────────────────────────
--
-- Per CLAUDE.md, a post-hoc REVOKE on a pre-existing function surfaces as
-- either `401 / 42501` or `404 / PGRST202` depending on schema-cache state.
-- Tests asserting denial must accept both shapes.

REVOKE EXECUTE ON FUNCTION public.fn_get_ems_secret(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_get_ems_secret(UUID)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.fn_ems_decrypt_secret(BYTEA)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ems_decrypt_secret(BYTEA)
  TO service_role;

-- Ask PostgREST to reload its schema cache so the narrowed grants take
-- effect on the REST surface without waiting for a restart.
NOTIFY pgrst, 'reload schema';
