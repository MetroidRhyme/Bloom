#!/usr/bin/env bash
# One-time per container. Playwright test scripts and their dependencies do
# not survive between sessions, so this exists to make rebuilding a running
# suite one command instead of a rediscovery exercise.
set -euo pipefail
cd "$(dirname "$0")"

echo "Installing playwright-core..."
npm install --silent playwright-core

# Leaflet is vendored rather than committed: the suite intercepts index.html's
# CDN request and serves these files locally, because the CDN copy cannot
# fully initialize a Leaflet map in a sandboxed headless run.
mkdir -p vendor
BASE="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4"
for f in leaflet.min.js leaflet.min.css; do
  if [ ! -s "vendor/$f" ]; then
    echo "Fetching $f..."
    curl -sSf -o "vendor/$f" "$BASE/$f"
  fi
done

# A symlink straight to the chromium executable, not to a directory - do not
# append /chrome-linux/chrome, and do not hardcode a chromium-NNNN build
# number anywhere, it changes.
if [ ! -e /opt/pw-browsers/chromium ]; then
  echo "WARNING: /opt/pw-browsers/chromium not found. Check 'ls -la /opt/pw-browsers/'." >&2
fi

echo "Ready. Run: ./tests/run-all.sh"
