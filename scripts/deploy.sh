#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/opt/facebook-messenger-ai-rep"
COMPOSE="$APP_DIR/compose.prod.yml"
APP_ENV="$APP_DIR/.env"
DEPLOY_ENV="$APP_DIR/.deploy.env"
LOCK_FILE="$APP_DIR/.deploy.lock"
IMAGES_STATE="$APP_DIR/.deployed-images"
PREVIOUS_IMAGES_STATE="$APP_DIR/.previous-images"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
READY_TIMEOUT="${READY_TIMEOUT:-120}"

log() { printf '%s  %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
dc() {
  local env_args=(--env-file "$APP_ENV")
  if [[ -f "$DEPLOY_ENV" ]]; then
    env_args+=(--env-file "$DEPLOY_ENV")
  fi
  docker compose "${env_args[@]}" -f "$COMPOSE" "$@"
}

# shellcheck source=scripts/image-retention.sh
source "$APP_DIR/image-retention.sh"

health_status() {
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    messenger-control-plane 2>/dev/null || true
}

status() {
  printf '=== Facebook Messenger AI Deployment Status ===\n'
  printf 'Active images:\n%s\n' "$(cat "$IMAGES_STATE" 2>/dev/null || echo "none")"
  printf 'Previous images:\n%s\n' "$(cat "$PREVIOUS_IMAGES_STATE" 2>/dev/null || echo "none")"
  printf 'Control Plane Health: %s\n' "$(health_status)"
  dc ps
}

case "${1:-}" in
  --status)
    status
    exit 0
    ;;
  "")
    die "usage: $0 <control-plane-image> <scheduler-image> <ai-worker-image> <browser-agent-image> | --status"
    ;;
esac

[ "$#" -eq 4 ] || die "expected 4 image references, received $#"
for image in "$@"; do
  [[ "$image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] || \
    die "image must be an immutable GHCR digest: $image"
done

NEW_CONTROL_PLANE_IMAGE="$1"
NEW_SCHEDULER_IMAGE="$2"
NEW_AI_WORKER_IMAGE="$3"
NEW_BROWSER_AGENT_IMAGE="$4"

command -v docker >/dev/null || die "docker is required"
docker compose version >/dev/null || die "Docker Compose v2 is required"
command -v curl >/dev/null || die "curl is required"
[ -f "$COMPOSE" ] || die "$COMPOSE is missing"
[ -f "$APP_ENV" ] || die "$APP_ENV is missing"
chmod 600 "$APP_ENV"
CLOUDFLARE_TUNNEL_TOKEN="${CLOUDFLARE_TUNNEL_TOKEN:-$(grep -E '^CLOUDFLARE_TUNNEL_TOKEN=' "$APP_ENV" 2>/dev/null | cut -d= -f2- | tr -d '\r"' || true)}"

mkdir -p "$APP_DIR" "$BACKUP_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || die "another facebook-messenger-ai deployment is already running"

PREVIOUS_DEPLOY_CONFIG="$(cat "$DEPLOY_ENV" 2>/dev/null || true)"
rollback() {
  local exit_code=$?
  trap - ERR
  if [[ -n "$PREVIOUS_DEPLOY_CONFIG" ]]; then
    log "Deployment failed; rolling back to previous images"
    printf '%s\n' "$PREVIOUS_DEPLOY_CONFIG" > "$DEPLOY_ENV"
    dc up -d --no-deps --no-build control-plane scheduler ai-worker browser-agent || true
    if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
      dc --profile tunnel up -d --no-deps tunnel || true
    fi
  fi
  exit "$exit_code"
}
trap rollback ERR

if dc ps --status running --services 2>/dev/null | grep -qx postgres; then
  backup_file="$BACKUP_DIR/messenger_ai_$(date -u '+%Y%m%d_%H%M%S').sql.gz"
  log "Backing up PostgreSQL database to $backup_file"
  dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$backup_file"
  test -s "$backup_file" || die "database backup is empty"
fi

cat > "$DEPLOY_ENV" <<EOF
CONTROL_PLANE_IMAGE=$NEW_CONTROL_PLANE_IMAGE
SCHEDULER_IMAGE=$NEW_SCHEDULER_IMAGE
AI_WORKER_IMAGE=$NEW_AI_WORKER_IMAGE
BROWSER_AGENT_IMAGE=$NEW_BROWSER_AGENT_IMAGE
EOF
chmod 600 "$DEPLOY_ENV"

log "Pulling immutable application images"
dc pull control-plane scheduler ai-worker browser-agent

dc up -d postgres redis
log "Running database migrations"
dc run --rm migrate

log "Starting application services"
dc up -d --no-build --remove-orphans control-plane scheduler ai-worker browser-agent
if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
  dc --profile tunnel up -d --no-deps tunnel
fi

log "Waiting for control-plane to become healthy (timeout: ${READY_TIMEOUT}s)"
for ((elapsed = 0; elapsed < READY_TIMEOUT; elapsed += 2)); do
  if [[ "$(health_status)" == "healthy" ]] && \
    curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3100/health >/dev/null; then
    break
  fi
  sleep 2
done

if [[ "$(health_status)" != "healthy" ]]; then
  dc logs --tail=100 control-plane >&2 || true
  die "control-plane did not become healthy within ${READY_TIMEOUT}s"
fi

log "Deployment healthy: control-plane is answering /health"

if [[ -f "$IMAGES_STATE" ]]; then
  cp "$IMAGES_STATE" "$PREVIOUS_IMAGES_STATE"
fi
cat > "$IMAGES_STATE" <<EOF
$NEW_CONTROL_PLANE_IMAGE
$NEW_SCHEDULER_IMAGE
$NEW_AI_WORKER_IMAGE
$NEW_BROWSER_AGENT_IMAGE
EOF

trap - ERR

log "Pruning old application images while retaining active and previous rollback digests"
prune_service_images() {
  local new_img="$1"
  local repo="${new_img%@sha256:*}"
  local prev_img=""
  if [[ -f "$PREVIOUS_IMAGES_STATE" ]]; then
    prev_img="$(grep "^${repo}@" "$PREVIOUS_IMAGES_STATE" || true)"
  fi
  if [[ -n "$prev_img" && "$prev_img" != "$new_img" ]]; then
    prune_repository_images "$repo" "$new_img" "$prev_img"
  else
    prune_repository_images "$repo" "$new_img"
  fi
}

prune_service_images "$NEW_CONTROL_PLANE_IMAGE"
prune_service_images "$NEW_SCHEDULER_IMAGE"
prune_service_images "$NEW_AI_WORKER_IMAGE"
prune_service_images "$NEW_BROWSER_AGENT_IMAGE"

mapfile -t dangling_images < <(docker images --filter dangling=true --quiet)
if [ "${#dangling_images[@]}" -gt 0 ]; then
  docker image rm "${dangling_images[@]}" >/dev/null 2>&1 || true
fi

find "$BACKUP_DIR" -type f -name 'messenger_ai_*.sql.gz' -mtime +14 -delete

log "Deployment completed successfully"
status
