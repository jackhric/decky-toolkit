#!/usr/bin/env bash
# Build, stage and install the plugin on the device, then restart Decky Loader.
# Config: copy deploy.env.example to deploy.env (gitignored) or export the vars.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f deploy.env ] && . ./deploy.env

DECK_HOST=${DECK_HOST:-10.0.70.18}
DECK_USER=${DECK_USER:-jackh}
DECK_SSH_OPTS=${DECK_SSH_OPTS:-}
PLUGIN_DIR_NAME=${PLUGIN_DIR_NAME:-decky-mcp}
BUILD=${BUILD:-1}
RESTART=${RESTART:-1}

if [ "$BUILD" = 1 ]; then
  pnpm run build
fi

STAGE="out/$PLUGIN_DIR_NAME"
rm -rf out && mkdir -p "$STAGE"
cp -r dist plugin.json package.json main.py LICENSE README.md defaults py_modules "$STAGE"/
find "$STAGE" -name __pycache__ -prune -exec rm -rf {} +

REMOTE_STAGE=".cache/decky-mcp-stage"
echo ">> syncing to $DECK_USER@$DECK_HOST:~/$REMOTE_STAGE"
rsync -az --delete -e "ssh $DECK_SSH_OPTS" "$STAGE"/ "$DECK_USER@$DECK_HOST:$REMOTE_STAGE/"

echo ">> installing into ~/homebrew/plugins/$PLUGIN_DIR_NAME"
# shellcheck disable=SC2029
# Stop the loader *before* touching the plugin dir: its file watcher otherwise loads the new files
# mid-shutdown and leaves an orphaned backend holding our port.
ssh $DECK_SSH_OPTS "$DECK_USER@$DECK_HOST" "
  set -e
  if [ '$RESTART' = 1 ]; then sudo systemctl stop plugin_loader; fi
  sudo mkdir -p ~/homebrew/plugins/$PLUGIN_DIR_NAME
  sudo rsync -a --delete --chmod=D0755,F0644 ~/$REMOTE_STAGE/ ~/homebrew/plugins/$PLUGIN_DIR_NAME/
  sudo chown -R root:root ~/homebrew/plugins/$PLUGIN_DIR_NAME
  if [ '$RESTART' = 1 ]; then sudo systemctl start plugin_loader; echo 'plugin_loader restarted'; fi
"
