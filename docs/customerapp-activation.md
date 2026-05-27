# Customerapp activation runbook

Operator-facing steps for enabling the customerapp (`/api/v1/*`) integration
for a specific org. Required reading before flipping `customerapp_enabled =
TRUE` against any production org.

## What gets activated

When an org has `organizations.customerapp_enabled = TRUE` AND a valid
per-org API token (#255), the customerapp can call:

- `POST /api/v1/billing-periods` — create a new draft billing period.
- `POST /api/v1/billing/generate` — generate line items from manual readings.
- (#257) `GET /api/v1/billing-periods` and related read endpoints.

Without the flag set, every `/api/v1/*` call returns `403
customerapp_not_enabled` regardless of how valid the token is.

## Trust model (4-layer composition, #249)

| Layer | Question it answers | Mechanism |
|---|---|---|
| Authentication (#255) | "You are customerapp acting as org X" | Per-org API token (argon2id-hashed). |
| **Acceptance** (#251) | **"Org X has opted to accept customerapp pushes"** | **`organizations.customerapp_enabled` flag (this doc).** |
| Authorization (#254) | "Payload microgrid_id ∈ token's org" | Per-request cross-check inside route handlers. |
| Attribution (#250) | "Who acted, on whose behalf" | `actor_kind = 'customerapp'`, `actor_ref = <token name>` written into audit log. |

`customerapp_enabled` is enforced once, inside `resolveOrgFromToken`
(`src/lib/internal-auth.ts`), AFTER token validation succeeds. A new
`/api/v1/*` route gets the gate for free by calling `resolveOrgFromToken`;
nothing else is needed.

## Activation steps

### 1. Confirm the org is ready

- The org has at least one community + microgrid configured.
- The org has a rate schedule set up for the microgrid(s) the
  customerapp will push readings for.
- An org admin has been identified to manage tokens via the #256 UI
  (or, pre-#256, a super_admin will mint the token via SQL).

### 2. Flip the flag

`super_admin` only (RLS on `organizations` blocks `org_manager` writes
to this column):

```sql
UPDATE organizations
SET customerapp_enabled = TRUE
WHERE id = '<org-uuid>';
```

Or via the future MBE UI (super_admin org page → "Enable customerapp
integration" toggle — not yet wired as of #251).

### 3. Mint a per-org token (#255 / #256)

Until #256 ships the UI, mint via SQL (super_admin):

```sql
-- Use the JS helper for generation; this is illustrative:
-- import { generateToken } from "@/lib/internal-auth";
-- const t = generateToken("prod");
-- const hash = await t.hashPromise;

INSERT INTO org_api_tokens (org_id, name, token_lookup, token_hash, env_prefix, created_by)
VALUES (
  '<org-uuid>',
  'customerapp-prod-2026',  -- shows up in audit log as actor_ref
  '<8-hex-lookup>',
  '<argon2id-hash>',
  'prod',
  '<super-admin-user-id>'
);
```

Return the plaintext (`mbe_prod_<lookup>_<secret>`, 61 chars) to the
operator **once** — the secret is not recoverable from the DB.

### 4. Wire the token into customerapp's config

Customerapp reads its MBE token from its own deployment env. Update the
secret and roll the deployment.

### 5. Smoke-test

From customerapp's environment:

```bash
curl -sS -X POST https://mbe.example.com/api/v1/billing-periods \
  -H "x-api-key: $MBE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"microgrid_id":"<microgrid-uuid>","start_date":"2026-05-01","end_date":"2026-05-31"}'
```

Expected:
- `201` with `{"id":"..."}` — activation succeeded.
- `403 customerapp_not_enabled` — flag is still `FALSE`; re-run step 2.
- `401 missing_header` / `invalid_format` / `not_found` — token wiring
  is wrong; re-check step 3 / 4.

## Kill-switching a misbehaving org

If customerapp starts misbehaving against a single org (e.g. pushing
clearly-wrong readings), you can disable just that org without revoking
the token or interrupting any other org:

```sql
UPDATE organizations
SET customerapp_enabled = FALSE
WHERE id = '<org-uuid>';
```

Effect: the next `/api/v1/*` call from any customerapp instance using a
token scoped to that org returns `403 customerapp_not_enabled`. The token
itself stays valid (and `last_used_at` stays where it was — denials don't
update the timestamp). To re-enable, flip back to `TRUE`.

If the problem is the token itself (leaked, compromised), revoke at the
token layer (#256 UI or SQL):

```sql
UPDATE org_api_tokens
SET revoked_at = now()
WHERE id = '<token-uuid>';
```

That returns `401 not_found` on next use — separate from the
`customerapp_enabled` gate.

## Operational caveats

- **No caching.** Every `/api/v1/*` request re-evaluates the flag, so a
  flip from `TRUE` to `FALSE` takes effect on the next call (no propagation
  delay).
- **Flag applies org-wide.** There is no per-microgrid or per-community
  gate; either all of an org's microgrids accept customerapp pushes or
  none of them do.
- **Default is `FALSE`.** Every new org added to the system is opted out
  by default. The 00044 migration sets the default at the schema level.
