#!/bin/bash
# Runs each time the Codespace is opened: starts the sandbox if it is not already running,
# makes its address reachable from phones, and prints the organiser key and every team's link.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"
DATA="${SANDBOX_DATA_DIR:-$HOME/.momo-sandbox}"
LOG="$DATA/server.log"
mkdir -p "$DATA"

# The address people use. In a Codespace it is the forwarded HTTPS address, which is what the QR codes must carry.
if [ -n "${CODESPACE_NAME:-}" ]; then
  export PUBLIC_URL="https://${CODESPACE_NAME}-${PORT}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
else
  export PUBLIC_URL="http://localhost:${PORT}"
fi

up() { curl -s -o /dev/null --max-time 2 "http://localhost:${PORT}/"; }

show_links() {
  echo
  echo "================ Mobile Money Sandbox ================"
  pnpm -s sandbox:info "$PUBLIC_URL" 2>/dev/null
  echo
  echo "Sign in at ${PUBLIC_URL}/organiser to print every team's QR cards,"
  echo "or open a team link above: its page shows the customer and agent phone codes."
  echo "======================================================"
}

# Phones can only open the address if the port is public. A private port asks for a GitHub sign-in.
make_public() {
  [ -n "${CODESPACE_NAME:-}" ] || return 0
  if gh codespace ports visibility "${PORT}:public" -c "$CODESPACE_NAME" >/dev/null 2>&1; then
    echo "Port ${PORT} is public: phones can open the links."
  else
    echo
    echo "!! Could not make port ${PORT} public automatically. Do it by hand so phones can connect:"
    echo "!! Ports tab (next to Terminal) > right-click port ${PORT} > Port Visibility > Public."
  fi
}

if up; then
  echo "The sandbox is already running."
  make_public
  show_links
  exit 0
fi

# Build again when the code has changed since the last build (for example after a git pull).
if [ ! -f .next/BUILD_ID ] || [ "$(cat .next/.built-commit 2>/dev/null)" != "$(git rev-parse HEAD)" ]; then
  echo "Building the sandbox (about a minute)..."
  pnpm install --frozen-lockfile && pnpm build && git rev-parse HEAD > .next/.built-commit || { echo "Build failed. Fix the error above, then run: bash .devcontainer/start.sh"; exit 1; }
fi

echo "Starting the sandbox..."
nohup pnpm start -p "$PORT" > "$LOG" 2>&1 &
for _ in $(seq 1 40); do up && break; sleep 1; done
if ! up; then
  echo "The sandbox did not start. Last lines of $LOG:"
  tail -20 "$LOG"
  exit 1
fi

make_public
show_links
echo
echo "The sandbox keeps running if you close this terminal. Server log: $LOG"
echo "To stop it: pkill -f 'next start'      To start it again: bash .devcontainer/start.sh"
