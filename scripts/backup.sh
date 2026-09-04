#!/usr/bin/env bash
set -eo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/messenger-ai}"
DATE=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/messenger_ai_${DATE}.sql.gz"

mkdir -p "${BACKUP_DIR}"

echo "Starting PostgreSQL backup: ${BACKUP_FILE}..."

docker compose -f compose.prod.yml exec -T postgres pg_dump -U "${POSTGRES_USER:-postgres}" "${POSTGRES_DB:-messenger_ai}" | gzip > "${BACKUP_FILE}"

echo "Backup completed successfully: ${BACKUP_FILE} ($(du -h "${BACKUP_FILE}" | cut -f1))"

# Retention policy: Keep 7 daily backups
echo "Applying daily retention (keeping last 7 backups)..."
find "${BACKUP_DIR}" -name "messenger_ai_*.sql.gz" -type f -mtime +7 -delete

echo "Backup job finished."
