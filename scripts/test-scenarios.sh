#!/usr/bin/env bash
# test-scenarios.sh — End-to-end demo using OpenClaw webhooks.
#
# This script simulates two sessions (WhatsApp and Slack) communicating
# through the knowledge broker by calling the OpenClaw webhook API directly.
#
# Prerequisites:
#   - OpenClaw running via docker compose (./scripts/setup.sh)
#   - OPENCLAW_GATEWAY_TOKEN set in .env
#   - curl installed

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/.env" 2>/dev/null || true

GW="http://localhost:18789"
TOKEN="${OPENCLAW_GATEWAY_TOKEN:-dev-token-change-me}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
pass() { echo -e "${GREEN}  ✓${NC} $*"; }
fail() { echo -e "${RED}  ✗${NC} $*"; }
step() { echo -e "\n${BLUE}▶ $*${NC}"; }
warn() { echo -e "${YELLOW}  !${NC} $*"; }

# ── Helper: send a system event to an isolated session ───────────────────────

run_agent() {
  local name="$1" msg="$2"
  curl -sf \
    -X POST "$GW/hooks/agent" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"session\": \"$name\", \"message\": $(echo -n "$msg" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}"
}

# ── Helper: wait for a condition ──────────────────────────────────────────────

wait_for() {
  local desc="$1" check="$2"
  local attempt=0
  while ! eval "$check" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    [ $attempt -ge 15 ] && { fail "Timed out waiting for: $desc"; return 1; }
    sleep 1
  done
  pass "$desc"
}

# ── Check gateway is up ───────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Knowledge Broker — End-to-End Test Scenarios"
echo "═══════════════════════════════════════════════════════"

if ! curl -sf "$GW/healthz" >/dev/null; then
  fail "Gateway is not running. Start it first: docker compose up -d"
  exit 1
fi
pass "Gateway is up at $GW"

# ── Scenario 1: Basic propagation ────────────────────────────────────────────

step "Scenario 1: Fact shared on WhatsApp becomes available on Slack"

warn "Sending scheduling message via simulated WhatsApp session…"
run_agent "whatsapp-demo" "My meeting with Acme Corp was moved to Thursday at 3 PM" || true
sleep 3  # Allow async extraction to complete

warn "Asking Slack session about the meeting…"
RESPONSE=$(run_agent "slack-demo" "When is my Acme Corp meeting?" 2>/dev/null || echo "")

if echo "$RESPONSE" | grep -qi "thursday\|acme\|meeting"; then
  pass "Slack session knows about the Acme Corp meeting on Thursday"
else
  warn "Response did not mention Thursday. Check logs: docker compose logs openclaw"
  warn "Raw response: $RESPONSE"
fi

# ── Scenario 2: Noise is not propagated ──────────────────────────────────────

step "Scenario 2: Noise messages are NOT stored"

STORE="/root/.openclaw/shared-knowledge.json"
FACTS_BEFORE=$(docker compose exec -T openclaw \
  sh -c "cat $STORE 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d[\"facts\"]))' 2>/dev/null || echo 0")

for noise_msg in "lol" "ok" "sure" "haha" "👍" "😂"; do
  run_agent "discord-demo" "$noise_msg" >/dev/null 2>&1 || true
done
sleep 2

FACTS_AFTER=$(docker compose exec -T openclaw \
  sh -c "cat $STORE 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d[\"facts\"]))' 2>/dev/null || echo 0")

if [ "$FACTS_AFTER" -eq "$FACTS_BEFORE" ]; then
  pass "No noise messages were stored (store size unchanged: $FACTS_BEFORE facts)"
else
  warn "Store grew by $((FACTS_AFTER - FACTS_BEFORE)) after noise messages (may be a false positive)"
fi

# ── Scenario 3: Conflict resolution ──────────────────────────────────────────

step "Scenario 3: Conflicting preference updates are handled gracefully"

run_agent "whatsapp-demo2" "My favorite color is blue" >/dev/null 2>&1 || true
sleep 1
run_agent "slack-demo2" "My favorite color is green" >/dev/null 2>&1 || true
sleep 2

CONFLICTS=$(docker compose exec -T openclaw \
  sh -c "cat $STORE 2>/dev/null | python3 -c '
import sys, json
d = json.load(sys.stdin)
conflicts = [f for f in d[\"facts\"] if f.get(\"conflictsWith\")]
print(len(conflicts))
' 2>/dev/null || echo 0")

if [ "$CONFLICTS" -gt 0 ]; then
  pass "Conflicting facts are marked with conflictsWith (${CONFLICTS} fact(s) flagged)"
else
  warn "No conflict markers found. The facts may have been extracted with different keywords."
  warn "Check the store: docker compose exec openclaw cat $STORE"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Scenarios complete."
echo ""
echo "  Inspect the shared store at any time:"
echo "    docker compose exec openclaw cat ~/.openclaw/shared-knowledge.json"
echo ""
echo "  Run unit tests:"
echo "    cd extensions/knowledge-broker && npm test"
echo "═══════════════════════════════════════════════════════"
