#!/usr/bin/env sh
# Start MacroPilot (macOS / Linux). On macOS you can also double-click MacroPilot.command.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.13 or newer is required. Download it from https://nodejs.org"
  exit 1
fi
exec node scripts/launch.mjs
