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

Set `SKIP_RLS_TESTS=1` to bypass RLS tests **locally**, when you have no local Supabase running. **The `Test` gate no longer sets it** — since #324 CI starts its own Supabase and runs these suites, so a change that passes only because you skipped them locally will fail on the PR.
Set `SKIP_DEK_BOOTSTRAP_TEST=1` to additionally bypass the DEK bootstrap suite (`src/lib/supabase/__tests__/dek-bootstrap.test.ts`) — its own guard, and the one flag CI *does* still set, because that suite cannot pass against a non-superuser `postgres` role (see § "Required Merge Controls" and #241).
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
- **Role constants** — import `SUPER_ADMIN`, `ORG_MANAGER`, `SCOPE_ORG` from `@/lib/roles` instead of spelling out string literals. Two roles ship: `super_admin` and `org_manager`, both `scope_type='org'`. The `ems_operator` role value and the `microgrid` scope type still exist in the enums and always will — `ALTER TYPE … ADD VALUE` cannot be undone — but **no role ships on them and nothing reads them** (#321 deleted the rows and repointed the predicate). The enums are deliberately wider than the constants; do not add constants back for enum values that carry no model. A user may still hold several role rows at once — `user_roles` is `UNIQUE (user_id, role, scope_type, scope_id)`, not one row per user. **Code that assumes one row per user is a bug** (see `fn_list_visible_users`); that constraint outlived the role that motivated it, and `fn_change_user_role` deleting rows it was not asked about is the data-loss path it exists to prevent.
- **Microgrid SELECT lists** — avoid `.select('*')` on `microgrids`; enumerate columns via `MICROGRID_PUBLIC_COLUMNS` (`src/lib/types/microgrid-columns.ts`) so new sensitive additions don't silently leak. Enforced by `src/lib/__tests__/no-microgrid-star-select.test.ts`.
- **DCO sign-off** on docker-openems commits (`git commit -s`)

### Entity model (post-AB #50)

The schema follows Org → Community → Microgrid → Edge → Device plus a parallel Household → household_devices join. Two user roles ship for MVP (`super_admin`, `org_manager`); `microgrid_manager` / `community_admin` / `region_admin` / `tenant` are future extensions via enum addition (no schema migration). See `../mbe-docs/docs/entity-model.md` for the full rationale.

**Schema change notes:**
- `microgrids.location` TEXT was **dropped** — use the structured address columns instead (`address_city`, `address_region`, `address_country`, `lat`, `lng`). Downstream pages that read `location` are expected to fail at type-check until Ticket C (#51) lands.
- Old `meters` table renamed to `devices` with a `device_type` enum; old `tenants` → `households` + `household_devices` many-to-many.
- `user_roles` moved from `(user_id, org_id, role)` to `(user_id, role, scope_type, scope_id)`; the old `system_admin` / `org_admin` role names are gone.

### RLS helper functions (migration 00002_rls.sql)

**Three** `SECURITY DEFINER STABLE` helpers, pinned to `search_path = public, pg_temp`, owned by `postgres`. All policies chain through these — do not inline JOIN chains in `USING` clauses. The table below lists **four**: the fourth is a deprecated alias that no policy chains through and that a follow-up migration deletes.

| Helper | Contract |
|---|---|
| `is_super_admin() -> BOOLEAN` | True iff `auth.uid()` has any `user_roles` row with `role='super_admin'`. |
| `user_can_access_org(_org_id UUID) -> BOOLEAN` | True iff `is_super_admin()` OR exists a `user_roles` row with `role='org_manager' AND scope_type='org' AND scope_id=_org_id`. |
| `user_can_access_microgrid(_microgrid_id UUID) -> BOOLEAN` | True iff `user_can_access_org(<microgrid's org_id>)` — resolves via `microgrids → communities → org_id`. |
| `user_can_configure_ems(_microgrid_id UUID) -> BOOLEAN` (00053) | **Thin alias for `user_can_access_microgrid`** — org access *is* configuration access (#321). Kept only so code deployed before #321 keeps working; a follow-up migration drops it once nothing calls it. **Do not add call sites.** |

RLS policies are written with `FOR ALL` (not split per-verb) to match the existing pattern.

**Do not change what `user_can_access_org` / `user_can_access_microgrid` mean.** 23 of the 30 `CREATE POLICY` statements chain through them (13 and 10 respectively), all `FOR ALL`, so read and write move together on every one — an error there is a *silent widening*, not a visible failure. If a capability genuinely differs from org access, add a role value with its own helper, which touches zero existing policies.

**But first ask whether it differs at all.** #316 added `ems_operator` on that reasoning and #321 removed it **the same day** — filed 18:53, merged 22:19, reverted by a ticket opened at 23:16. OpenEMS configuration turned out to *be* org access, and the tell was that the first thing anyone did with the scoped role was grant it org-wide by hand. **Note what #321 did and did not do** — it repointed a *caller* (`fn_microgrids_guard_ems_config`) at `user_can_access_microgrid` and left the helper itself untouched, so no policy moved. Pointing new callers at these helpers is routine; **editing the helpers' bodies is what this rule forbids.**

**Column-level write restrictions are triggers, not policies.** RLS is row-level and column privileges are granted per-role rather than per-user, so neither can express "may update this row, but not these columns". `microgrids.ems_*` is the worked example (`fn_microgrids_guard_ems_config`, most recently re-issued by 00054). Three rules for that shape:

- Enumerate the guarded columns **literally**, in both the `BEFORE UPDATE OF <cols>` statement filter and per-column `IS DISTINCT FROM` checks in the body. `UPDATE OF` alone keys off the columns *named* in the statement, not the values, so it rejects no-op resends that ORMs and PATCH handlers routinely produce. No prefix matching and no `information_schema` loops — they silently absorb adjacent columns (the `ems_last_discover_*` health columns must stay writable for Discover).
- **Adding an `ems_*` config column means editing both enumerations, in a new migration.** Omitting it leaves the column writable by anyone who can update the row, with no error and no warning. `src/lib/__tests__/ems-guard-enumeration.test.ts` fails the build when a column on the table is missing from the guard — it reads both lists out of the newest migration that defines the trigger and compares them against the generated types, so neither side is a hand-maintained list.
- **Exempt `service_role` explicitly, and write the structural reason.** It already bypasses RLS and can write these columns; a new trigger exempting it *declines to add* a restriction rather than removing one. Do not write the circumstantial version ("it's the only write path while X") — that expires and reads as an invitation to delete the exemption.

**Two column lists govern `microgrids`, and they have opposite defaults.** The guard above is **deny-by-enumeration**: a column is unprotected until named. `MICROGRID_PUBLIC_COLUMNS` (`src/lib/types/microgrid-columns.ts`) is **allow-by-enumeration**: a column is invisible until named, and the `MicrogridPublic` type beside it must omit the same secrets the constant leaves out. Reasoning from sensitivity gets one of them backwards — "it's a secret, keep it out of the lists" is right for the projection and exactly wrong for the guard. A new sensitive column goes **into** the guard and **out of** the projection.

### Migration conventions — SECURITY DEFINER grants

**Every `SECURITY DEFINER` function MUST `REVOKE EXECUTE FROM PUBLIC, anon` — not just `PUBLIC` — before its explicit `GRANT EXECUTE TO authenticated, service_role`.**

Why both clauses are required: migration `00016_restore_default_grants.sql` historically did `ALTER DEFAULT PRIVILEGES … GRANT ALL ON ROUTINES TO anon, authenticated, service_role`. This was narrowed by `00047` (B2, #270) to remove `ROUTINES` from `anon, authenticated`'s future-grant, but existing functions created between 00016 and 00047 inherited the anon execute grant. `REVOKE EXECUTE FROM PUBLIC` alone does NOT undo that — `anon` is a specific role, not a `PUBLIC` member.

The Supabase linter `anon_security_definer_function_executable` will flag any future SECURITY DEFINER fn that omits the explicit `anon` REVOKE.

Convention applies to all new migrations adding `SECURITY DEFINER` functions:

```sql
CREATE OR REPLACE FUNCTION fn_new(...)
RETURNS ...
LANGUAGE ...
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ ... $$;

REVOKE EXECUTE ON FUNCTION fn_new(...) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fn_new(...) TO authenticated, service_role;
```

If the function MUST be anon-callable (rare; typically only public-data RPCs), document the intent in a comment block above the GRANT and skip the REVOKE-from-anon clause.

**PostgREST surface varies by REVOKE pattern.** Test assertions for "anon denied" must accept either of two HTTP shapes — same security outcome, different code:

- **`401 SQLSTATE 42501` ("permission denied for function ...")** — fires when the fn is in PostgREST's schema cache AND anon is denied at the grant layer. Typical for new fns that ship with `REVOKE EXECUTE FROM PUBLIC, anon; GRANT EXECUTE TO authenticated, service_role` (e.g., `fn_list_visible_users` from migration 00046).
- **`404 PGRST202` ("Could not find the function ... in the schema cache")** — fires when EXECUTE is REVOKEd from anon AND PostgREST has refreshed its schema cache to filter the fn out entirely. Typical when a fn is REVOKEd from ALL roles except `service_role` (e.g., the `fn_create_profile_on_auth_user` trigger fn in migration 00047). Also empirically observed for fns that have anon REVOKEd post-creation via `ALTER FUNCTION ... REVOKE` (PostgREST caches at startup; aggressive cache filtering applies).

Regression-test pattern: assert `error.code === "42501" || error.message?.toLowerCase().includes("permission denied") || error.code === "PGRST202"` rather than checking only `42501`. Empirical mapping observed during the Supabase Security wave (B1 #268 / A #269 / B2 #270):

| Migration shape | PostgREST response |
|---|---|
| Pre-existing fn + post-hoc REVOKE FROM anon (B1) | `404 PGRST202` after schema-cache refresh |
| New fn + REVOKE+GRANT in same DDL (A) | `401 42501` |
| Fully REVOKEd (no role retains EXECUTE except service_role) (B2 trigger fn) | `404 PGRST202` |

### Migration conventions — a migration and the tests that assert its objects ship in one commit

**A migration that changes a database object a database-backed test asserts must ship in the same commit as that test and as the regenerated `database.gen.ts`.** Not the commit before, not the commit after.

CI builds its database from `supabase/migrations/*.sql` — `.github/workflows/test.yml` runs `supabase start` and applies the migration files on the PR head. So the migration and the tests are evaluated against each other, and they are red either way round if they disagree:

- Change the test first: it runs against a database that does not yet have the change.
- Change the test after: the PR that adds the migration is red on merge.

This became true in **#324**, which took `SKIP_RLS_TESTS=1` out of the `Test` gate. Before that, the `rls` project never ran in CI, a migration contradicting a database-backed test merged green, and the disagreement surfaced whenever someone next ran the suite by hand.

**The ordering constraint is inside one PR, not across a deploy.** Do not reach for the deploy-ordering framing used for schema changes that must interleave with an app release (`00053`'s header is the worked example of *that* problem) — it names events on the wrong axis for this one and produces a plan nobody can follow.

Worked example: dropping the deprecated `user_can_configure_ems` alias requires, in one commit, the migration, the alias assertions in `ems_config_access.test.ts`, the regenerated `database.gen.ts`, and the helper-table row in this file.

### Seed migration generation

`supabase/migrations/00003_seed.sql` is **gitignored** and generated by `./setup.sh` from `00003_seed.sql.template` via `envsubst`, substituting `SEED_ADMIN_PASSWORD` and `SEED_AARON_PASSWORD` (bcrypt hashes from `.env.local`). Never commit the generated file — it embeds password material.

## Design System

Token reference: `../mbe-docs/design/v2-paste/README.md`

Five rules every contributor must follow:

1. **Status chips:** Use `<Chip>` not raw `<span>` for status indicators. Use `<StatusChip kind="…" status="…">` to map domain enums (billingPeriod, meterType, edge, household) — this keeps tone-to-status mapping in one file (`src/components/ui/status-chip.tsx`). Add new domain enums by extending `MAPS` in that file, not inline.

2. **Format primitives:** Use `<Currency>`, `<Kwh>`, and `<LocalDate>` — never `Intl.NumberFormat` or `toLocaleDateString` directly. Locale comes from `Accept-Language` (detected at the app root); currency comes from microgrid context (wired in `microgrids/[id]/layout.tsx` via `<LocaleProvider currency={microgrid.currency}>`). In-table currency cells use `bareNumber` prop so Aaron's URA paste workflow gets `4,216,800` not `UGX 4,216,800`; show currency code only in column headers.

3. **Token classes only:** No `bg-blue-*`, `text-gray-*`, or any hardcoded Tailwind color scale classes in `src/app/(dashboard)` or `src/components`. Use semantic tokens: `bg-card`, `bg-muted`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-primary`, `text-primary-foreground`, `bg-destructive-muted`, `text-destructive-fg`, `bg-warning-muted`, `text-warning-fg`, `bg-success-muted`, `text-success-fg`, etc.

4. **Copy table:** Use `<CopyTable>` for billing data tables (built-in per-cell copy + keyboard nav). Grand-total footer rows go BELOW the CopyTable as a `<div>` — CopyTable doesn't support footer rows. Retain `<CopyButton>` only for footer cells.

5. **Destructive actions:** Use `<ConfirmDialog tone="destructive">` for delete flows (Delete Period, Delete Meter, Delete Tenant). Use `<ClosePeriodDialog>` for billing-period close (irreversible, needs multi-channel confirm via totals review + checkbox); when the caller passes `unfilledHouseholdNames`, the dialog renders a warning-toned banner above the totals, flips the confirm button to "Close anyway", and appends an explicit acknowledgement to the checkbox copy (warn-but-allow per #167). Styled in neutral/primary tone — closing is a final commit, not a destruction. Reserve destructive tone for delete-entity flows (`<ConfirmDialog tone="destructive">`). Use `<ConfirmDialog tone="neutral">` for non-destructive warnings (e.g. remove-last-tier). Never use `confirm()` — it blocks the main thread and can't be tested.

6. **Picker / empty-state mutual exclusion:** When a list surface has both a switcher control (e.g. `<PeriodPicker>`) and an `<EmptyState>`, the switcher MUST NOT render when its underlying collection is empty. The empty-state owns the create CTA at zero; the switcher owns the create CTA at ≥1. Switchers must not include their own internal "no items" empty-state branch — that responsibility belongs to the parent surface, where the canonical first-run pedagogy copy lives. Additionally, when an inline create form is open, the parent's `<EmptyState>` must hide so the form is the sole CTA on screen; the form itself must include a `Cancel` action so the user has an escape hatch back to the empty-state.

## Required Merge Controls

`main` is protected by the `require-DCO` ruleset (visible at https://github.com/energy-iot/metering-billing-engine/rules; `bypass_actors: []`, `current_user_can_bypass: never` — even repo admins cannot use `gh pr merge --admin` to bypass). Every PR must pass ALL of the following before merge:

1. **DCO** — every commit ends with `Signed-off-by: Your Name <email>`. Use `git commit -s`.
2. **`required_signatures` (cryptographic)** — every commit must be GPG- or SSH-signed. DCO is a text trailer; `required_signatures` is a separate cryptographic guarantee. One-time per-machine setup:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_signing -C "<your-email>"
   git config --global gpg.format ssh
   git config --global user.signingkey ~/.ssh/id_ed25519_signing.pub
   git config --global commit.gpgsign true
   git config --global tag.gpgsign true
   ```
   Then upload `~/.ssh/id_ed25519_signing.pub` at github.com → Settings → SSH and GPG keys → "New SSH key" with **Key type: Signing Key**. After setup, every `git commit` carries an "SSH" signature and GitHub shows the "Verified" badge.
3. **`CodeQL` status check** — `.github/workflows/codeql.yml` runs `github/codeql-action` on every PR + push to main. The check name `CodeQL` MUST match the workflow job name; do NOT rename or add a matrix-suffix.
4. **`Test` status check** — `.github/workflows/test.yml` runs `npm ci` → `npx tsc --noEmit` → `npm run lint` → `supabase start` → `npm test` on every PR + push to main. The check name `Test` MUST match the workflow job name; do NOT rename or add a matrix-suffix. **Since #324 the database-backed suites run in the gate**: `SKIP_RLS_TESTS` is no longer set, the `rls` project executes against a local Supabase started on the runner, and the suites are self-fixturing (no generated seed, no repository secret — `supabase start` produces its own `JWT_SECRET` and `ANON_KEY`). The job takes roughly three and a half to four minutes, of which `supabase start` is ~85s. **No test count is given here on purpose** — it moves with every PR that adds or removes one, and a count in this file would be stale within a day of being written. Read it off the latest `Test` run on `main`. `SKIP_DEK_BOOTSTRAP_TEST=1` **is** still set, and not for cost: `dek-bootstrap.test.ts` runs `ALTER DATABASE … SET app.allow_dev_dek`, which fails with *permission denied to set parameter* because the `postgres` role is not a superuser on Supabase, local or CI. It cannot pass at any time budget; that is a test defect tracked on #241, not a deferral. Note it currently reports as **2 passed** rather than skipped — it returns early inside its `it()` bodies instead of using `describe.skipIf`, so the run output overstates coverage. Also tracked on #241.
5. **`Vercel` preview deploy** passes (build succeeds + preview URL provisioned).
6. **`non_fast_forward` + `deletion` protection** — `main` cannot be force-pushed or deleted.

**Bypass path** (genuine emergencies only — Aaron-blocking production hotfixes when the rules themselves are mis-configured):
- Temporarily PATCH the ruleset to `enforcement: disabled`, merge, re-enable to `active`:
  ```bash
  gh api -X PUT repos/energy-iot/metering-billing-engine/rulesets/15518390 -f enforcement=disabled --silent
  # ... merge ...
  gh api -X PUT repos/energy-iot/metering-billing-engine/rulesets/15518390 -f enforcement=active --silent
  ```
- Use sparingly; log the bypass reason in the PR description.

**For agents you delegate**: every implementer prompt MUST instruct the agent to `git commit -s` AND to commit with the user's existing signing config (no setup work — assume signing is already configured per the one-time setup above; the agent's commit inherits config from `~/.gitconfig`). If the agent's commit doesn't get a "Verified" badge, the user's signing setup needs attention — flag it before pushing.

## Local Dev Setup

See `docs/setup.md` for three modes:
- `./setup.sh` — local Supabase CLI
- `./setup.sh --cloud` — cloud Supabase
- `./setup.sh --docker` — full Docker stack (no Node.js required)

## Writing Conventions

### A comment asserting a cross-artifact fact must name its own invalidation condition

The failure mode is not staleness in general — it is a comment that states a rule without naming what could change it, so nothing about reading it suggests checking whether it still holds. A docstring stating a permission truth table that a later migration had replaced misled four people during the scoping of #316, precisely because it gave them no reason to distrust it.

Write the version that names what would make it wrong:

> routes through this function rather than `user_directory` because `user_can_see_user_profile` filters `scope_type = 'org'` and would omit microgrid-scoped operators — if that filter changes, revisit

Same length as the version that just states the rule.

**Scope this narrowly.** It earns its keep only for comments asserting a **cross-artifact** fact: a policy enforced somewhere else, or copy that depends on another surface existing. A comment explaining what the code in front of you does needs no invalidation condition — the code is right there and cannot drift from itself. Applied to every comment this becomes "annotate everything", which reviewers stop reading within a sprint.

The reason belongs **in the code**, with the ticket as the long-form record. Nobody reads a ticket six months later while editing a helper.

### A public artifact describing an unfixed weakness is a disclosure regardless of how it is worded

Venue is the decision; redaction is not. Careful wording, omitted identifiers and a neutral tone do not convert a description of an unfixed weakness into something safe to publish — they only make it a quieter disclosure. Decide *where it goes* first.

Applies to issues, PR titles and bodies, commit messages, code comments, and test names in this repo, all of which are public. If the artifact would describe a weakness that is not yet fixed and deployed:

- Put the detail in `mbe-docs` (private) and reference it by ticket number here.
- Describe public-repo work by what it *adds* ("microgrid-scoped configuration role"), not by what it *fixes* ("any org manager could read stored cloud credentials").
- A fix landing on `main` is not the same as a fix being deployed. Wait for applied-in-production before publishing the detail.

## Sensitive Information

**This is a public repo.** Never commit:
- AWS resource names, account IDs, credentials
- Supabase project URLs, keys, or passwords (use `.env.local`, gitignored)
- Strategy, roadmap, or business context (belongs in `mbe-docs`, private)
- Infrastructure metadata (Terraform state buckets, DynamoDB tables)

When in doubt, ask before committing.
