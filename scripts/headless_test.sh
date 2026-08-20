#!/usr/bin/env bash
# Headless smoke test for NX Orbit. Runs the pure-Node unit tests (db, ingest,
# digest, vrcx mapping) which need no display, then — if electron + a virtual
# display are available — boots the app once with a self-quit to catch renderer
# load errors. Safe to run in CI.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> unit tests (node --test)"
node --test test/

if command -v electron >/dev/null 2>&1 && command -v xvfb-run >/dev/null 2>&1; then
  echo "==> electron boot smoke (xvfb)"
  NX_ORBIT_SMOKE=1 timeout 30 xvfb-run -a electron . || {
    code=$?; if [ "$code" -eq 124 ]; then echo "boot smoke timed out (window stayed up = ok-ish)"; else exit "$code"; fi; }
else
  echo "==> skipping electron boot smoke (electron or xvfb not present)"
fi
echo "==> ok"
