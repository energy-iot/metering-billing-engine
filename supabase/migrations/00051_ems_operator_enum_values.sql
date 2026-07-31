-- 00051_ems_operator_enum_values.sql
-- #316 part 1 of 2: add the enum values for the microgrid-scoped OpenEMS
-- configuration role.
--
-- ── Why this is a separate migration from 00052 ──────────────────────────
--
-- Postgres refuses to *use* a new enum value in the same transaction that
-- added it ("unsafe use of new value ... of enum type"). 00052 both compares
-- against `'ems_operator'` / `'microgrid'` in function bodies and pins them in
-- a CHECK constraint, so the ADD VALUE statements cannot live there.
--
-- Splitting is safe here specifically because these two statements are inert
-- on their own: nothing can be granted `ems_operator` until 00052 installs the
-- RPC path and the FK that a microgrid-scoped row needs. Running 00051 without
-- 00052 leaves the schema exactly as it behaves today.
--
-- Idempotent: `IF NOT EXISTS` makes both statements re-runnable, which matters
-- because migration tracking can diverge from actual database state.

ALTER TYPE public.user_role       ADD VALUE IF NOT EXISTS 'ems_operator';
ALTER TYPE public.role_scope_type ADD VALUE IF NOT EXISTS 'microgrid';
