#!/usr/bin/env bash
set -euo pipefail

script="scripts/deploy.sh"
bash -n "$script"
grep -q 'flock -n' "$script"
grep -q 'sha256:\[a-f0-9\]{64\}' "$script"
grep -q 'Deployment failed; rolling back' "$script"
grep -q 'curl --fail' "$script"
grep -q 'source "$APP_DIR/image-retention.sh"' "$script"
grep -q '\-\-status' "$script"

echo "deploy script checks passed"
