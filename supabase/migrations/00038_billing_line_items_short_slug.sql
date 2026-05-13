-- 00038_billing_line_items_short_slug.sql (#223)
--
-- Adds `short_slug TEXT NULL` to `billing_line_items` to support the
-- consumer-facing `/p/<slug>` payment-link indirection (#223). The slug is
-- the short, customer-visible URL embedded in PDF bills + WhatsApp
-- copies; it 302s through to the legacy
-- `/api/billing-line-items/<uuid>/pay` route, which keeps working
-- forever (bills already shipped to customer phones reference the long
-- form).
--
-- Why a column (not a separate `payment_short_links` table)?
--   The line item is the natural owning entity. No fan-out concerns at
--   this scale (one slug per bill). Inline is simpler and the join
--   savings on every /p/<slug> hit are real (the route does a
--   single-row PK lookup → 302).
--
-- Why 6-8 char base62?
--   6 chars = 56.8B combinations; ~1-in-many-millennia collisions at
--   100 bills/day. CHECK regex allows 6-8 to leave headroom for a
--   future extension without a column-type change.
--
-- No backfill — slugs are minted lazily on first /pdf render (per AC4
-- of #223). Existing rows whose PDF was already shipped will get a
-- slug whenever the operator next renders the PDF; the cached URL on
-- those bills uses the long format and continues to resolve via the
-- legacy /api/billing-line-items/<uuid>/pay route.
--
-- No interaction with `fn_record_line_item_with_audit` (00029, refactored
-- in 00037 at lines 117-147). The function's `DO UPDATE SET` clause only
-- enumerates the reading + calc + provenance columns plus the three
-- amount-bound payment-cache columns. `short_slug` is NOT in that list
-- and is therefore preserved on every UPSERT / regenerate-line-item path
-- with no migration change. Documented here so future reviewers see the
-- decision when grepping for short_slug.

ALTER TABLE billing_line_items
  ADD COLUMN IF NOT EXISTS short_slug TEXT NULL;

-- CHECK constraint: NULL or base62 [A-Za-z0-9] with length 6-8.
-- Idempotent — drop-and-recreate is safe because the constraint name is
-- deterministic and the predicate is structural.
ALTER TABLE billing_line_items
  DROP CONSTRAINT IF EXISTS billing_line_items_short_slug_format;
ALTER TABLE billing_line_items
  ADD CONSTRAINT billing_line_items_short_slug_format
  CHECK (
    short_slug IS NULL
    OR short_slug ~ '^[A-Za-z0-9]{6,8}$'
  );

-- Partial UNIQUE index — slugs MUST be globally unique when present, but
-- multiple NULLs are allowed (Postgres-default NULL distinctness combined
-- with the WHERE filter). Mirrors the
-- `idx_billing_line_items_invoice_number` partial-unique pattern at
-- 00033_pdf_invoices_schema.sql:150-162.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'billing_line_items_short_slug_unique'
  ) THEN
    CREATE UNIQUE INDEX billing_line_items_short_slug_unique
      ON billing_line_items(short_slug)
      WHERE short_slug IS NOT NULL;
  END IF;
END;
$$;
