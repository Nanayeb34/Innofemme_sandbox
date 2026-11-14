#!/bin/bash
# First-boot setup for the sandbox VM (Debian 12): Docker, Compose and registry access.
set -euo pipefail
if ! command -v docker >/dev/null; then
  apt-get update
  apt-get install -y ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
mkdir -p /opt/momo-sandbox /var/lib/momo-sandbox
touch /etc/momo-sandbox.env && chmod 600 /etc/momo-sandbox.env
REGION=$(curl -s -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/attributes/registry-region || true)
[ -n "$REGION" ] && gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
