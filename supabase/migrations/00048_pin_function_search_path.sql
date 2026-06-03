-- 00048_pin_function_search_path.sql
-- C (#271): pin search_path on 6 functions to clear Supabase linter
-- `function_search_path_mutable` warnings. Mechanical; no behavior change.
--
-- Pattern matches the established RLS-helper convention from
-- 00002_rls.sql (per CLAUDE.md § "RLS helper functions"). The
-- linter wants every function to declare what schemas it resolves
-- unqualified names against; `public, pg_temp` is the safe default
-- for our codebase.

ALTER FUNCTION public.fn_entity_delete_org(UUID)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.fn_entity_delete_community(UUID)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.fn_entity_delete_microgrid(UUID)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.fn_entity_delete_edge(UUID)
  SET search_path = public, pg_temp;

ALTER FUNCTION public.fn_device_openems_component_valid()
  SET search_path = public, pg_temp;

ALTER FUNCTION public.fn_edge_ids_all_nonempty(TEXT[])
  SET search_path = public, pg_temp;
