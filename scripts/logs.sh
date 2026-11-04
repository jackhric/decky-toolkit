#!/usr/bin/env bash
# Follow Decky Loader's journal on the device, filtered to this plugin unless -a is given.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f deploy.env ] && . ./deploy.env
: "${DECK_HOST:?set DECK_HOST in deploy.env (see deploy.env.example)}"
: "${DECK_USER:?set DECK_USER in deploy.env (see deploy.env.example)}"
DECK_SSH_OPTS=${DECK_SSH_OPTS:-}
FILTER='grep --line-buffered -iE "decky-toolkit|Decky Toolkit|Traceback|Error"'
[ "${1:-}" = "-a" ] && FILTER=cat
# shellcheck disable=SC2029
ssh -t $DECK_SSH_OPTS "$DECK_USER@$DECK_HOST" "sudo journalctl -u plugin_loader -f -n 100 -o short-iso | $FILTER"
