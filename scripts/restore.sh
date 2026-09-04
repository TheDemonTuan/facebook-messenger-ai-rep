#!/usr/bin/env bash
set -eo pipefail

if [ -z "$1" ]; then
  echo "Usage: $0 <path_to_backup.sql.gz>"
  exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "${BACKUP_FILE}" ]; then
  echo "Error: Backup file not found: ${BACKUP_FILE}"
  exit 1
fi

echo "WARNING: Restoring will overwrite database ${POSTGRES_DB:-messenger_ai}!"
read -p "Are you sure you want to proceed? (yes/no): " CONFIRM
if [ "${CONFIRM}" != "yes" ]; then
  echo "Restore aborted."
  exit 0
fi

echo "Restoring from ${BACKUP_FILE}..."
gunzip -c "${BACKUP_FILE}" | docker compose -f compose.prod.yml exec -T postgres psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-messenger_ai}"

echo "Database restore completed successfully."
