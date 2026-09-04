#!/usr/bin/env bash
set -euo pipefail

helper="scripts/image-retention.sh"
temp="$(mktemp -d)"
trap 'rm -rf "$temp"' EXIT

cat > "$temp/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "image inspect" ]]; then
  [[ "$3" != *"missing"* ]] || exit 1
  printf 'sha256:%s\n' "${3##*@sha256:}"
elif [[ "$1 $2" == "image ls" ]]; then
  cat <<'IMAGES'
ghcr.io/thedemontuan/facebook-messenger-ai-control-plane|sha256:new
ghcr.io/thedemontuan/facebook-messenger-ai-control-plane|sha256:previous
ghcr.io/thedemontuan/facebook-messenger-ai-control-plane|sha256:old
ghcr.io/thedemontuan/other|sha256:foreign
IMAGES
elif [[ "$1 $2" == "image rm" ]]; then
  printf '%s\n' "$3" >> "$REMOVED"
else
  exit 64
fi
EOF
chmod +x "$temp/docker"

export PATH="$temp:$PATH"
export REMOVED="$temp/removed"

log() { :; }
# shellcheck source=scripts/image-retention.sh
source "$helper"
prune_repository_images \
  "ghcr.io/thedemontuan/facebook-messenger-ai-control-plane" \
  "ghcr.io/thedemontuan/facebook-messenger-ai-control-plane@sha256:new" \
  "ghcr.io/thedemontuan/facebook-messenger-ai-control-plane@sha256:previous"

diff -u <(printf '%s\n' 'ghcr.io/thedemontuan/facebook-messenger-ai-control-plane@sha256:old') "$REMOVED"

: > "$REMOVED"
prune_repository_images \
  "ghcr.io/thedemontuan/facebook-messenger-ai-control-plane" \
  "ghcr.io/thedemontuan/facebook-messenger-ai-control-plane@sha256:new" \
  "ghcr.io/thedemontuan/facebook-messenger-ai-control-plane@sha256:missing"
[[ ! -s "$REMOVED" ]]

grep -q 'source "$APP_DIR/image-retention.sh"' scripts/deploy.sh
grep -q 'prune_repository_images' scripts/deploy.sh
grep -q 'scripts/image-retention.sh' .github/workflows/deploy.yml

echo "image retention checks passed"
