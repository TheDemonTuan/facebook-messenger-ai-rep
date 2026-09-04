#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/facebook-messenger-ai-rep}"
DEPLOY_USER="${SUDO_USER:-$(id -un)}"

[ "$(id -u)" -eq 0 ] || { echo "Run this script with sudo." >&2; exit 1; }
command -v docker >/dev/null || { echo "Docker is required." >&2; exit 1; }
docker compose version >/dev/null || { echo "Docker Compose v2 is required." >&2; exit 1; }

install -d -o root -g root -m 0755 "$APP_DIR"
install -d -o root -g root -m 0750 "$APP_DIR/backups"
install -o root -g root -m 0644 compose.prod.yml "$APP_DIR/compose.prod.yml"
install -o root -g root -m 0755 scripts/deploy.sh "$APP_DIR/deploy.sh"
install -o root -g root -m 0755 scripts/image-retention.sh "$APP_DIR/image-retention.sh"

if [ ! -f "$APP_DIR/.env" ]; then
  install -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0600 .env.example "$APP_DIR/.env"
  echo "Created $APP_DIR/.env. Replace every placeholder before the first deploy."
fi

chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"
usermod -aG docker "$DEPLOY_USER" 2>/dev/null || true

cat <<EOF
VPS bootstrap complete.

Next:
1. Edit $APP_DIR/.env and replace every placeholder.
2. Add the GitHub Actions production secrets.
3. Push to main or run the Build and deploy workflow manually.
EOF
