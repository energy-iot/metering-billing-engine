# Tenant API — contract sketch

**Status:** Pending — implementation deferred (Ticket C #51 sketches the contract only). No endpoints exist yet. See `mbe-docs/docs/entity-model.md` § "Tenant API contract" for the API user pattern A/B decision that must be resolved before implementation begins.

---

## Overview

The Tenant (household) API provides read-only access for household members to view their own billing data. It sits behind `src/app/api/v1/households/me/` and is authenticated via Supabase Auth (JWT), with RLS enforcing that callers can only read their own household's data through the `household_users` join table.

---

## Endpoints (contract sketch — not yet implemented)

### GET /api/v1/households/me

Returns the caller's household profile.

**Auth:** Bearer JWT (Supabase Auth)
**Response:**
```json
{
  "id": "uuid",
  "display_name": "Block B Unit 3",
  "primary_phone": "+256 70 000 0000",
  "primary_email": null,
  "microgrid_id": "uuid",
  "created_at": "2026-01-01T00:00:00Z"
}
```

---

### GET /api/v1/households/me/billing-periods

Returns billing periods for the caller's microgrid (limited to closed periods visible to the household).

**Auth:** Bearer JWT
**Response:**
```json
{
  "periods": [
    {
      "id": "uuid",
      "start_date": "2026-03-01",
      "end_date": "2026-03-31",
      "status": "closed",
      "closed_at": "2026-04-01T08:00:00Z"
    }
  ]
}
```

---

### GET /api/v1/households/me/billing-periods/:periodId

Returns the caller's line item for a specific billing period.

**Auth:** Bearer JWT
**Response:**
```json
{
  "billing_period_id": "uuid",
  "household_id": "uuid",
  "usage_kwh": 85.4,
  "start_kwh": 210.0,
  "end_kwh": 295.4,
  "tier_breakdown": [
    { "label": "Tier 1", "kwh": 50, "amount": 25000 },
    { "label": "Tier 2", "kwh": 35.4, "amount": 28320 }
  ],
  "total_amount": 53320,
  "created_at": "2026-04-01T00:00:00Z"
}
```

---

### GET /api/v1/households/me/rate-schedule

Returns the current rate schedule for the caller's microgrid.

**Auth:** Bearer JWT
**Response:**
```json
{
  "id": "uuid",
  "microgrid_id": "uuid",
  "tiers": [
    { "label": "Tier 1", "min_kwh": 1, "max_kwh": 50, "rate_per_kwh": 500 },
    { "label": "Tier 2", "min_kwh": 51, "max_kwh": null, "rate_per_kwh": 800 }
  ],
  "service_charge": 5000,
  "tax_rate": 0,
  "created_at": "2026-01-01T00:00:00Z"
}
```

---

## Implementation notes (for future ticket)

- All endpoints resolve the caller's `household_id` via `household_users.user_id = auth.uid()`.
- RLS on `household_users` enforces this automatically — no application-layer auth check needed.
- `household_users` is seeded empty (population pattern depends on API user pattern A/B decision).
- Currency is inherited from the microgrid; response payloads omit the currency symbol — callers format locally.
- These endpoints are **read-only** — household members cannot update billing data or rate schedules.
