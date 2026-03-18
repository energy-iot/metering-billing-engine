#!/usr/bin/env bash
# setup.sh — One-command bootstrap for the Metering & Billing Engine.
# Supports local Supabase (via CLI + Docker) or cloud Supabase instances.
#
# Usage:
#   ./setup.sh                     # local mode (default)
#   ./setup.sh --local             # explicit local mode
#   ./setup.sh --docker            # docker mode, full stack in Docker
#   ./setup.sh --cloud             # cloud mode, interactive prompts
#   ./setup.sh --cloud --url=URL --anon-key=KEY --service-role-key=KEY
#                                  # cloud mode, non-interactive
#   ./setup.sh --force             # overwrite existing .env.local

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn() { echo -e "${YELLOW}[setup]${NC} $*"; }
err()  { echo -e "${RED}[setup]${NC} $*" >&2; }

# ── Flag parsing ─────────────────────────────────────────────────────
MODE="local"
FORCE=false
CLOUD_URL=""
CLOUD_ANON_KEY=""
CLOUD_SERVICE_ROLE_KEY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --local)  MODE="local"; shift ;;
    --docker) MODE="docker"; shift ;;
    --cloud)  MODE="cloud"; shift ;;
    --force)  FORCE=true; shift ;;
    --url=*)  CLOUD_URL="${1#--url=}"; shift ;;
    --anon-key=*)  CLOUD_ANON_KEY="${1#--anon-key=}"; shift ;;
    --service-role-key=*)  CLOUD_SERVICE_ROLE_KEY="${1#--service-role-key=}"; shift ;;
    --help|-h)
      echo "Usage:"
      echo "  ./setup.sh                     Local mode (default)"
      echo "  ./setup.sh --local             Explicit local mode"
      echo "  ./setup.sh --docker            Docker mode, full stack in Docker"
      echo "  ./setup.sh --cloud             Cloud mode, interactive prompts"
      echo "  ./setup.sh --cloud --url=URL --anon-key=KEY --service-role-key=KEY"
      echo "                                 Cloud mode, non-interactive"
      echo "  ./setup.sh --force             Overwrite existing .env.local"
      echo ""
      echo "See docs/setup.md for full documentation."
      exit 0
      ;;
    *)  err "Unknown argument: $1"; exit 1 ;;
  esac
done

# ── Prerequisite checks ─────────────────────────────────────────────
check_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "$1 is required but not installed."
    [ -n "${2:-}" ] && err "  Install: $2"
    exit 1
  fi
}

log "Mode: ${MODE}"
log ""

if [ "$MODE" = "docker" ]; then
  # Docker mode: only needs docker + docker compose
  check_command "docker" "https://www.docker.com/products/docker-desktop/"

  if ! docker info >/dev/null 2>&1; then
    err "Docker daemon is not running. Start Docker Desktop and try again."
    exit 1
  fi

  if ! docker compose version >/dev/null 2>&1; then
    err "docker compose is required but not available."
    err "  Install Docker Desktop 4.0+ which includes docker compose."
    exit 1
  fi
else
  # Local/cloud modes: need node + npm
  check_command "node" "https://nodejs.org/ or brew install node"
  check_command "npm" "bundled with Node.js"

  if [ "$MODE" = "local" ]; then
    check_command "docker" "https://www.docker.com/products/docker-desktop/"

    # Check Docker daemon is running
    if ! docker info >/dev/null 2>&1; then
      err "Docker daemon is not running. Start Docker Desktop and try again."
      exit 1
    fi

    check_command "supabase" "brew install supabase/tap/supabase"
  fi
fi

log "Prerequisites OK"
log ""

# ── Helper: generate .env.local ──────────────────────────────────────
generate_env_local() {
  local supabase_url="$1"
  local anon_key="$2"
  local service_role_key="$3"

  cat > .env.local <<ENVEOF
NEXT_PUBLIC_SUPABASE_URL=${supabase_url}
NEXT_PUBLIC_SUPABASE_ANON_KEY=${anon_key}
SUPABASE_SERVICE_ROLE_KEY=${service_role_key}

# OpenEMS B2B REST API
OPENEMS_B2B_URL=http://localhost:8075
OPENEMS_B2B_USERNAME=admin
OPENEMS_B2B_PASSWORD=Icui4cyou
ENVEOF
}

# ── Helper: check existing .env.local ────────────────────────────────
check_existing_env() {
  if [ -f .env.local ] && [ "$FORCE" = false ]; then
    local existing_url
    existing_url=$(grep '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | cut -d= -f2- || echo "")
    if echo "$existing_url" | grep -qE '(localhost|127\.0\.0\.1)'; then
      warn ".env.local already exists (pointing at local Supabase)"
    else
      warn ".env.local already exists (pointing at ${existing_url})"
    fi
    warn "Use --force to overwrite"
    return 1
  fi
  return 0
}

# ── Docker mode ──────────────────────────────────────────────────────
if [ "$MODE" = "docker" ]; then
  if [ "$FORCE" = true ]; then
    log "Force mode: tearing down existing containers and volumes..."
    docker compose down -v
  fi

  log "Building and starting Docker stack..."
  docker compose up --build -d

  log "Waiting for app to be ready..."
  RETRIES=0
  MAX_RETRIES=60
  until curl -sf http://localhost:3000/ >/dev/null 2>&1; do
    RETRIES=$((RETRIES + 1))
    if [ "$RETRIES" -ge "$MAX_RETRIES" ]; then
      err "App did not become ready within ${MAX_RETRIES} seconds."
      err "Check logs with: docker compose logs"
      exit 1
    fi
    sleep 1
  done

  log ""
  log "=== Setup Complete (docker mode) ==="
  log ""
  log "  App:         http://localhost:3000"
  log "  Supabase:    http://localhost:54321"
  log ""
  log "  Login:       admin@eiot.energy / admin123"
  log ""
  log "Useful commands:"
  log "  docker compose logs -f         Follow logs"
  log "  docker compose stop            Stop (preserves data)"
  log "  docker compose down            Stop + remove containers (preserves data)"
  log "  docker compose down -v         Stop + remove everything (fresh start)"
  log ""

# ── Local mode ───────────────────────────────────────────────────────
elif [ "$MODE" = "local" ]; then
  # Step 1: Start local Supabase
  log "Starting local Supabase..."
  supabase start

  # Step 2: Apply migrations + seed
  if [ -f .env.local ] && [ "$FORCE" = false ]; then
    # Re-run scenario — skip db reset to preserve data
    log "Supabase already configured. Skipping db reset (use --force to reset database)."
  else
    log "Applying migrations and seed data..."
    supabase db reset --yes
  fi

  # Step 3: Generate .env.local
  if check_existing_env; then
    log "Generating .env.local from local Supabase..."

    # Map supabase status env var names to the names our app expects
    supabase status -o env 2>/dev/null | awk -F= '
      /^API_URL=/ { print "NEXT_PUBLIC_SUPABASE_URL=" substr($0, index($0,"=")+1) }
      /^ANON_KEY=/ { print "NEXT_PUBLIC_SUPABASE_ANON_KEY=" substr($0, index($0,"=")+1) }
      /^SERVICE_ROLE_KEY=/ { print "SUPABASE_SERVICE_ROLE_KEY=" substr($0, index($0,"=")+1) }
    ' > .env.local

    # Validate we got all three values
    if ! grep -q '^NEXT_PUBLIC_SUPABASE_URL=' .env.local || \
       ! grep -q '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' .env.local || \
       ! grep -q '^SUPABASE_SERVICE_ROLE_KEY=' .env.local; then
      err "Failed to extract Supabase credentials from 'supabase status'"
      rm -f .env.local
      exit 1
    fi

    # Append OpenEMS defaults
    cat >> .env.local <<'ENVEOF'

# OpenEMS B2B REST API
OPENEMS_B2B_URL=http://localhost:8075
OPENEMS_B2B_USERNAME=admin
OPENEMS_B2B_PASSWORD=Icui4cyou
ENVEOF

    log ".env.local created (local mode)"
  fi

  # Step 4: Install dependencies
  log "Installing npm dependencies..."
  npm install

  # Step 5: Summary
  log ""
  log "=== Setup Complete (local mode) ==="
  log ""
  log "  App:         http://localhost:3000"
  log "  Studio:      http://127.0.0.1:54323"
  log "  Inbucket:    http://127.0.0.1:54324"
  log "  Database:    postgresql://postgres:postgres@127.0.0.1:54322/postgres"
  log ""
  log "  Login:       admin@eiot.energy / admin123"
  log ""
  log "Next steps:"
  log "  npm run dev"
  log ""

# ── Cloud mode ───────────────────────────────────────────────────────
elif [ "$MODE" = "cloud" ]; then
  # Step 1: Collect credentials
  HAS_FLAGS=false

  if [ -n "$CLOUD_URL" ] || [ -n "$CLOUD_ANON_KEY" ] || [ -n "$CLOUD_SERVICE_ROLE_KEY" ]; then
    HAS_FLAGS=true
  fi

  if [ "$HAS_FLAGS" = true ]; then
    # Non-interactive: all three must be provided
    if [ -z "$CLOUD_URL" ] || [ -z "$CLOUD_ANON_KEY" ] || [ -z "$CLOUD_SERVICE_ROLE_KEY" ]; then
      err "Provide all three flags (--url, --anon-key, --service-role-key) or none for interactive mode."
      exit 1
    fi
  else
    # Interactive: prompt for all three
    log "Enter your Supabase project credentials:"
    echo ""
    read -rp "  Supabase URL: " CLOUD_URL
    read -rp "  Anon key: " CLOUD_ANON_KEY
    read -rp "  Service role key: " CLOUD_SERVICE_ROLE_KEY
    echo ""
  fi

  # Validate
  if [ -z "$CLOUD_URL" ] || [ -z "$CLOUD_ANON_KEY" ] || [ -z "$CLOUD_SERVICE_ROLE_KEY" ]; then
    err "All three Supabase credentials are required."
    exit 1
  fi

  if ! echo "$CLOUD_URL" | grep -qE '^https://'; then
    warn "Supabase URL should start with https:// (got: ${CLOUD_URL})"
  fi

  # Step 2: Generate .env.local
  if check_existing_env; then
    log "Generating .env.local (cloud mode)..."
    generate_env_local "$CLOUD_URL" "$CLOUD_ANON_KEY" "$CLOUD_SERVICE_ROLE_KEY"
    log ".env.local created (cloud mode)"
  fi

  # Step 3: Install dependencies
  log "Installing npm dependencies..."
  npm install

  # Step 4: Summary
  log ""
  log "=== Setup Complete (cloud mode) ==="
  log ""
  log "  App:         http://localhost:3000"
  log "  Supabase:    ${CLOUD_URL}"
  log ""
  log "Next steps:"
  log "  npm run dev"
  log ""
fi
