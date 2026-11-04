#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
cache=${OG_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/decky-toolkit-og-image}
out=${1:-$root/site/public/og.jpg}
playwright=1.64.1

site=${OG_SITE_DIR:-}
for tool in node npm python3 $([ -z "$site" ] && echo pnpm); do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done
mkdir -p "$cache"
if [ ! -f "$cache/pw/node_modules/playwright-core/package.json" ] || \
   [ "$(node -p "require('$cache/pw/node_modules/playwright-core/package.json').version")" != "$playwright" ]; then
  rm -rf "$cache/pw" && mkdir -p "$cache/pw"
  (cd "$cache/pw" && npm init -y >/dev/null && npm install --silent --no-audit --no-fund --ignore-scripts "playwright-core@$playwright")
fi
if [ -z "${OG_CHROME:-}" ]; then
  node "$cache/pw/node_modules/playwright-core/cli.js" install chromium-headless-shell >/dev/null
fi

if [ -z "$site" ]; then
  (cd "$root/site" && pnpm install --frozen-lockfile >/dev/null && pnpm run build >/dev/null)
  site=$root/site/dist
fi
serve=$(mktemp -d)
ln -s "$(cd "$site" && pwd)" "$serve/decky-toolkit"
port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$serve" >/dev/null 2>&1 &
server=$!
trap 'kill "$server"; rm -rf "$serve"' EXIT
sleep 1

OG_CACHE=$cache OG_URL="http://127.0.0.1:$port/decky-toolkit/" OG_OUT=$out node "$here/capture.mjs"
