-- 00021_billing_line_item_payment_status.sql
-- Manual mark-paid for billing line items (#124).
--
-- ── Summary ───────────────────────────────────────────────────────────────────
--
-- Adds payment-status tracking to individual billing_line_items rows so
-- operators (Aaron) can manually mark bills as "paid" when cash / mobile-money
-- is collected outside the Pesapal hosted-checkout flow.
--
-- This migration owns the "manual-operator" tier of the payment-status state
-- machine: unpaid ↔ paid, and failed → paid (operator override of a failed IPN).
--
-- ── Enum design ───────────────────────────────────────────────────────────────
--
-- Initial values: 'unpaid' | 'paid' | 'failed' | 'refunded'.
--
-- 'failed' and 'refunded' are reserved for future use:
--   • 'failed'   — IPN webhook will set this when Pesapal reports payment failure.
--                  Added now so #121 doesn't need an ALTER TYPE that acquires
--                  a table lock. Manual transitions INTO 'failed' are rejected
--                  by the PATCH route's transition guard (application layer).
--   • 'refunded' — Future refund flow. Terminal state. Added now for the same
--                  reason (no ALTER TYPE needed at that time).
--
-- 'link_generated' is NOT added here. That value belongs to #121 (IPN webhook
-- handling) and will be added via ALTER TYPE ... ADD VALUE 'link_generated' at
-- that time. Enum is designed to accept additional values without touching the
-- columns or CHECK constraint.
--
-- ── Audit-trail invariant (CHECK constraint) ──────────────────────────────────
--
-- The CHECK enforces a 2-tier symmetry:
--   • 'unpaid' / 'failed': audit fields MUST be NULL.
--     Rationale: an operator correction (mark paid → mark unpaid) must wipe
--     the attribution so no stale paid_by_user_id lingers.
--   • 'paid' / 'refunded': audit fields MUST be set.
--     Rationale: 'refunded' implies the bill was paid first — paid_at /
--     paid_by_user_id still reflect the original payment actor, which is
--     the correct attribution for audit purposes.
--
-- The enum is intentionally designed so that adding new values to a 'failed'
-- tier or a 'paid' tier does NOT require changing the CHECK expression —
-- simply extend the IN lists.
--
-- ── Idempotency ───────────────────────────────────────────────────────────────
--
-- All statements are guarded: DO $$ IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
-- DROP CONSTRAINT IF EXISTS before ADD CONSTRAINT, CREATE INDEX IF NOT EXISTS.
-- Re-running this migration is safe.
--
-- ── References ────────────────────────────────────────────────────────────────
--
-- AC-SCHEMA-1..6 in issue #124. Patterns from 00020_communities_payment_provider.sql.

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Enum: billing_line_item_payment_status.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Descriptive name (no collision with existing payment_provider_type or
-- billing_period_status enums). Default 'unpaid' ensures all existing rows
-- and new rows start in the correct initial state.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'billing_line_item_payment_status') THEN
    CREATE TYPE billing_line_item_payment_status AS ENUM (
      'unpaid',
      'paid',
      'failed',
      'refunded'
    );
  END IF;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Add payment-status columns to billing_line_items.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- All four columns:
--   payment_status  — state machine value; NOT NULL with 'unpaid' default.
--   paid_at         — timestamp of the mark-paid action (NULL when unpaid/failed).
--   paid_by_user_id — the actor who marked it paid (FK to auth.users, SET NULL
--                     on user deletion so the audit trail isn't blocked by the FK).
--   payment_notes   — optional free-text reason / reference (e.g. "M-Pesa #123").
--                     NULL when cleared on unpaid transition.

ALTER TABLE billing_line_items
  ADD COLUMN IF NOT EXISTS payment_status billing_line_item_payment_status NOT NULL DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS paid_by_user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_notes TEXT NULL;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. CHECK constraint — audit-trail invariant.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Enforces two-tier symmetry: unpaid/failed → NULL audit fields;
-- paid/refunded → non-NULL audit fields.
-- Drop-if-exists for idempotency.

ALTER TABLE billing_line_items DROP CONSTRAINT IF EXISTS billing_line_items_payment_audit_fields_required;
ALTER TABLE billing_line_items
  ADD CONSTRAINT billing_line_items_payment_audit_fields_required
  CHECK (
    (
      payment_status IN ('unpaid', 'failed')
      AND paid_at IS NULL
      AND paid_by_user_id IS NULL
    )
    OR
    (
      payment_status IN ('paid', 'refunded')
      AND paid_at IS NOT NULL
      AND paid_by_user_id IS NOT NULL
    )
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Index — unpaid filter performance.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Supports future queries like "show me all unpaid line items for a microgrid"
-- without a full-table scan on billing_line_items.

CREATE INDEX IF NOT EXISTS idx_billing_line_items_payment_status
  ON billing_line_items(payment_status);
