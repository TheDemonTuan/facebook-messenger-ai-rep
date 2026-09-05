#!/usr/bin/env bash
set -eo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/messenger-ai}"
DATE=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/messenger_ai_${DATE}.sql.gz"

mkdir -p "${BACKUP_DIR}"

echo "Starting PostgreSQL backup: ${BACKUP_FILE}..."

docker compose -f compose.prod.yml exec -T postgres pg_dump -U "${POSTGRES_USER:-messenger_user}" "${POSTGRES_DB:-messenger_ai}" | gzip > "${BACKUP_FILE}"

# Verify backup file exists and is non-empty
test -s "${BACKUP_FILE}" || { echo "ERROR: PostgreSQL backup file is empty or missing!"; exit 1; }

echo "Backup completed successfully: ${BACKUP_FILE} ($(du -h "${BACKUP_FILE}" | cut -f1))"

# Retention policy: Keep last 14 backups
echo "Applying retention policy (keeping last 14 backups)..."
find "${BACKUP_DIR}" -name "messenger_ai_*.sql.gz" -type f -mtime +14 -delete

echo "Backup job finished."
