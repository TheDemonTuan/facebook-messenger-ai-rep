#!/usr/bin/env bash
set -euo pipefail

DB_URL="${DATABASE_URL:-postgresql://postgres@127.0.0.1:5432/messenger_ai_test}"
BACKUP_FILE="${RUNNER_TEMP:-/tmp}/messenger-ai-acceptance.sql.gz"
RESTORE_DB="messenger_ai_restore_test"
PG_CLIENT=(docker run --network host --rm postgres:17-alpine)

"${PG_CLIENT[@]}" psql "$DB_URL" -v ON_ERROR_STOP=1 -c "CREATE TABLE IF NOT EXISTS acceptance_restore_probe (id integer PRIMARY KEY, value text NOT NULL);"
"${PG_CLIENT[@]}" psql "$DB_URL" -v ON_ERROR_STOP=1 -c "INSERT INTO acceptance_restore_probe (id, value) VALUES (1, 'verified') ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value;"
"${PG_CLIENT[@]}" pg_dump "$DB_URL" | gzip > "$BACKUP_FILE"
test -s "$BACKUP_FILE"

"${PG_CLIENT[@]}" dropdb --if-exists -h 127.0.0.1 -U postgres "$RESTORE_DB"
"${PG_CLIENT[@]}" createdb -h 127.0.0.1 -U postgres "$RESTORE_DB"
gunzip -c "$BACKUP_FILE" | docker run -i --network host --rm postgres:17-alpine \
  psql "postgresql://postgres@127.0.0.1:5432/$RESTORE_DB" -v ON_ERROR_STOP=1 >/dev/null

VALUE=$("${PG_CLIENT[@]}" psql "postgresql://postgres@127.0.0.1:5432/$RESTORE_DB" -Atc "SELECT value FROM acceptance_restore_probe WHERE id = 1;")
test "$VALUE" = "verified"
"${PG_CLIENT[@]}" dropdb -h 127.0.0.1 -U postgres "$RESTORE_DB"

echo "Backup/restore acceptance passed"
