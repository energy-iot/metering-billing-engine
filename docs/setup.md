# MBE Local Development Setup

## Prerequisites

### Required (all modes)

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 18+ | [nodejs.org](https://nodejs.org/) or `brew install node` |
| npm | 9+ | Bundled with Node.js |

### Required for local mode only

| Tool | Version | Install |
|------|---------|---------|
| Docker Desktop | 4.0+ | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) |
| Supabase CLI | 2.75+ | `brew install supabase/tap/supabase` or [docs](https://supabase.com/docs/guides/cli/getting-started) |

> Cloud mode (`--cloud`) does not require Docker or the Supabase CLI.

### Optional (for full-stack testing with OpenEMS)

| Tool | Repo | Purpose |
|------|------|---------|
| docker-openems | [energy-iot/docker-openems](https://github.com/energy-iot/docker-openems) | OpenEMS energy platform (Edge + Backend + UI). Run its `./setup.sh --edges 1` first. Required for meter readings and billing generation. |

## Quick Start

### Option A: Local development (recommended)

Runs a local Supabase instance in Docker. Full isolation -- no cloud dependency.

```bash
git clone https://github.com/energy-iot/metering-billing-engine.git
cd metering-billing-engine
./setup.sh
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and log in:
- **Email:** `admin@eiot.energy`
- **Password:** `admin123`

### Option B: Cloud Supabase

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
  ./setup.sh --cloud             Cloud mode, interactive prompts
  ./setup.sh --cloud --url=URL --anon-key=KEY --service-role-key=KEY
                                 Cloud mode, non-interactive
  ./setup.sh --force             Overwrite existing .env.local
```

### Flags

| Flag | Description |
|------|-------------|
| `--local` | Use local Supabase via CLI (default if no mode specified) |
| `--cloud` | Use a hosted Supabase instance |
| `--url=URL` | Supabase project URL (cloud mode only) |
| `--anon-key=KEY` | Supabase anon/publishable key (cloud mode only) |
| `--service-role-key=KEY` | Supabase service role key (cloud mode only) |
| `--force` | Overwrite `.env.local` if it already exists |
| `--help`, `-h` | Show usage information and exit |

### What the script does

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

Both modes append OpenEMS B2B defaults to `.env.local`:
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

## Full-Stack Setup (with OpenEMS)

To test meter readings and billing generation, you need the OpenEMS stack running alongside MBE.

```bash
# Terminal 1: Start OpenEMS
cd ~/Projects/energy-iot/docker-openems
./setup.sh --edges 1

# Terminal 2: Start MBE
cd ~/Projects/energy-iot/metering-billing-engine
./setup.sh
npm run dev
```

The MBE connects to OpenEMS via the B2B REST API at `http://localhost:8075`. This is configured automatically by the setup script.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Docker daemon is not running` | Start Docker Desktop, then re-run `./setup.sh` |
| `supabase: command not found` | Install: `brew install supabase/tap/supabase` |
| `function gen_salt(unknown) does not exist` | Verify seed.sql uses `extensions.crypt()` / `extensions.gen_salt()`. Run `supabase db reset` to re-apply. |
| `.env.local already exists` | Use `./setup.sh --force` to overwrite |
| Login fails with "Invalid credentials" | Run `supabase db reset` to re-seed the admin user |
| `Failed to reach OpenEMS at localhost:8075` | Start the docker-openems stack first (see Full-Stack Setup) |
| Billing generation shows "No meter reading data" | Ensure OpenEMS edge simulations are running and meters are assigned to tenants |

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
   |   or Cloud Supabase (*.supabase.co)  <-- setup.sh --cloud
   |
   +-- OpenEMS Backend (localhost:8075)  <-- docker-openems
```
