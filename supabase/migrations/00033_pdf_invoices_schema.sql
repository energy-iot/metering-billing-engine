-- 00033_pdf_invoices_schema.sql
-- PDF Invoices (#202 / PDF1a): backend foundation for the consumer-facing
-- invoice PDF — schema + RLS + storage bucket + invoice-counter function.
--
-- ── Summary ───────────────────────────────────────────────────────────────────
--
-- Adds the schema + RPC plumbing that PDF1b/PDF2/PDF3 consume:
--
--   1. New columns on `communities`: invoice_prefix (TEXT), invoice_config (JSONB).
--   2. New columns on `households`: account_number, contact_email,
--      customer_type (residential | commercial), meter_serial, meter_type.
--   3. New column on `rate_schedules`: service_charge_description.
--   4. New columns on `billing_line_items`: invoice_number, pesapal_redirect_url
--      (with partial-unique index + format CHECK for invoice_number).
--   5. New table `invoice_counters` (community_id, year, counter) with verb-
--      split RLS (SELECT/INSERT/UPDATE), and SECURITY INVOKER function
--      `fn_next_invoice_number(p_community_id, p_year) RETURNS INT`.
--   6. New Supabase Storage bucket `invoice-logos` (private, 1 MiB cap, image
--      MIME types) with per-verb storage.objects RLS scoped by path's first
--      segment = `{community_uuid}`.
--
-- ── Idempotency convention ────────────────────────────────────────────────────
--
-- Every ADD COLUMN uses ADD COLUMN IF NOT EXISTS. Every CHECK constraint uses
-- DROP CONSTRAINT IF EXISTS / ADD CONSTRAINT (mirrors the
-- billing_line_items_manual_reason_max_length pattern at
-- 00029_billing_line_item_source_and_audit.sql:58-61). Every CREATE POLICY
-- uses DROP POLICY IF EXISTS / CREATE POLICY. Re-running the migration is
-- safe.
--
-- ── Out of scope (handled by sibling tickets) ─────────────────────────────────
--
--   - PDF rendering / @react-pdf/renderer — PDF1b (#203).
--   - GET /api/billing-line-items/[id]/pdf — PDF1b.
--   - Community Settings → Invoice UI — PDF2 (#204).
--   - Logo upload UI — PDF2 (the bucket is created here; PDF2 wires the form).
--   - Household form fields UI — PDF3 (#205).
--   - <RowActionsMenu> "Download bill" item — PDF3.
--   - Invoice number generation at first render — PDF1b (the schema + function
--     are here; the call site is PDF1b's route).

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. communities — invoice_prefix + invoice_config.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS invoice_prefix TEXT NULL,
  ADD COLUMN IF NOT EXISTS invoice_config JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE communities DROP CONSTRAINT IF EXISTS communities_invoice_prefix_format;
ALTER TABLE communities
  ADD CONSTRAINT communities_invoice_prefix_format
  CHECK (invoice_prefix IS NULL OR invoice_prefix ~ '^[A-Z0-9]{2,8}$');

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. households — account_number, contact_email, customer_type, meter_serial,
--    meter_type. Columns added in alphabetical order so `\d households`
--    output is stable across branches/checkouts.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- meter_type and customer_type get a DEFAULT to backfill existing rows in one
-- statement (NOT NULL is admitted because the DEFAULT supplies the value for
-- existing rows; Postgres ≥ 11 fast-path avoids a full rewrite).
--
-- contact_email regex intent is FORMAT-only (rejects whitespace, requires
-- `@` and `.`). Deliverability is verified out-of-band by tenant outreach,
-- never at the column boundary. Do NOT tighten to RFC 5322.

ALTER TABLE households
  ADD COLUMN IF NOT EXISTS account_number TEXT NULL,
  ADD COLUMN IF NOT EXISTS contact_email TEXT NULL,
  ADD COLUMN IF NOT EXISTS customer_type TEXT NOT NULL DEFAULT 'residential',
  ADD COLUMN IF NOT EXISTS meter_serial TEXT NULL,
  ADD COLUMN IF NOT EXISTS meter_type TEXT NOT NULL DEFAULT 'Smart Submeter';

ALTER TABLE households DROP CONSTRAINT IF EXISTS households_account_number_shape;
ALTER TABLE households
  ADD CONSTRAINT households_account_number_shape
  CHECK (
    account_number IS NULL
    OR (length(trim(account_number)) > 0 AND length(account_number) <= 30)
  );

ALTER TABLE households DROP CONSTRAINT IF EXISTS households_contact_email_format;
ALTER TABLE households
  ADD CONSTRAINT households_contact_email_format
  CHECK (
    contact_email IS NULL
    OR contact_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  );

ALTER TABLE households DROP CONSTRAINT IF EXISTS households_customer_type_enum;
ALTER TABLE households
  ADD CONSTRAINT households_customer_type_enum
  CHECK (customer_type IN ('residential', 'commercial'));

ALTER TABLE households DROP CONSTRAINT IF EXISTS households_meter_serial_shape;
ALTER TABLE households
  ADD CONSTRAINT households_meter_serial_shape
  CHECK (
    meter_serial IS NULL
    OR (length(trim(meter_serial)) > 0 AND length(meter_serial) <= 50)
  );

ALTER TABLE households DROP CONSTRAINT IF EXISTS households_meter_type_shape;
ALTER TABLE households
  ADD CONSTRAINT households_meter_type_shape
  CHECK (length(meter_type) > 0 AND length(meter_type) <= 50);

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. rate_schedules — service_charge_description.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE rate_schedules
  ADD COLUMN IF NOT EXISTS service_charge_description TEXT NULL;

ALTER TABLE rate_schedules DROP CONSTRAINT IF EXISTS rate_schedules_service_charge_description_max_length;
ALTER TABLE rate_schedules
  ADD CONSTRAINT rate_schedules_service_charge_description_max_length
  CHECK (
    service_charge_description IS NULL
    OR length(service_charge_description) <= 200
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. billing_line_items — invoice_number, pesapal_redirect_url.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- invoice_number: populated on first PDF render via fn_next_invoice_number()
-- + formatInvoiceNumber(). Idempotent uniqueness pattern (R4): add the
-- column without an inline UNIQUE, then add a partial-unique index — mirrors
-- the idx_billing_line_items_pesapal_order_id pattern at 00028:104-110. The
-- partial predicate `WHERE invoice_number IS NOT NULL` is defensive (Postgres
-- treats NULLs as distinct in UNIQUE indexes by default).
--
-- The CHECK regex pins the formatter contract (5-digit zero-pad, 4-digit year,
-- prefix [A-Z0-9]{2,8}). The 5-digit counter cap (99,999/community/year) is
-- well above any realistic MVP throughput; a future widening must change the
-- format AND the CHECK regex in lockstep.
--
-- pesapal_redirect_url: cached customer-facing URL (D6). 2048 cap is the
-- common URL-spec ceiling; defends against runaway/malformed concatenation.
-- Note: Postgres has no `ADD COLUMN ... AFTER` — the new column lands at the
-- end of the table regardless of migration ordering.

ALTER TABLE billing_line_items
  ADD COLUMN IF NOT EXISTS invoice_number TEXT NULL,
  ADD COLUMN IF NOT EXISTS pesapal_redirect_url TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_billing_line_items_invoice_number'
  ) THEN
    CREATE UNIQUE INDEX idx_billing_line_items_invoice_number
      ON billing_line_items(invoice_number)
      WHERE invoice_number IS NOT NULL;
  END IF;
END;
$$;

ALTER TABLE billing_line_items DROP CONSTRAINT IF EXISTS billing_line_items_invoice_number_format;
ALTER TABLE billing_line_items
  ADD CONSTRAINT billing_line_items_invoice_number_format
  CHECK (
    invoice_number IS NULL
    OR invoice_number ~ '^[A-Z0-9]{2,8}-\d{4}-\d{5}$'
  );

ALTER TABLE billing_line_items DROP CONSTRAINT IF EXISTS billing_line_items_pesapal_redirect_url_max_length;
ALTER TABLE billing_line_items
  ADD CONSTRAINT billing_line_items_pesapal_redirect_url_max_length
  CHECK (
    pesapal_redirect_url IS NULL
    OR length(pesapal_redirect_url) <= 2048
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. invoice_counters table + RLS + fn_next_invoice_number.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Per-community-per-year sequential counter for invoice numbering (D3).
--
-- Verb-split RLS (NOT FOR ALL) so the SECURITY INVOKER fn_next_invoice_number
-- can INSERT/UPDATE under the caller's identity. Mirrors the
-- billing_audit_log shape at 00029:130-162 (GRANT + per-verb policies).
--
-- user_can_access_org() is itself SECURITY DEFINER STABLE (00002_rls.sql:57-73)
-- — when called from inside this policy under a SECURITY INVOKER function,
-- the helper's body executes as `postgres` (DEFINER) and reads auth.uid() +
-- user_roles correctly even though the caller has no direct SELECT on
-- user_roles. This is the same pattern used by every other policy in the
-- codebase; no extra grants are required.

CREATE TABLE IF NOT EXISTS invoice_counters (
  community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  year         INT NOT NULL CHECK (year >= 2020 AND year <= 2200),
  counter      INT NOT NULL DEFAULT 0,
  PRIMARY KEY (community_id, year)
);

ALTER TABLE invoice_counters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authorized users can read invoice_counters" ON invoice_counters;
CREATE POLICY "Authorized users can read invoice_counters"
  ON invoice_counters FOR SELECT
  USING (user_can_access_org((SELECT org_id FROM communities WHERE id = community_id)));

-- INSERT — same predicate via WITH CHECK. The `fn_next_invoice_number`
-- INSERT path executes under the caller's identity (SECURITY INVOKER), so
-- this policy is the gate. Cross-org callers fail with 42501 inside the
-- function and the route surfaces 403.
DROP POLICY IF EXISTS "Authorized users can write invoice_counters" ON invoice_counters;
CREATE POLICY "Authorized users can write invoice_counters"
  ON invoice_counters FOR INSERT
  WITH CHECK (user_can_access_org((SELECT org_id FROM communities WHERE id = community_id)));

-- UPDATE — same predicate; needed because the function uses ON CONFLICT
-- DO UPDATE on the (community_id, year) PK, which UPDATEs an existing row
-- on second-and-later calls in the same year.
DROP POLICY IF EXISTS "Authorized users can increment invoice_counters" ON invoice_counters;
CREATE POLICY "Authorized users can increment invoice_counters"
  ON invoice_counters FOR UPDATE
  USING (user_can_access_org((SELECT org_id FROM communities WHERE id = community_id)))
  WITH CHECK (user_can_access_org((SELECT org_id FROM communities WHERE id = community_id)));

-- No DELETE policy — counters are forever (resetting would compromise
-- invoice number uniqueness across years). Default-deny + missing GRANT means
-- an authenticated DELETE returns zero affected rows (silent), NOT 42501.

GRANT SELECT, INSERT, UPDATE ON invoice_counters TO authenticated;
-- Belt-and-suspenders: explicitly NOT granting DELETE.

-- ── fn_next_invoice_number ──────────────────────────────────────────────────
--
-- SECURITY INVOKER (NOT DEFINER): the function executes as the caller, so
-- the table-level GRANTs and the RLS policies above are the authoritative
-- gate. A cross-org caller hits 42501 (insufficient_privilege) when the
-- INSERT WITH CHECK fails; the route handler's `try { await rpc(...) }`
-- catches and surfaces 403. Mirrors `fn_record_line_item_with_audit` (00029)
-- which is INVOKER for the same reason.
--
-- Year bound: 2020-2200 inclusive. Aligned with formatInvoiceNumber's helper
-- guard and the invoice_counters.year CHECK above. A divergence between any
-- of the three is a defect.

CREATE OR REPLACE FUNCTION fn_next_invoice_number(p_community_id UUID, p_year INT)
RETURNS INT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_counter INT;
BEGIN
  IF p_year < 2020 OR p_year > 2200 THEN
    RAISE EXCEPTION 'Invalid year %', p_year USING ERRCODE = '22023';
  END IF;
  INSERT INTO invoice_counters (community_id, year, counter)
  VALUES (p_community_id, p_year, 1)
  ON CONFLICT (community_id, year)
    DO UPDATE SET counter = invoice_counters.counter + 1
  RETURNING counter INTO v_counter;
  RETURN v_counter;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_next_invoice_number(UUID, INT) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. Supabase Storage bucket `invoice-logos` + per-verb storage.objects RLS.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- This is the FIRST storage bucket migration in MBE — there is no in-repo
-- precedent yet. Bucket and RLS policies are managed exclusively via this SQL
-- migration (NOT via the Supabase dashboard). This guarantees the policies
-- survive `supabase db reset` and are reproducible across local / preview /
-- production. Do not create or modify the bucket via the dashboard.
--
-- Path schema enforcement: policies require the path to be
-- `{community_uuid}/<filename>...` — `storage.foldername(name)[1]` returns
-- the first segment. A bare-filename upload (no folder) yields
-- `(storage.foldername('logo.png'))[1] = NULL`, the EXISTS subquery's
-- `c.id::text = NULL` is false, and the INSERT policy denies. PDF2's upload
-- route MUST construct paths in `{community.id}/{timestamp}-{random}.{ext}`
-- shape; bare-filename uploads are silently denied.
--
-- Bucket is private (`public = false`). PDF renderer fetches via service-role
-- signed URL (60s TTL — service-role bypasses RLS). Operator preview in PDF2
-- reads via authenticated browser session and the SELECT policy.
--
-- PDF2's UI must enforce a tighter 500KB cap client-side; the bucket's 1 MiB
-- is defense-in-depth.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'invoice-logos',
  'invoice-logos',
  false,
  1048576,
  ARRAY['image/png', 'image/jpeg', 'image/svg+xml']::text[]
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "invoice_logos_select" ON storage.objects;
CREATE POLICY "invoice_logos_select" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'invoice-logos'
    AND EXISTS (
      SELECT 1 FROM communities AS comm
      WHERE comm.id::text = (storage.foldername(storage.objects.name))[1]
        AND user_can_access_org(comm.org_id)
    )
  );

DROP POLICY IF EXISTS "invoice_logos_insert" ON storage.objects;
CREATE POLICY "invoice_logos_insert" ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'invoice-logos'
    AND EXISTS (
      SELECT 1 FROM communities AS comm
      WHERE comm.id::text = (storage.foldername(storage.objects.name))[1]
        AND user_can_access_org(comm.org_id)
    )
  );

DROP POLICY IF EXISTS "invoice_logos_update" ON storage.objects;
CREATE POLICY "invoice_logos_update" ON storage.objects
  FOR UPDATE
  USING (
    bucket_id = 'invoice-logos'
    AND EXISTS (
      SELECT 1 FROM communities AS comm
      WHERE comm.id::text = (storage.foldername(storage.objects.name))[1]
        AND user_can_access_org(comm.org_id)
    )
  )
  WITH CHECK (
    bucket_id = 'invoice-logos'
    AND EXISTS (
      SELECT 1 FROM communities AS comm
      WHERE comm.id::text = (storage.foldername(storage.objects.name))[1]
        AND user_can_access_org(comm.org_id)
    )
  );

DROP POLICY IF EXISTS "invoice_logos_delete" ON storage.objects;
CREATE POLICY "invoice_logos_delete" ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'invoice-logos'
    AND EXISTS (
      SELECT 1 FROM communities AS comm
      WHERE comm.id::text = (storage.foldername(storage.objects.name))[1]
        AND user_can_access_org(comm.org_id)
    )
  );
