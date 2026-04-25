# MBE Local Development Setup

## Which path should I use?

| I want to... | Use |
|--------------|-----|
| Run and test the app (no dev tools needed) | **Docker path** (`./setup.sh --docker`) |
| Write code with hot reload and Supabase Studio | **Dev path** (`./setup.sh`) |

## Docker path (contributor / tester)

Run the entire stack in Docker. No Node.js, npm, or Supabase CLI required.

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Docker Desktop | 4.0+ | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) |

### Quick Start

```bash
git clone https://github.com/energy-iot/metering-billing-engine.git
cd metering-billing-engine
./setup.sh --docker
```

Open [http://localhost:3000](http://localhost:3000) and log in:
- **Email:** `admin@eiot.energy`
- **Password:** `admin123`

### Data persistence

| Command | Data preserved? |
|---------|----------------|
| `docker compose stop` / `start` | Yes |
| `docker compose down` | Yes (volume kept) |
| `docker compose down -v` | **No** (fresh start) |
| `docker compose up --build` | Yes (images rebuilt, data kept) |

### Reset to fresh state

```bash
./setup.sh --docker --force
# or manually:
docker compose down -v && docker compose up --build -d
```

### Limitations

- No hot reload -- runs `next start` (production build). Use the dev path for active development.
- No Supabase Studio -- use the dev path if you need the database admin UI.

## Dev path (developer)

Runs local Supabase via CLI with hot reload and full dev tooling.

### Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 20+ | [nodejs.org](https://nodejs.org/) or `brew install node` |
| npm | 9+ | Bundled with Node.js |
| Docker Desktop | 4.0+ | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) |
| Supabase CLI | 2.75+ | `brew install supabase/tap/supabase` or [docs](https://supabase.com/docs/guides/cli/getting-started) |

### Quick Start — Local Supabase (recommended)

```bash
git clone https://github.com/energy-iot/metering-billing-engine.git
cd metering-billing-engine
./setup.sh
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and log in:
- **Email:** `admin@eiot.energy`
- **Password:** `admin123`

### Quick Start — Cloud Supabase

Connects to an existing hosted Supabase project. No Docker required.

```bash
git clone https://github.com/energy-iot/metering-billing-engine.git
cd metering-billing-engine

# Interactive (prompts for credentials):
./setup.sh --cloud

# Non-interactive (CI / scripted):
./setup.sh --cloud \
  --url=https://your-project.supabase.co \
  --anon-key=your-anon-key \
  --service-role-key=your-service-role-key

npm run dev
```

## Setup Script Reference

```
Usage:
  ./setup.sh                     Local mode (default)
  ./setup.sh --local             Explicit local mode
  ./setup.sh --docker            Docker mode, full stack in Docker
  ./setup.sh --cloud             Cloud mode, interactive prompts
  ./setup.sh --cloud --url=URL --anon-key=KEY --service-role-key=KEY
                                 Cloud mode, non-interactive
  ./setup.sh --force             Overwrite existing .env.local
```

### Flags

| Flag | Description |
|------|-------------|
| `--local` | Use local Supabase via CLI (default if no mode specified) |
| `--docker` | Run the full stack in Docker (no dev tools needed) |
| `--cloud` | Use a hosted Supabase instance |
| `--url=URL` | Supabase project URL (cloud mode only) |
| `--anon-key=KEY` | Supabase anon/publishable key (cloud mode only) |
| `--service-role-key=KEY` | Supabase service role key (cloud mode only) |
| `--force` | Overwrite `.env.local` if it already exists. In docker mode: `docker compose down -v` first. |
| `--help`, `-h` | Show usage information and exit |

### What the script does

**Docker mode:**
1. Checks prerequisites (Docker, docker compose)
2. Builds and starts 6 containers (Postgres, GoTrue, PostgREST, Kong, migrations, Next.js app)
3. Waits for the app to be ready
4. Prints summary with URLs and credentials

**Local mode:**
1. Checks prerequisites (Node.js, npm, Docker, Supabase CLI)
2. Starts local Supabase containers (`supabase start`)
3. Applies database migrations and seeds a dev admin user (`supabase db reset`)
4. Generates `.env.local` with local Supabase URLs and keys
5. Installs npm dependencies

**Cloud mode:**
1. Checks prerequisites (Node.js, npm)
2. Collects Supabase credentials (from flags or interactive prompts)
3. Generates `.env.local` with cloud Supabase URLs and keys
4. Installs npm dependencies

Local and cloud modes append OpenEMS B2B defaults to `.env.local`:
```
OPENEMS_B2B_URL=http://localhost:8075
OPENEMS_B2B_USERNAME=admin
OPENEMS_B2B_PASSWORD=Icui4cyou
```

## Local Supabase Services

After `./setup.sh` in local mode, these services are running:

| Service | URL | Description |
|---------|-----|-------------|
| API (PostgREST) | http://127.0.0.1:54321 | REST API used by the app |
| Studio | http://127.0.0.1:54323 | Database admin UI |
| Inbucket | http://127.0.0.1:54324 | Email testing (catches auth emails) |
| Database | postgresql://postgres:postgres@127.0.0.1:54322/postgres | Direct psql access |

### Useful commands

```bash
supabase status         # Show running services and keys
supabase db reset       # Re-apply migrations + seed (destructive)
supabase stop           # Stop all local Supabase containers
supabase start          # Restart containers
```

## RLS Tests (local Supabase only)

The RLS test suite (`src/lib/supabase/__tests__/rls.test.ts`) verifies that Row Level Security
policies correctly constrain cross-tenant access. These tests **require a running local Supabase CLI
instance** — they never run against cloud Supabase to prevent polluting shared data.

### Running RLS tests

```bash
# 1. Start local Supabase (if not already running)
supabase start

# 2. Re-apply migrations + seed (only needed once, or after schema changes)
supabase db reset

# 3. Get the JWT secret (needed to mint impersonation JWTs)
supabase status | grep "JWT secret"
# Output: JWT secret: super-secret-jwt-token-with-at-least-32-characters-long

# 4. Add SUPABASE_JWT_SECRET to .env.local
echo 'SUPABASE_JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long' >> .env.local

# 5. Run only the RLS tests
npm test -- rls.test.ts

# 6. Run the full test suite (includes RLS)
npm test
```

### Bypassing RLS tests

If you don't have local Supabase running (e.g. CI without Docker), set `SKIP_RLS_TESTS=1`:

```bash
SKIP_RLS_TESTS=1 npm test
```

Missing `NEXT_PUBLIC_SUPABASE_URL` or `SUPABASE_JWT_SECRET` without `SKIP_RLS_TESTS=1` will **fail
loudly** with an actionable error — this is intentional so CI catches missing config rather than
silently skipping coverage.

### Bypassing the DEK-bootstrap integration test

`src/lib/supabase/__tests__/dek-bootstrap.test.ts` shells out to
`supabase db reset --yes` to verify migration `00025_dek_bootstrap_hardening.sql`.
That requires the Supabase CLI plus `psql` available on PATH. Skip the suite
when those aren't present (CI without Docker, fast iteration loops, etc.):

```bash
SKIP_DEK_BOOTSTRAP_TEST=1 npm test
```

This is destructive when it runs (it resets the local DB), so prefer running
it in isolation: `SKIP_RLS_TESTS=1 npm test -- dek-bootstrap.test.ts`. Combine
both flags in CI without local Supabase: `SKIP_RLS_TESTS=1 SKIP_DEK_BOOTSTRAP_TEST=1 npm test`.

### How JWT impersonation works

The harness mints JWTs locally with `jose` and `SUPABASE_JWT_SECRET`. Each JWT carries `sub=<userId>`
and `aud=authenticated`, which Supabase PostgREST uses to derive `auth.uid()` when evaluating RLS
policies. No password round-trips to GoTrue — the impersonation is purely local and fast.

## Full-Stack Setup (with OpenEMS)

To test meter readings and billing generation, you need the OpenEMS stack running alongside MBE.

```bash
# Terminal 1: Start OpenEMS
cd ~/Projects/energy-iot/docker-openems
./setup.sh --edges 1

# Terminal 2: Start MBE
cd ~/Projects/energy-iot/metering-billing-engine
./setup.sh            # or ./setup.sh --docker
```

If using `--docker` mode, OpenEMS on the host is reachable via `host.docker.internal:8075` (configured automatically).

If using local/dev mode, run `npm run dev` after setup.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Docker daemon is not running` | Start Docker Desktop, then re-run `./setup.sh` |
| `supabase: command not found` | Install: `brew install supabase/tap/supabase` |
| `function gen_salt(unknown) does not exist` | Verify seed.sql uses `extensions.crypt()` / `extensions.gen_salt()`. Run `supabase db reset` to re-apply. |
| `.env.local already exists` | Use `./setup.sh --force` to overwrite |
| Login fails with "Invalid credentials" | Run `supabase db reset` (local mode) or `./setup.sh --docker --force` (docker mode) to re-seed the admin user |
| `Failed to reach OpenEMS at localhost:8075` | Start the docker-openems stack first (see Full-Stack Setup) |
| Billing generation shows "No meter reading data" | Ensure OpenEMS edge simulations are running and meters are assigned to tenants |
| Docker mode: app not starting | Check `docker compose logs mbe-app` for errors |
| Docker mode: migration failures | Check `docker compose logs mbe-migrate` for errors. Try `./setup.sh --docker --force` for a fresh start. |

## Architecture

```
Browser (localhost:3000)
   |
   +-- Next.js App (App Router)
   |     +-- Supabase Auth (login, session, RLS)
   |     +-- Supabase Postgres (orgs, microgrids, tenants, billing)
   |     +-- OpenEMS B2B REST API (meter readings)
   |
   +-- Local Supabase (localhost:54321)  <-- setup.sh --local
   |   or Docker Supabase (localhost:54321)  <-- setup.sh --docker
   |   or Cloud Supabase (*.supabase.co)  <-- setup.sh --cloud
   |
   +-- OpenEMS Backend (localhost:8075)  <-- docker-openems
```
