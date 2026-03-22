#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="$HOME/.openclaw/openclaw.json"
DEFAULTS_PATH="/tmp/openclaw-defaults.json"

# ── First run: seed the config ────────────────────────────────────────────────
if [ ! -f "$CONFIG_PATH" ]; then
  echo "[entrypoint] First run — seeding openclaw.json"
  mkdir -p "$(dirname "$CONFIG_PATH")"
  cp "$DEFAULTS_PATH" "$CONFIG_PATH"
fi

mkdir -p "$HOME/.openclaw"

# ── Inject channel credentials from environment variables ────────────────────
# We use Node.js (always available in the OpenClaw image) to merge channel
# config into the JSON without needing extra tools like jq or envsubst.

node - <<'EOF'
const fs = require('fs');
const path = process.env.HOME + '/.openclaw/openclaw.json';

let config;
try {
  // openclaw.json is JSON5 — strip single-line comments before parsing
  const raw = fs.readFileSync(path, 'utf-8').replace(/\/\/.*$/gm, '');
  config = JSON.parse(raw);
} catch (e) {
  console.error('[entrypoint] Could not parse openclaw.json:', e.message);
  process.exit(1);
}

config.channels = config.channels || {};
let changed = false;

// ── Telegram ─────────────────────────────────────────────────────────────────
const tgToken = process.env.TELEGRAM_BOT_TOKEN || '';
if (tgToken && tgToken !== '') {
  config.channels.telegram = {
    enabled: true,
    botToken: tgToken,   // OpenClaw uses "botToken", not "token"
    dmPolicy: 'open',
    allowFrom: ['*'],    // required when dmPolicy is "open"
  };
  changed = true;
  console.log('[entrypoint] Telegram channel configured');
} else {
  console.log('[entrypoint] TELEGRAM_BOT_TOKEN not set — Telegram channel skipped');
}

// ── Slack (Socket Mode) ───────────────────────────────────────────────────────
const slackApp = process.env.SLACK_APP_TOKEN || '';
const slackBot = process.env.SLACK_BOT_TOKEN || '';
if (slackApp && slackBot && slackApp !== '' && slackBot !== '') {
  config.channels.slack = {
    enabled: true,
    mode: 'socket',
    appToken: slackApp,
    botToken: slackBot,
    dmPolicy: 'open',
    allowFrom: ['*'],    // required when dmPolicy is "open"
  };
  changed = true;
  console.log('[entrypoint] Slack channel configured');
} else {
  console.log('[entrypoint] SLACK_APP_TOKEN / SLACK_BOT_TOKEN not set — Slack channel skipped');
}

if (changed) {
  fs.writeFileSync(path, JSON.stringify(config, null, 2));
  console.log('[entrypoint] openclaw.json updated with channel credentials');
}
EOF

# ── Start the gateway (foreground — required inside containers) ───────────────
exec openclaw gateway
