#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/kilo-bridge}"
ENV_FILE="${ENV_FILE:-/etc/kilo-bridge/bridge.env}"
NODE_BIN="${NODE_BIN:-}"

if [[ ! "$NODE_BIN" = /* || ! -x "$NODE_BIN" ]]; then
  echo "Pass an absolute executable NODE_BIN pointing to Node 24+" >&2; exit 1
fi
major="$($NODE_BIN -p 'Number(process.versions.node.split(".")[0])')"
if (( major < 24 )); then echo "Node.js >=24 is required" >&2; exit 1; fi
if [[ ! -f "$ENV_FILE" ]]; then echo "Missing private env file: $ENV_FILE" >&2; exit 1; fi
if [[ ! -f "$APP_DIR/src/index.js" ]]; then echo "Missing project at $APP_DIR" >&2; exit 1; fi

sudo install -m 0644 /dev/null /etc/systemd/system/kilo-bridge.service
sudo sed -e "s|@NODE_BIN@|$NODE_BIN|g" -e "s|@APP_DIR@|$APP_DIR|g" \
  -e "s|@ENV_FILE@|$ENV_FILE|g" "$APP_DIR/deploy/kilo-bridge.service.in" \
  | sudo tee /etc/systemd/system/kilo-bridge.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now kilo-bridge.service
echo "Installed kilo-bridge.service (User=ubuntu)"
