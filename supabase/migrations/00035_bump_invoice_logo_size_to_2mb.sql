-- 00035_bump_invoice_logo_size_to_2mb.sql
-- PDF Invoices (#210 / PDF4): bump the `invoice-logos` Storage bucket's
-- file_size_limit from 1 MiB to 2 MiB.
--
-- Supersedes the inline `file_size_limit = 1048576` set at
-- 00033_pdf_invoices_schema.sql:302. Operator-asked: 2 MB is the new ceiling
-- for community invoice logos. Defense-in-depth: this aligns the bucket cap
-- with the route + UI limits (both also bumped to 2 MB in the same change).
--
-- Idempotent by construction: a bare UPDATE re-runs cleanly. If the bucket
-- row is missing (fresh DB never ran 00033), this matches zero rows — fine;
-- bucket creation remains 00033's responsibility.

UPDATE storage.buckets
SET file_size_limit = 2097152
WHERE id = 'invoice-logos';
