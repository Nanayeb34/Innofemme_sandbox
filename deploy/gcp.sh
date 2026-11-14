#!/bin/bash
# Deploys the sandbox to one Compute Engine VM.
#
#   PROJECT=<gcp project id> DOMAIN=hackathon.innofemme.org deploy/gcp.sh setup     # once: APIs, registry, IP, firewall, VM
#   PROJECT=... DOMAIN=... deploy/gcp.sh secrets                                     # copy keys from .env.production to the VM
#   PROJECT=... DOMAIN=... deploy/gcp.sh release                                     # build the image and (re)start the app
#   PROJECT=... deploy/gcp.sh status | logs | ssh
set -euo pipefail

: "${PROJECT:?set PROJECT to the GCP project id}"
REGION="${REGION:-africa-south1}"
ZONE="${ZONE:-${REGION}-a}"
VM="${VM:-momo-sandbox}"
REPO="${REPO:-momo-sandbox}"
MACHINE="${MACHINE:-e2-standard-2}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_BASE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/app"
G="gcloud --project=${PROJECT}"

ssh_vm() { $G compute ssh "$VM" --zone="$ZONE" --quiet --command="$1"; }

case "${1:-}" in
  setup)
    : "${DOMAIN:?set DOMAIN, e.g. hackathon.innofemme.org}"
    $G services enable compute.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com
    $G artifacts repositories describe "$REPO" --location="$REGION" >/dev/null 2>&1 ||
      $G artifacts repositories create "$REPO" --repository-format=docker --location="$REGION" --description="MoMo fraud sandbox images"
    $G compute addresses describe "$VM-ip" --region="$REGION" >/dev/null 2>&1 ||
      $G compute addresses create "$VM-ip" --region="$REGION"
    $G compute firewall-rules describe allow-web >/dev/null 2>&1 ||
      $G compute firewall-rules create allow-web --allow=tcp:80,tcp:443,udp:443 --target-tags=web --description="HTTP/HTTPS to web servers"
    IP=$($G compute addresses describe "$VM-ip" --region="$REGION" --format='value(address)')
    $G compute instances describe "$VM" --zone="$ZONE" >/dev/null 2>&1 ||
      $G compute instances create "$VM" --zone="$ZONE" --machine-type="$MACHINE" \
        --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=30GB --boot-disk-type=pd-balanced \
        --address="$IP" --tags=web --scopes=cloud-platform \
        --metadata="registry-region=${REGION}" --metadata-from-file=startup-script="$ROOT/deploy/vm-startup.sh"
    echo
    echo "VM ready at $IP. Ask your DNS admin to add:  A  ${DOMAIN%%.*}  ->  $IP   (for ${DOMAIN})"
    ;;

  secrets)
    : "${DOMAIN:?set DOMAIN}"
    SRC="${ENV_FILE:-$ROOT/.env.production}"
    [ -f "$SRC" ] || { echo "Create $SRC with OPENAI_API_KEY and ORGANISER_KEY first (see .env.example)"; exit 1; }
    TMP=$(mktemp)
    trap 'rm -f "$TMP"' EXIT
    grep -E '^(OPENAI_API_KEY|OPENAI_MODEL|OPENAI_BASE_URL|ORGANISER_KEY|AI_DAILY_TOKEN_BUDGET|SANDBOX_TEAMS|SANDBOX_SEED)=' "$SRC" >"$TMP" || true
    printf 'DOMAIN=%s\nPUBLIC_URL=https://%s\n' "$DOMAIN" "$DOMAIN" >>"$TMP"
    $G compute scp "$TMP" "$VM:/tmp/momo.env" --zone="$ZONE" --quiet
    ssh_vm "sudo install -m 600 /tmp/momo.env /etc/momo-sandbox.env && rm /tmp/momo.env && cd /opt/momo-sandbox && [ -f .env ] && sudo docker compose up -d --force-recreate || true"
    echo "Secrets installed on $VM (values not shown)."
    ;;

  release)
    TAG="$(git -C "$ROOT" rev-parse --short HEAD)$(git -C "$ROOT" diff --quiet || echo -dirty)"
    if [ "${BUILD:-cloud}" = cloud ]; then
      # Cloud Build + Artifact Registry (needs the build service account to hold Cloud Build roles).
      IMAGE="${IMAGE_BASE}:${TAG}"
      $G builds submit "$ROOT" --tag="$IMAGE" --region="$REGION"
      PULL="sudo docker compose pull -q"
    else
      # BUILD=local: build here and copy the image over SSH (no registry needed).
      IMAGE="momo-sandbox:${TAG}"
      docker build --platform linux/amd64 -t "$IMAGE" "$ROOT"
      docker save "$IMAGE" | gzip >"/tmp/momo-image.tar.gz"
      $G compute scp "/tmp/momo-image.tar.gz" "$VM:/tmp/" --zone="$ZONE" --quiet
      rm -f /tmp/momo-image.tar.gz
      PULL="gunzip -c /tmp/momo-image.tar.gz | sudo docker load -q && rm /tmp/momo-image.tar.gz"
    fi
    $G compute scp "$ROOT/deploy/docker-compose.yml" "$ROOT/deploy/Caddyfile" "$VM:/tmp/" --zone="$ZONE" --quiet
    ssh_vm "set -e; cd /opt/momo-sandbox && sudo mv /tmp/docker-compose.yml /tmp/Caddyfile . && echo IMAGE=${IMAGE} | sudo tee .env >/dev/null && ${PULL} && sudo docker compose up -d && sudo docker image prune -f >/dev/null"
    echo "Released ${IMAGE}"
    ;;

  status) ssh_vm "cd /opt/momo-sandbox && sudo docker compose ps" ;;
  logs) ssh_vm "cd /opt/momo-sandbox && sudo docker compose logs --tail=${LINES:-100}" ;;
  ssh) $G compute ssh "$VM" --zone="$ZONE" ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
esac
