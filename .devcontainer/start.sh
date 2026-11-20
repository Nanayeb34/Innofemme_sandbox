#!/bin/bash
# Runs each time the Codespace is opened: starts the sandbox if it is not already running,
# makes its address reachable from phones, and prints the organiser key and every team's link.
#   bash .devcontainer/start.sh           start (or show the links if it is already running)
#   bash .devcontainer/start.sh update    get the latest code for this branch, rebuild and restart
#   bash .devcontainer/start.sh stop      stop the sandbox
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
  echo "To use a laptop and a phone together: open a team link above on the LAPTOP (that is the console),"
  echo "then scan the customer or agent code shown on that page with the PHONE."
  echo "Sign in at ${PUBLIC_URL}/organiser to print every team's QR cards."
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

stop() {
  pkill -f next-server 2>/dev/null
  for _ in $(seq 1 10); do up || return 0; sleep 1; done
}

# "bash .devcontainer/start.sh update" fetches the latest code for this branch and restarts on it.
# Team worlds are kept.
if [ "${1:-}" = "update" ]; then
  echo "Getting the latest code..."
  git pull --ff-only || { echo "Could not update. If it mentions local changes, run: git stash    then try again."; exit 1; }
  stop
elif [ "${1:-}" = "stop" ]; then
  stop
  echo "The sandbox is stopped. Start it again with: bash .devcontainer/start.sh"
  exit 0
fi

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
echo "Get the latest code and restart:  bash .devcontainer/start.sh update"
echo "Stop it:                          bash .devcontainer/start.sh stop"
