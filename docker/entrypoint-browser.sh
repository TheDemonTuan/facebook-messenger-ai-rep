#!/usr/bin/env bash
set -eo pipefail

# Ensure runtime directories exist and have proper permissions for pwuser
mkdir -p /app/browser_profile /tmp/.X11-unix /home/pwuser/.vnc
chmod 1777 /tmp /tmp/.X11-unix 2>/dev/null || true
chown -R pwuser:pwuser /app/browser_profile /home/pwuser /tmp/.X11-unix 2>/dev/null || true

# Clear stale locks and health markers from previous container runs
rm -f /app/browser_profile/Singleton* /tmp/.X*-lock /tmp/.X11-unix/X* /tmp/healthy 2>/dev/null || true

echo "Starting Xvfb virtual framebuffer on :99..."
gosu pwuser Xvfb :99 -screen 0 1280x800x24 -ac -nolisten tcp &
XVFB_PID=$!
export DISPLAY=:99

for i in $(seq 1 30); do
  if [ -S /tmp/.X11-unix/X99 ]; then
    echo "Xvfb is ready on :99 (took ${i}00ms)"
    break
  fi
  sleep 0.1
done

# noVNC is disabled by default for production security.
# Enabled only when ENABLE_NOVNC=true (e.g. in compose.debug.yml over localhost/SSH).
if [[ "${ENABLE_NOVNC:-false}" == "true" ]]; then
  echo "Enabling noVNC debug interface..."
  VNC_ARGS=(-display :99 -forever -shared -rfbport 5900 -localhost -quiet)
  if [[ -n "${VNC_PASSWORD:-}" ]]; then
    mkdir -p "/home/pwuser/.vnc"
    gosu pwuser x11vnc -storepasswd "$VNC_PASSWORD" "/home/pwuser/.vnc/passwd" 2>/dev/null
    VNC_ARGS+=(-rfbauth "/home/pwuser/.vnc/passwd")
    echo "x11vnc configured with password authentication."
  else
    VNC_ARGS+=(-nopw)
    echo "WARNING: x11vnc running without password (localhost only)."
  fi

  gosu pwuser x11vnc "${VNC_ARGS[@]}" &
  gosu pwuser websockify --web /usr/share/novnc 6080 localhost:5900 &
  echo "noVNC websockify listening on localhost:6080"
else
  echo "noVNC disabled by default in production. Use compose.debug.yml for debugging via SSH tunnel."
fi

echo "Starting Browser Agent with Bun as pwuser..."
exec gosu pwuser bun apps/browser-agent/dist/index.js
