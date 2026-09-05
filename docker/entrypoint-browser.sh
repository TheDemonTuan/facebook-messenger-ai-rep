#!/usr/bin/env bash
set -eo pipefail

# Clear stale locks and health markers from previous container runs
rm -f /app/browser_profile/Singleton* /tmp/.X*-lock /tmp/.X11-unix/X* /tmp/healthy 2>/dev/null || true

echo "Starting Xvfb virtual framebuffer on :99..."
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
export DISPLAY=:99

sleep 1

# noVNC is disabled by default for production security.
# Enabled only when ENABLE_NOVNC=true (e.g. in compose.debug.yml over localhost/SSH).
if [[ "${ENABLE_NOVNC:-false}" == "true" ]]; then
  echo "Enabling noVNC debug interface..."
  VNC_ARGS=(-display :99 -forever -shared -rfbport 5900 -localhost -quiet)
  if [[ -n "${VNC_PASSWORD:-}" ]]; then
    mkdir -p "$HOME/.vnc"
    x11vnc -storepasswd "$VNC_PASSWORD" "$HOME/.vnc/passwd" 2>/dev/null
    VNC_ARGS+=(-rfbauth "$HOME/.vnc/passwd")
    echo "x11vnc configured with password authentication."
  else
    VNC_ARGS+=(-nopw)
    echo "WARNING: x11vnc running without password (localhost only)."
  fi

  x11vnc "${VNC_ARGS[@]}" &
  websockify --web /usr/share/novnc 6080 localhost:5900 &
  echo "noVNC websockify listening on localhost:6080"
else
  echo "noVNC disabled by default in production. Use compose.debug.yml for debugging via SSH tunnel."
fi

echo "Starting Browser Agent with Bun..."
exec bun apps/browser-agent/dist/index.js
