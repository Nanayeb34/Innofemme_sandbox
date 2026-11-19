#!/bin/bash
# Runs once when the Codespace is created: installs dependencies and builds the app.
set -euo pipefail
cd "$(dirname "$0")/.."

DATA="${SANDBOX_DATA_DIR:-$HOME/.momo-sandbox}"
mkdir -p "$DATA" 2>/dev/null || { sudo mkdir -p "$DATA" && sudo chown "$(id -u):$(id -g)" "$DATA"; }

# pnpm, at the version the project pins.
corepack enable 2>/dev/null || sudo corepack enable 2>/dev/null || npm install -g pnpm@11

pnpm install --frozen-lockfile
pnpm build
git rev-parse HEAD > .next/.built-commit
