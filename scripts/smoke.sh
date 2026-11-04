#!/usr/bin/env bash
# Exercise the MCP endpoint from the dev machine: health, initialize, tools/list, one tool call.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f deploy.env ] && . ./deploy.env
DECK_HOST=${DECK_HOST:-10.0.70.18}; DECK_USER=${DECK_USER:-jackh}; DECK_SSH_OPTS=${DECK_SSH_OPTS:-}
PORT=${MCP_PORT:-8765}
TOKEN=${MCP_TOKEN:-$(ssh $DECK_SSH_OPTS "$DECK_USER@$DECK_HOST" "sudo python3 -c \"import json;print(json.load(open('/home/$DECK_USER/homebrew/settings/decky-mcp/settings.json'))['token'])\"")}
URL="http://$DECK_HOST:$PORT/mcp"
rpc() { curl -sS --max-time 30 -X POST "$URL" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "$1"; echo; }
echo "== health";     curl -sS --max-time 10 "http://$DECK_HOST:$PORT/health"; echo
echo "== no auth ->"; curl -sS --max-time 10 -o /dev/null -w "%{http_code}\n" -X POST "$URL" -d '{}'
echo "== initialize"; rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
echo "== initialized (expect 202)"; curl -sS --max-time 10 -o /dev/null -w "%{http_code}\n" -X POST "$URL" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
echo "== tools/list"; rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | python3 -c 'import sys,json; [print(" -", t["name"]) for t in json.load(sys.stdin)["result"]["tools"]]'
echo "== decky_status"; rpc '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"decky_status","arguments":{}}}' | head -c 1500; echo
echo "== cef_evaluate"; rpc '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"cef_evaluate","arguments":{"expression":"({ decky: typeof window.DeckyPluginLoader, plugins: Object.keys(window.DeckyPluginLoader?.plugins ?? {}), href: location.href })"}}}'
# Keep the secret out of logs and agent transcripts; the token itself is in the settings file on the device.
echo; echo "Add to Claude Code (substitute the token from ~/homebrew/settings/decky-mcp/settings.json on the device):"
echo "  claude mcp add --transport http decky $URL -H \"Authorization: Bearer <token>\""
