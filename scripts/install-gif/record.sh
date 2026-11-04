#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
cache=${GIF_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/decky-toolkit-install-gif}
out=${1:-$root/docs/images/install/vscode-install.gif}
playwright=1.64.1

for tool in node npm xvfb-run ffmpeg git curl sha256sum python3; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done
mkdir -p "$cache"

meta=$(curl -fsSL https://update.code.visualstudio.com/api/update/linux-x64/stable/latest)
version=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["productVersion"])' "$meta")
if [ "$(cat "$cache/vscode-version" 2>/dev/null)" != "$version" ]; then
  echo "downloading VS Code $version"
  url=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["url"])' "$meta")
  sha=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["sha256hash"])' "$meta")
  curl -fsSL "$url" -o "$cache/vscode.tar.gz"
  echo "$sha  $cache/vscode.tar.gz" | sha256sum -c --quiet
  rm -rf "$cache/VSCode-linux-x64"
  tar xzf "$cache/vscode.tar.gz" -C "$cache"
  rm "$cache/vscode.tar.gz"
  echo "$version" > "$cache/vscode-version"
fi

if [ ! -f "$cache/pw/node_modules/playwright-core/package.json" ] || \
   [ "$(node -p "require('$cache/pw/node_modules/playwright-core/package.json').version")" != "$playwright" ]; then
  rm -rf "$cache/pw" && mkdir -p "$cache/pw"
  (cd "$cache/pw" && npm init -y >/dev/null && npm install --silent --no-audit --no-fund --ignore-scripts "playwright-core@$playwright")
fi

rm -rf "$cache/template"
git clone -q --depth 1 https://github.com/SteamDeckHomebrew/decky-plugin-template.git "$cache/template"

# Inherited from a VS Code host, these make the downloaded VS Code run as plain Node and reject its flags.
unset ELECTRON_RUN_AS_NODE
for v in $(compgen -e | grep '^VSCODE_' || true); do unset "$v"; done

GIF_CACHE=$cache xvfb-run -a -s "-screen 0 1280x800x24" node "$here/record.mjs"

read -r video start end < <(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print(m["video"], m["start"], m["end"])' "$cache/rec/marks.json")
filters="fps=12,scale=800:-1:flags=lanczos"
ffmpeg -v error -y -ss "$start" -to "$end" -i "$video" -vf "$filters,palettegen=max_colors=128:stats_mode=diff" "$cache/rec/palette.png"
ffmpeg -v error -y -ss "$start" -to "$end" -i "$video" -i "$cache/rec/palette.png" \
  -lavfi "$filters [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" -loop 0 "$out"
echo "wrote $out ($(du -h "$out" | cut -f1), VS Code $version)"
