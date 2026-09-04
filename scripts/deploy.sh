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
  local svc="${1:-control-plane}"
  local container_name="messenger-${svc}"
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    "$container_name" 2>/dev/null || true
}

status() {
  printf '=== Facebook Messenger AI Deployment Status ===\n'
  printf 'Active images:\n%s\n' "$(cat "$IMAGES_STATE" 2>/dev/null || echo "none")"
  printf 'Previous images:\n%s\n' "$(cat "$PREVIOUS_IMAGES_STATE" 2>/dev/null || echo "none")"
  for svc in control-plane scheduler ai-worker browser-agent; do
    printf '%s Health: %s\n' "$svc" "$(health_status "$svc")"
  done
  dc ps
}

# Parse options and images
DO_MIGRATE=false
RECONCILE=false
NEW_CONTROL_PLANE=""
NEW_SCHEDULER=""
NEW_AI_WORKER=""
NEW_BROWSER_AGENT=""

validate_digest() {
  local img="$1"
  [[ "$img" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] || \
    die "image must be an immutable GHCR digest: $img"
}

# Handle --status or empty args
if [[ "${1:-}" == "--status" ]]; then
  status
  exit 0
fi

if [[ $# -eq 0 ]]; then
  die "usage: $0 [--migrate] [--reconcile] [--control-plane <image>] [--scheduler <image>] [--ai-worker <image>] [--browser-agent <image>] | <control-plane-image> <scheduler-image> <ai-worker-image> <browser-agent-image> | --status"
fi

# Backward compatibility: 4 positional image arguments
if [[ $# -eq 4 && "$1" != --* ]]; then
  NEW_CONTROL_PLANE="$1"
  NEW_SCHEDULER="$2"
  NEW_AI_WORKER="$3"
  NEW_BROWSER_AGENT="$4"
else
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --migrate)
        DO_MIGRATE=true
        shift
        ;;
      --reconcile)
        RECONCILE=true
        shift
        ;;
      --control-plane)
        NEW_CONTROL_PLANE="$2"
        shift 2
        ;;
      --scheduler)
        NEW_SCHEDULER="$2"
        shift 2
        ;;
      --ai-worker)
        NEW_AI_WORKER="$2"
        shift 2
        ;;
      --browser-agent)
        NEW_BROWSER_AGENT="$2"
        shift 2
        ;;
      *)
        die "Unknown argument: $1"
        ;;
    esac
  done
fi

DEPLOYED_SERVICES=()
if [[ -n "$NEW_CONTROL_PLANE" ]]; then
  validate_digest "$NEW_CONTROL_PLANE"
  DEPLOYED_SERVICES+=(control-plane)
fi
if [[ -n "$NEW_SCHEDULER" ]]; then
  validate_digest "$NEW_SCHEDULER"
  DEPLOYED_SERVICES+=(scheduler)
fi
if [[ -n "$NEW_AI_WORKER" ]]; then
  validate_digest "$NEW_AI_WORKER"
  DEPLOYED_SERVICES+=(ai-worker)
fi
if [[ -n "$NEW_BROWSER_AGENT" ]]; then
  validate_digest "$NEW_BROWSER_AGENT"
  DEPLOYED_SERVICES+=(browser-agent)
fi

if [[ "${#DEPLOYED_SERVICES[@]}" -eq 0 && "$DO_MIGRATE" != true && "$RECONCILE" != true ]]; then
  die "no services, migration, or reconcile specified to deploy"
fi

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
  trap - ERR INT TERM HUP
  log "Deployment failed; rolling back to previous images (exit code: $exit_code)"
  if [[ -n "$PREVIOUS_DEPLOY_CONFIG" ]]; then
    printf '%s\n' "$PREVIOUS_DEPLOY_CONFIG" > "$DEPLOY_ENV"
    if [[ "${#DEPLOYED_SERVICES[@]}" -gt 0 ]]; then
      dc up -d --no-deps --no-build "${DEPLOYED_SERVICES[@]}" || true
    fi
    if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
      dc --profile tunnel up -d --no-deps tunnel || true
    fi
  fi
  exit "$exit_code"
}
trap rollback ERR INT TERM HUP

# P0: Resolve and write new deploy environment before pulling and migrating
CURRENT_CONTROL_PLANE="${NEW_CONTROL_PLANE:-$(grep -E '^CONTROL_PLANE_IMAGE=' "$DEPLOY_ENV" 2>/dev/null | cut -d= -f2- || true)}"
CURRENT_SCHEDULER="${NEW_SCHEDULER:-$(grep -E '^SCHEDULER_IMAGE=' "$DEPLOY_ENV" 2>/dev/null | cut -d= -f2- || true)}"
CURRENT_AI_WORKER="${NEW_AI_WORKER:-$(grep -E '^AI_WORKER_IMAGE=' "$DEPLOY_ENV" 2>/dev/null | cut -d= -f2- || true)}"
CURRENT_BROWSER_AGENT="${NEW_BROWSER_AGENT:-$(grep -E '^BROWSER_AGENT_IMAGE=' "$DEPLOY_ENV" 2>/dev/null | cut -d= -f2- || true)}"

cat > "$DEPLOY_ENV" <<EOF
CONTROL_PLANE_IMAGE=$CURRENT_CONTROL_PLANE
SCHEDULER_IMAGE=$CURRENT_SCHEDULER
AI_WORKER_IMAGE=$CURRENT_AI_WORKER
BROWSER_AGENT_IMAGE=$CURRENT_BROWSER_AGENT
EOF
chmod 600 "$DEPLOY_ENV"

# Pull new images using updated DEPLOY_ENV
PULL_SERVICES=("${DEPLOYED_SERVICES[@]}")
if [[ "$DO_MIGRATE" == true && ! " ${DEPLOYED_SERVICES[*]:-} " =~ " control-plane " ]]; then
  PULL_SERVICES+=(migrate)
fi
if [[ "${#PULL_SERVICES[@]}" -gt 0 ]]; then
  log "Pulling immutable images for: ${PULL_SERVICES[*]}"
  dc pull "${PULL_SERVICES[@]}"
fi

# P0: Ensure infra (Postgres & Redis) is running, but DO NOT recreate/restart if already running
ensure_infra() {
  local running_services
  running_services="$(dc ps --status running --services 2>/dev/null || true)"
  local to_start=()
  if ! grep -qx postgres <<< "$running_services"; then
    to_start+=(postgres)
  fi
  if ! grep -qx redis <<< "$running_services"; then
    to_start+=(redis)
  fi
  if [ "${#to_start[@]}" -gt 0 ]; then
    log "Starting infrastructure services: ${to_start[*]}"
    dc up -d "${to_start[@]}"
  fi
}
ensure_infra

# P0: DB Backup ONLY before migration, and run migration using the newly resolved & pulled image
if [[ "$DO_MIGRATE" == true ]]; then
  if dc ps --status running --services 2>/dev/null | grep -qx postgres; then
    backup_file="$BACKUP_DIR/messenger_ai_$(date -u '+%Y%m%d_%H%M%S').sql.gz"
    log "Backing up PostgreSQL database to $backup_file before migration"
    dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$backup_file"
    test -s "$backup_file" || die "database backup is empty"
  fi

  log "Running database migrations with updated control-plane image"
  dc run --rm migrate
fi

if [[ "${#DEPLOYED_SERVICES[@]}" -gt 0 ]]; then
  log "Starting updated application services: ${DEPLOYED_SERVICES[*]}"
  dc up -d --no-deps --no-build "${DEPLOYED_SERVICES[@]}"

  if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
    dc --profile tunnel up -d --no-deps tunnel
  fi
elif [[ "$RECONCILE" == true ]]; then
  log "Reconciling Compose configuration for running services"
  dc up -d --no-build

  if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]]; then
    dc --profile tunnel up -d --no-deps tunnel || true
  fi
fi

# Health check deployed or reconciled services
CHECK_SERVICES=("${DEPLOYED_SERVICES[@]}")
if [[ "${#CHECK_SERVICES[@]}" -eq 0 && "$RECONCILE" == true ]]; then
  CHECK_SERVICES=(control-plane scheduler ai-worker browser-agent)
fi

for svc in "${CHECK_SERVICES[@]}"; do
  log "Waiting for $svc to become healthy (timeout: ${READY_TIMEOUT}s)"
  for ((elapsed = 0; elapsed < READY_TIMEOUT; elapsed += 2)); do
    st="$(health_status "$svc")"
    if [[ "$st" == "healthy" ]]; then
      # Additional HTTP probe for control-plane
      if [[ "$svc" == "control-plane" ]]; then
        if curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3100/health >/dev/null; then
          break
        fi
      else
        break
      fi
    elif [[ "$st" == "running" ]]; then
      # Fallback for services without formal HEALTHCHECK in container definition
      break
    fi
    sleep 2
  done

  st="$(health_status "$svc")"
  if [[ "$st" != "healthy" && "$st" != "running" ]]; then
    dc logs --tail=100 "$svc" >&2 || true
    die "$svc did not become healthy within ${READY_TIMEOUT}s (status: $st)"
  fi
  log "Service $svc is healthy ($st)"
done

if [[ -f "$IMAGES_STATE" ]]; then
  cp "$IMAGES_STATE" "$PREVIOUS_IMAGES_STATE"
fi
cat > "$IMAGES_STATE" <<EOF
${CURRENT_CONTROL_PLANE:-none}
${CURRENT_SCHEDULER:-none}
${CURRENT_AI_WORKER:-none}
${CURRENT_BROWSER_AGENT:-none}
EOF

trap - ERR INT TERM HUP

# Prune old images only for deployed services
log "Pruning old application images while retaining active and rollback digests"
prune_service_images() {
  local new_img="$1"
  [[ -n "$new_img" && "$new_img" == *"@sha256:"* ]] || return 0
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

[[ -n "$NEW_CONTROL_PLANE" ]] && prune_service_images "$NEW_CONTROL_PLANE"
[[ -n "$NEW_SCHEDULER" ]] && prune_service_images "$NEW_SCHEDULER"
[[ -n "$NEW_AI_WORKER" ]] && prune_service_images "$NEW_AI_WORKER"
[[ -n "$NEW_BROWSER_AGENT" ]] && prune_service_images "$NEW_BROWSER_AGENT"

mapfile -t dangling_images < <(docker images --filter dangling=true --quiet)
if [ "${#dangling_images[@]}" -gt 0 ]; then
  docker image rm "${dangling_images[@]}" >/dev/null 2>&1 || true
fi

find "$BACKUP_DIR" -type f -name 'messenger_ai_*.sql.gz' -mtime +14 -delete 2>/dev/null || true

log "Deployment completed successfully"
status
