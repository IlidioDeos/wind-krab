#!/usr/bin/env bash
# setup.sh — One-command setup for the Knowledge Broker demo
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn()  { echo -e "${YELLOW}[setup]${NC} $*"; }
error() { echo -e "${RED}[setup]${NC} $*" >&2; exit 1; }

# ── 1. Prerequisites ──────────────────────────────────────────────────────────

info "Checking prerequisites…"

command -v docker >/dev/null 2>&1 || error "Docker not found. Install Docker Desktop: https://www.docker.com/products/docker-desktop"
command -v node   >/dev/null 2>&1 || warn  "Node.js not found — needed for running tests locally. Install: https://nodejs.org"

# ── 2. Environment file ───────────────────────────────────────────────────────

if [ ! -f .env ]; then
  cp .env.example .env
  warn ".env created from .env.example"
  warn "→ Open .env and set your OPENROUTER_API_KEY before continuing"
  warn "→ Then re-run this script"
  exit 0
fi

# shellcheck disable=SC1091
source .env

if [[ -z "${OPENROUTER_API_KEY:-}" || "${OPENROUTER_API_KEY}" == "sk-or-..." ]]; then
  error "OPENROUTER_API_KEY is not set in .env. Edit .env and try again."
fi

# ── 3. Build the plugin (TypeScript → JavaScript) ────────────────────────────

info "Installing plugin dependencies…"
cd extensions/knowledge-broker
npm install --silent
info "Compiling TypeScript…"
npm run build
cd "$ROOT"

# ── 4. Build and start Docker ─────────────────────────────────────────────────

info "Building Docker image (this may take a few minutes on first run)…"
docker compose build

info "Starting OpenClaw gateway…"
docker compose up -d

info "Waiting for the gateway to become healthy…"
attempt=0
until docker compose exec openclaw curl -sf http://localhost:18789/healthz >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ $attempt -ge 30 ] && error "Gateway did not become healthy within 60 seconds. Check: docker compose logs openclaw"
  sleep 2
done

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Knowledge Broker is up and running!                        ║${NC}"
echo -e "${GREEN}║                                                              ║${NC}"
echo -e "${GREEN}║  Gateway: http://localhost:18789                             ║${NC}"
echo -e "${GREEN}║  Logs:    docker compose logs -f openclaw                   ║${NC}"
echo -e "${GREEN}║  Stop:    docker compose down                                ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "Next steps:"
echo "  • Pair a messaging channel: docker compose exec openclaw openclaw channels login --channel telegram"
echo "  • Run the test scenarios:   ./scripts/test-scenarios.sh"
echo "  • Run unit tests:           cd extensions/knowledge-broker && npm test"
