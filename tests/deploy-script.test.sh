#!/usr/bin/env bash
set -euo pipefail

script="scripts/deploy.sh"
bash -n "$script"
grep -q 'flock -n' "$script"
grep -q 'sha256:\[a-f0-9\]{64\}' "$script"
grep -q 'Deployment failed; rolling back' "$script"
grep -q 'curl --fail' "$script"
grep -q 'Migrations applied successfully' "$script"
grep -q 'database migration did not report successful completion' "$script"
grep -q 'core readiness probe failed after deployment' "$script"
grep -q 'source "$APP_DIR/image-retention.sh"' "$script"
grep -q '\-\-status' "$script"
grep -q '\-\-migrate' "$script"
grep -q '\-\-reconcile' "$script"
grep -q 'trap .* ERR INT TERM HUP' "$script"
grep -q 'ensure_infra' "$script"

echo "deploy script checks passed"
