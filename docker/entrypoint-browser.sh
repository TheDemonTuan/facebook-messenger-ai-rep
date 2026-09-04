#!/usr/bin/env bash
set -e

# Clear stale locks from previous container restarts/kills
rm -f /app/browser_profile/Singleton* /tmp/.X*-lock /tmp/.X11-unix/X* 2>/dev/null || true

echo "Starting Xvfb virtual framebuffer on :99..."
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
export DISPLAY=:99

sleep 1

echo "Starting x11vnc server on port 5900..."
x11vnc -display :99 -forever -nopw -shared -rfbport 5900 -quiet &

echo "Starting noVNC websockify on port 6080..."
websockify --web /usr/share/novnc 6080 localhost:5900 &

echo "Starting Browser Agent with Bun..."
exec bun apps/browser-agent/dist/index.js
