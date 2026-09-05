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
  local svc="${1:-core}"
  local container_name="messenger-${svc}"
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    "$container_name" 2>/dev/null || true
}

status() {
  printf '=== Facebook Messenger AI Deployment Status ===\n'
  printf 'Active images:\n%s\n' "$(cat "$IMAGES_STATE" 2>/dev/null || echo "none")"
  printf 'Previous images:\n%s\n' "$(cat "$PREVIOUS_IMAGES_STATE" 2>/dev/null || echo "none")"
  for svc in postgres core browser-agent cloudflared; do
    printf '%s Health: %s\n' "$svc" "$(health_status "$svc")"
  done
  dc ps
}

# Parse options and images
DO_MIGRATE=false
RECONCILE=false
DO_RESET_DB=false
NEW_CORE=""
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
  die "usage: $0 [--migrate] [--reconcile] [--reset-db] [--core <image>] [--browser-agent <image>]"
fi

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
    --reset-db)
      DO_RESET_DB=true
      shift
      ;;
    --core|--control-plane) # backward compatibility for --control-plane
      NEW_CORE="$2"
      shift 2
      ;;
    --browser-agent)
      NEW_BROWSER_AGENT="$2"
      shift 2
      ;;
    *)
      # Support legacy positional arguments: <core_image> <browser_agent_image>
      if [[ -z "$NEW_CORE" ]]; then
        NEW_CORE="$1"
        shift
      elif [[ -z "$NEW_BROWSER_AGENT" ]]; then
        NEW_BROWSER_AGENT="$1"
        shift
      else
        die "Unknown argument: $1"
      fi
      ;;
  esac
done

DEPLOYED_SERVICES=()
if [[ -n "$NEW_CORE" ]]; then
  validate_digest "$NEW_CORE"
  DEPLOYED_SERVICES+=(core)
fi
if [[ -n "$NEW_BROWSER_AGENT" ]]; then
  validate_digest "$NEW_BROWSER_AGENT"
  DEPLOYED_SERVICES+=(browser-agent)
fi

if [[ "${#DEPLOYED_SERVICES[@]}" -eq 0 && "$DO_MIGRATE" != true && "$RECONCILE" != true && "$DO_RESET_DB" != true ]]; then
  die "no services, migration, reconcile, or reset-db specified to deploy"
fi

command -v docker >/dev/null || die "docker is required"
docker compose version >/dev/null || die "Docker Compose v2 is required"
command -v curl >/dev/null || die "curl is required"
[ -f "$COMPOSE" ] || die "$COMPOSE is missing"
[ -f "$APP_ENV" ] || die "$APP_ENV is missing"
chmod 600 "$APP_ENV"

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
  fi
  exit "$exit_code"
}
trap rollback ERR INT TERM HUP

# Ensure infrastructure (Postgres only; clean up obsolete Redis if present)
ensure_infra() {
  local running_services
  running_services="$(dc ps --status running --services 2>/dev/null || true)"
  local to_start=()
  if ! grep -qx postgres <<< "$running_services"; then
    to_start+=(postgres)
  fi
  if [ "${#to_start[@]}" -gt 0 ]; then
    log "Starting infrastructure service: ${to_start[*]}"
    dc up -d "${to_start[@]}"
  fi

  # Clean up obsolete Redis container if still lingering on VPS from previous architecture
  if docker ps -a --format '{{.Names}}' | grep -qx 'messenger-redis'; then
    log "Removing obsolete messenger-redis container"
    docker rm -f messenger-redis >/dev/null 2>&1 || true
  fi
}
ensure_infra

# Destructive reset: resets PostgreSQL app schema and drops obsolete redis volume.
# CRITICAL SAFETY: NEVER TOUCHES BROWSER PROFILE VOLUME (messenger_browser_profile).
if [[ "$DO_RESET_DB" == true ]]; then
  log "WARNING: Executing destructive database schema reset..."
  if dc ps --status running --services 2>/dev/null | grep -qx postgres; then
    backup_file="$BACKUP_DIR/messenger_ai_pre_reset_$(date -u '+%Y%m%d_%H%M%S').sql.gz"
    log "Backing up PostgreSQL database before destructive reset to $backup_file"
    dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$backup_file"
    log "Dropping and recreating public schema in PostgreSQL..."
    dc exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"'
  fi

  # Clean up legacy redis data volume if exists
  if docker volume ls --format '{{.Name}}' | grep -qx 'messenger_redis_data'; then
    log "Removing legacy messenger_redis_data volume"
    docker volume rm -f messenger_redis_data >/dev/null 2>&1 || true
  fi

  # Notice: messenger_browser_profile is intentionally PRESERVED.
  log "Browser profile (messenger_browser_profile) preserved intact."
  DO_MIGRATE=true
fi

# Resolve and write new deploy environment before pulling
CURRENT_CORE="$(grep -E '^CORE_IMAGE=' "$DEPLOY_ENV" 2>/dev/null | cut -d= -f2- || true)"
CURRENT_BROWSER_AGENT="$(grep -E '^BROWSER_AGENT_IMAGE=' "$DEPLOY_ENV" 2>/dev/null | cut -d= -f2- || true)"

[[ -n "$NEW_CORE" ]] && CURRENT_CORE="$NEW_CORE"
[[ -n "$NEW_BROWSER_AGENT" ]] && CURRENT_BROWSER_AGENT="$NEW_BROWSER_AGENT"

cat > "$DEPLOY_ENV" <<EOF
CORE_IMAGE=$CURRENT_CORE
BROWSER_AGENT_IMAGE=$CURRENT_BROWSER_AGENT
EOF
chmod 600 "$DEPLOY_ENV"

# Pull new images using updated DEPLOY_ENV
PULL_SERVICES=("${DEPLOYED_SERVICES[@]}")
if [[ "$DO_MIGRATE" == true && ! " ${DEPLOYED_SERVICES[*]:-} " =~ " core " ]]; then
  PULL_SERVICES+=(migrate)
fi
if [[ "${#PULL_SERVICES[@]}" -gt 0 ]]; then
  log "Pulling immutable images for: ${PULL_SERVICES[*]}"
  dc pull "${PULL_SERVICES[@]}"
fi

# DB Backup ONLY before migration, and run migration using the newly resolved & pulled image
if [[ "$DO_MIGRATE" == true ]]; then
  if dc ps --status running --services 2>/dev/null | grep -qx postgres; then
    backup_file="$BACKUP_DIR/messenger_ai_$(date -u '+%Y%m%d_%H%M%S').sql.gz"
    log "Backing up PostgreSQL database to $backup_file before migration"
    dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$backup_file"
    test -s "$backup_file" || die "database backup is empty"
  fi

  log "Running database migrations with updated core image"
  dc run --rm migrate
fi

if [[ "${#DEPLOYED_SERVICES[@]}" -gt 0 ]]; then
  log "Starting updated application services with selective restart: ${DEPLOYED_SERVICES[*]}"
  dc up -d --no-deps --no-build "${DEPLOYED_SERVICES[@]}"
elif [[ "$RECONCILE" == true ]]; then
  log "Reconciling Compose configuration for running services"
  dc up -d --no-build
fi

# Ensure cloudflared tunnel is running
if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" || -n "$(grep -E '^CLOUDFLARE_TUNNEL_TOKEN=' "$APP_ENV" 2>/dev/null | cut -d= -f2- | tr -d '\r"' || true)" ]]; then
  dc up -d --no-deps --no-build cloudflared 2>/dev/null || true
fi

# Health check deployed or reconciled services
CHECK_SERVICES=("${DEPLOYED_SERVICES[@]}")
if [[ "${#CHECK_SERVICES[@]}" -eq 0 && "$RECONCILE" == true ]]; then
  CHECK_SERVICES=(core browser-agent)
fi

for svc in "${CHECK_SERVICES[@]}"; do
  log "Waiting for $svc to become healthy (timeout: ${READY_TIMEOUT}s)"
  for ((elapsed = 0; elapsed < READY_TIMEOUT; elapsed += 2)); do
    st="$(health_status "$svc")"
    if [[ "$st" == "healthy" ]]; then
      # Additional HTTP probe for core
      if [[ "$svc" == "core" ]]; then
        if curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3000/readyz >/dev/null 2>&1 || [[ "$st" == "healthy" ]]; then
          break
        fi
      else
        break
      fi
    elif [[ "$st" == "running" ]]; then
      # Fallback for services without formal HEALTHCHECK
      break
    elif [[ "$st" == "unhealthy" ]]; then
      die "service $svc reported unhealthy during deployment"
    fi
    sleep 2
  done

  st="$(health_status "$svc")"
  if [[ "$st" != "healthy" && "$st" != "running" ]]; then
    die "service $svc failed to reach healthy state within ${READY_TIMEOUT}s (status: $st)"
  fi
  log "Service $svc is healthy ($st)"
done

# Persist release manifest
cp -f "$DEPLOY_ENV" "$IMAGES_STATE"
if [[ -n "$PREVIOUS_DEPLOY_CONFIG" ]]; then
  printf '%s\n' "$PREVIOUS_DEPLOY_CONFIG" > "$PREVIOUS_IMAGES_STATE"
fi

# Retention policy: prune old images keeping current and previous rollback
prune_service_images() {
  local new_img="$1"
  local repo="${new_img%@*}"
  local prev_img
  prev_img="$(grep -E "^[A-Z_]+_IMAGE=" "$PREVIOUS_IMAGES_STATE" 2>/dev/null | grep "$repo" | cut -d= -f2- || true)"

  if [[ -n "$prev_img" && "$prev_img" != "$new_img" ]]; then
    prune_repository_images "$repo" "$new_img" "$prev_img"
  else
    prune_repository_images "$repo" "$new_img"
  fi
}

[[ -n "$NEW_CORE" ]] && prune_service_images "$NEW_CORE"
[[ -n "$NEW_BROWSER_AGENT" ]] && prune_service_images "$NEW_BROWSER_AGENT"

mapfile -t dangling_images < <(docker images --filter dangling=true --quiet)
if [ "${#dangling_images[@]}" -gt 0 ]; then
  docker image rm "${dangling_images[@]}" >/dev/null 2>&1 || true
fi

find "$BACKUP_DIR" -type f -name 'messenger_ai_*.sql.gz' -mtime +14 -delete 2>/dev/null || true

log "Deployment completed successfully"
status
