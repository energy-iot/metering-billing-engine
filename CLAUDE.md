# CLAUDE.md — Metering & Billing Engine

Tool-specific config for Claude Code. For the project's operating model, personas, and strategic context, see the private `mbe-docs` repo.

## Contributor Setup

```
~/Projects/energy-iot/
├── metering-billing-engine/   ← this repo (public — code)
├── mbe-docs/                  ← private repo (strategy, personas, learnings)
└── docker-openems/            ← infra repo (public)
```

**Required:** Clone `energy-iot/mbe-docs` (private) alongside this repo. Personas and learnings load from `../mbe-docs/docs/`. Without it, `/architect`, `/pm`, `/designer`, `/infra` commands will prompt you to request access.

**Access:** You must be a member of the `energy-iot` GitHub org with explicit access to `mbe-docs`. Ask Alejandro to grant access.

## Operating Model

**Read `../mbe-docs/docs/operating-model.md` before starting work.** It defines:
- Four personas (Architect, PM, Designer, Infra Lead) with evaluation lenses
- Architectural invariants (security boundaries, data flow, billing logic)
- Implementation pipeline (ticket → refine → implement → review → merge)
- Multi-contributor conventions (branch ownership, shared knowledge, protected files)
- Knowledge system (learnings, evolution logs, project status)

## Build & Dev Commands

```bash
# Install dependencies
npm install

# Dev server (hot reload)
npm run dev

# Type checking
npx tsc --noEmit

# Lint
npm run lint

# Tests
npm test

# Run only RLS tests
npm test -- rls.test.ts

# Build (standalone for Docker)
npm run build

# Generate TypeScript types from local Supabase (requires supabase start)
npm run db:types

# Generate types from cloud-linked Supabase (alternative — use when local isn't running)
npm run db:types:linked

# Check that database.gen.ts is in sync with the schema (run by husky pre-commit)
npm run db:types:check
```

**Codegen workflow:** After any schema migration (`supabase/migrations/*.sql`), run `npm run db:types` to regenerate `src/lib/types/database.gen.ts`. A husky pre-commit hook (`npm run db:types:check`) blocks commits when the generated file is out of date. The `--linked` variant works against the cloud project if local Supabase isn't running: `supabase link` must have been run first.

### Running RLS Tests

RLS tests (`src/lib/supabase/__tests__/rls.test.ts`) require:

1. **Local Supabase CLI running** — `supabase start` (do NOT run against cloud)
2. **`SUPABASE_JWT_SECRET` in `.env.local`** — retrieve with `supabase status | grep 'JWT secret'`
3. **Seed loaded** — run `supabase db reset` once after `supabase start`

Set `SKIP_RLS_TESTS=1` to bypass RLS tests when local Supabase is not available (e.g. CI without Docker).
Missing env vars without `SKIP_RLS_TESTS=1` fail loudly — this is intentional.

See `docs/setup.md § "RLS Tests"` for full instructions.

## Stack

- **Framework:** Next.js 15 (App Router)
- **Auth + DB:** Supabase (Postgres + Auth + RLS)
- **Hosting:** Vercel (free tier)
- **Styling:** Tailwind CSS + shadcn/ui
- **Testing:** Vitest
- **OpenEMS Integration:** Server-side adapter (`src/lib/openems/`)

## Project Structure

```
src/
├── app/
│   ├── (auth)/              ← login/signup pages
│   ├── (dashboard)/         ← authenticated pages (microgrids, billing)
│   └── api/
│       ├── openems/         ← OpenEMS B2B proxy routes (server-side only)
│       └── billing/         ← billing generation endpoint
├── components/              ← React components (BillingTable, DeviceManager, HouseholdTable, etc.)
│   └── format/              ← format primitives (Currency, Kwh, LocalDate, locale-context)
├── lib/
│   ├── openems/             ← OpenEMS client, types, errors (adapter pattern)
│   │   └── device-descriptions.ts  ← human-readable device-type labels
│   ├── supabase/            ← Supabase client/server/middleware helpers
│   ├── adapters/            ← DeviceDataAdapter interface (was MeterDataAdapter)
│   ├── roles.ts             ← centralised role constants (SUPER_ADMIN, ORG_MANAGER, SCOPE_ORG)
│   └── types/
│       ├── database.gen.ts  ← Supabase codegen output (do NOT edit manually)
│       └── domain.ts        ← flat type aliases over database.gen.ts (import from here)
└── middleware.ts            ← Supabase auth session refresh
```

## Key Conventions

- **Server-side only** for OpenEMS — all B2B calls go through `src/app/api/openems/*` routes
- **No `NEXT_PUBLIC_`** on OpenEMS credentials — they're server-side env vars
- **RLS everywhere** — new tables need Row Level Security policies
- **Adapter pattern** — MBE doesn't import OpenEMS-specific types in billing logic. `DeviceDataAdapter` interface in `src/lib/adapters/types.ts` (renamed from `MeterDataAdapter` in C #51)
- **Codegen types** — import entity types from `@/lib/types/domain`, never from `database.gen.ts` directly. Run `npm run db:types` after schema changes.
- **Role constants** — import `SUPER_ADMIN`, `ORG_MANAGER`, `SCOPE_ORG` from `@/lib/roles` instead of spelling out string literals. Two MVP roles ship: `super_admin` and `org_manager`.
- **DCO sign-off** on docker-openems commits (`git commit -s`)

### Entity model (post-AB #50)

The schema follows Org → Community → Microgrid → Edge → Device plus a parallel Household → household_devices join. Two user roles ship for MVP (`super_admin`, `org_manager`); `microgrid_manager` / `community_admin` / `region_admin` / `tenant` are future extensions via enum addition (no schema migration). See `../mbe-docs/docs/entity-model.md` for the full rationale.

**Schema change notes:**
- `microgrids.location` TEXT was **dropped** — use the structured address columns instead (`address_city`, `address_region`, `address_country`, `lat`, `lng`). Downstream pages that read `location` are expected to fail at type-check until Ticket C (#51) lands.
- Old `meters` table renamed to `devices` with a `device_type` enum; old `tenants` → `households` + `household_devices` many-to-many.
- `user_roles` moved from `(user_id, org_id, role)` to `(user_id, role, scope_type, scope_id)`; the old `system_admin` / `org_admin` role names are gone.

### RLS helper functions (migration 00002_rls.sql)

Three `SECURITY DEFINER STABLE` helpers, pinned to `search_path = public, pg_temp`, owned by `postgres`. All policies chain through these — do not inline JOIN chains in `USING` clauses.

| Helper | Contract |
|---|---|
| `is_super_admin() -> BOOLEAN` | True iff `auth.uid()` has any `user_roles` row with `role='super_admin'`. |
| `user_can_access_org(_org_id UUID) -> BOOLEAN` | True iff `is_super_admin()` OR exists a `user_roles` row with `role='org_manager' AND scope_type='org' AND scope_id=_org_id`. |
| `user_can_access_microgrid(_microgrid_id UUID) -> BOOLEAN` | True iff `user_can_access_org(<microgrid's org_id>)` — resolves via `microgrids → communities → org_id`. |

RLS policies are written with `FOR ALL` (not split per-verb) to match the existing pattern. When extending the role model (e.g. adding `microgrid_manager`), extend `user_can_access_microgrid()` rather than splitting the policy per verb.

### Seed migration generation

`supabase/migrations/00003_seed.sql` is **gitignored** and generated by `./setup.sh` from `00003_seed.sql.template` via `envsubst`, substituting `SEED_ADMIN_PASSWORD` and `SEED_AARON_PASSWORD` (bcrypt hashes from `.env.local`). Never commit the generated file — it embeds password material.

## Design System

Token reference: `../mbe-docs/design/v2-paste/README.md`

Five rules every contributor must follow:

1. **Status chips:** Use `<Chip>` not raw `<span>` for status indicators. Use `<StatusChip kind="…" status="…">` to map domain enums (billingPeriod, meterType, edge, household) — this keeps tone-to-status mapping in one file (`src/components/ui/status-chip.tsx`). Add new domain enums by extending `MAPS` in that file, not inline.

2. **Format primitives:** Use `<Currency>`, `<Kwh>`, and `<LocalDate>` — never `Intl.NumberFormat` or `toLocaleDateString` directly. Locale comes from `Accept-Language` (detected at the app root); currency comes from microgrid context (wired in `microgrids/[id]/layout.tsx` via `<LocaleProvider currency={microgrid.currency}>`). In-table currency cells use `bareNumber` prop so Aaron's URA paste workflow gets `4,216,800` not `UGX 4,216,800`; show currency code only in column headers.

3. **Token classes only:** No `bg-blue-*`, `text-gray-*`, or any hardcoded Tailwind color scale classes in `src/app/(dashboard)` or `src/components`. Use semantic tokens: `bg-card`, `bg-muted`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-primary`, `text-primary-foreground`, `bg-destructive-muted`, `text-destructive-fg`, `bg-warning-muted`, `text-warning-fg`, `bg-success-muted`, `text-success-fg`, etc.

4. **Copy table:** Use `<CopyTable>` for billing data tables (built-in per-cell copy + keyboard nav). Grand-total footer rows go BELOW the CopyTable as a `<div>` — CopyTable doesn't support footer rows. Retain `<CopyButton>` only for footer cells.

5. **Destructive actions:** Use `<ConfirmDialog tone="destructive">` for delete flows (Delete Period, Delete Meter, Delete Tenant). Use `<ClosePeriodDialog>` for billing-period close (irreversible, needs multi-channel confirm). Use `<ConfirmDialog tone="neutral">` for non-destructive warnings (e.g. remove-last-tier). Never use `confirm()` — it blocks the main thread and can't be tested.

## Local Dev Setup

See `docs/setup.md` for three modes:
- `./setup.sh` — local Supabase CLI
- `./setup.sh --cloud` — cloud Supabase
- `./setup.sh --docker` — full Docker stack (no Node.js required)

## Sensitive Information

**This is a public repo.** Never commit:
- AWS resource names, account IDs, credentials
- Supabase project URLs, keys, or passwords (use `.env.local`, gitignored)
- Strategy, roadmap, or business context (belongs in `mbe-docs`, private)
- Infrastructure metadata (Terraform state buckets, DynamoDB tables)

When in doubt, ask before committing.
