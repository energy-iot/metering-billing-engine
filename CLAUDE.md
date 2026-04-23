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

# Build (standalone for Docker)
npm run build
```

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
├── components/              ← React components (BillingTable, MeterManager, etc.)
├── lib/
│   ├── openems/             ← OpenEMS client, types, errors (adapter pattern)
│   ├── supabase/            ← Supabase client/server/middleware helpers
│   ├── adapters/            ← MeterDataAdapter interface
│   └── types/               ← database.ts (Supabase types)
└── middleware.ts            ← Supabase auth session refresh
```

## Key Conventions

- **Server-side only** for OpenEMS — all B2B calls go through `src/app/api/openems/*` routes
- **No `NEXT_PUBLIC_`** on OpenEMS credentials — they're server-side env vars
- **RLS everywhere** — new tables need Row Level Security policies
- **Adapter pattern** — MBE doesn't import OpenEMS-specific types in billing logic. `MeterDataAdapter` interface in `src/lib/adapters/types.ts`
- **DCO sign-off** on docker-openems commits (`git commit -s`)

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
