#!/bin/bash
# Native macOS launchd system services. Run as gamehack, not as root.
set -euo pipefail
LABEL_SERVER="org.primalflow.kilo-server"
LABEL_BRIDGE="org.primalflow.kilo-bridge"
DAEMON_DIR="/Library/LaunchDaemons"
EXPECTED_HOME="/Users/gamehack"
REPO="$EXPECTED_HOME/kilo-workspaces/kilo-bridge"
LOG_DIR="$EXPECTED_HOME/Library/Logs/PrimalFlow"
TOKEN_FILE="$EXPECTED_HOME/.config/primalflow/macbook-worker-token"
TEMP_DIR=""
trap 'if [ -n "$TEMP_DIR" ]; then /bin/rm -rf "$TEMP_DIR"; fi' EXIT

say() { printf '[primalflow] %s\n' "$*"; }
fail() { printf '[primalflow] ERROR: %s\n' "$*" >&2; exit 1; }
require_mac() {
  [ "$(/usr/bin/id -un)" = "gamehack" ] || fail "Run as gamehack, NOT via sudo"
  [ "$HOME" = "$EXPECTED_HOME" ] || fail "Unexpected HOME"
  [ "$(/usr/bin/uname -s)" = "Darwin" ] || fail "macOS required"
  [ "$(/usr/bin/uname -m)" = "x86_64" ] || fail "Intel MacBook required"
  [ -f "$REPO/src/index.js" ] || fail "Kilo Bridge repository missing"
}
domain_status() {
  local label="$1"
  if /bin/launchctl print "system/$label" >/dev/null 2>&1; then
    /bin/launchctl print "system/$label" 2>/dev/null | /usr/bin/grep -E 'state =|pid =|last exit code|throttle interval|program =' | /usr/bin/head -12 || true
  else
    say "$label: not loaded"
  fi
}
status() {
  say "Kilo server:"
  domain_status "$LABEL_SERVER"
  say "Kilo Bridge:"
  domain_status "$LABEL_BRIDGE"
  say "Local API health (if running):"
  /usr/bin/curl --max-time 3 -fsS http://127.0.0.1:4096/global/health 2>/dev/null || true
  printf '\n'
  say "Logs: $LOG_DIR"
}
sudo_bootout() {
  /usr/bin/sudo /bin/launchctl bootout "system/$1" >/dev/null 2>&1 || true
}
stop_foreground_instances() {
  local pid cmd
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    cmd=$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)
    if [[ "$cmd" == *"scripts/macbook-worker.js start "* ]]; then
      say "Stopping old interactive Bridge PID $pid"
      /bin/kill -TERM "$pid" 2>/dev/null || true
    fi
  done < <(/usr/bin/pgrep -f 'scripts/macbook-worker\.js start ' 2>/dev/null || true)
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    cmd=$(/bin/ps -p "$pid" -o command= 2>/dev/null || true)
    if [[ "$cmd" == *"kilo"* && "$cmd" == *"serve"* ]]; then
      say "Stopping old interactive Kilo server PID $pid"
      /bin/kill -TERM "$pid" 2>/dev/null || true
    else
      fail "Port 4096 occupied by unexpected PID $pid; stop it manually"
    fi
  done < <(/usr/sbin/lsof -nP -tiTCP:4096 -sTCP:LISTEN 2>/dev/null || true)
  /bin/sleep 2
  if /usr/sbin/lsof -nP -tiTCP:4096 -sTCP:LISTEN 2>/dev/null | /usr/bin/grep -q '[0-9]'; then
    fail "Port 4096 still occupied"
  fi
}
install_services() {
  require_mac
  local node_bin kilo_bin user_group
  node_bin=$(command -v node || true)
  kilo_bin=$(command -v kilo || true)
  [ -x "$node_bin" ] || fail "Absolute executable node path required"
  [ -x "$kilo_bin" ] || fail "Absolute executable kilo path required"
  [[ "$node_bin" = /* && "$kilo_bin" = /* ]] || fail "node and kilo must be absolute paths"
  "$node_bin" -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' ||
    fail "Node.js 24 or later required"
  [ -f "$TOKEN_FILE" ] || fail "MacBook worker token missing"
  user_group=$(/usr/bin/id -gn)
  /bin/mkdir -p "$LOG_DIR"
  /bin/chmod 700 "$LOG_DIR"
  TEMP_DIR=$(/usr/bin/mktemp -d /tmp/primalflow-launchd.XXXXXX)
  "$node_bin" "$REPO/scripts/render-macos-daemons.js" "$TEMP_DIR" "$node_bin" \
    "$kilo_bin" "$EXPECTED_HOME" "$REPO" "$user_group" "$LOG_DIR"
  /usr/bin/plutil -lint "$TEMP_DIR/$LABEL_SERVER.plist" "$TEMP_DIR/$LABEL_BRIDGE.plist" ||
    fail "Invalid launchd plists"

  # Request the sole manual admin authorization before stopping anything.
  /usr/bin/sudo -v
  sudo_bootout "$LABEL_BRIDGE"
  sudo_bootout "$LABEL_SERVER"
  stop_foreground_instances
  /usr/bin/sudo /usr/bin/install -o root -g wheel -m 0644 \
    "$TEMP_DIR/$LABEL_SERVER.plist" "$DAEMON_DIR/$LABEL_SERVER.plist"
  /usr/bin/sudo /usr/bin/install -o root -g wheel -m 0644 \
    "$TEMP_DIR/$LABEL_BRIDGE.plist" "$DAEMON_DIR/$LABEL_BRIDGE.plist"
  /usr/bin/sudo /bin/launchctl enable "system/$LABEL_SERVER"
  /usr/bin/sudo /bin/launchctl enable "system/$LABEL_BRIDGE"
  /usr/bin/sudo /bin/launchctl bootstrap system "$DAEMON_DIR/$LABEL_SERVER.plist"
  /usr/bin/sudo /bin/launchctl bootstrap system "$DAEMON_DIR/$LABEL_BRIDGE.plist"
  say "Boot-time LaunchDaemons installed: KeepAlive=true; RunAtLoad=true; throttle=20s"
  status
}
uninstall_services() {
  require_mac
  /usr/bin/sudo -v
  sudo_bootout "$LABEL_BRIDGE"
  sudo_bootout "$LABEL_SERVER"
  /usr/bin/sudo /bin/rm -f "$DAEMON_DIR/$LABEL_BRIDGE.plist" "$DAEMON_DIR/$LABEL_SERVER.plist"
  say "LaunchDaemons removed; credentials and logs preserved"
}
if [ "$#" -eq 0 ]; then
  install_services
else
  case "$1" in
    install) install_services ;;
    status) require_mac; status ;;
    uninstall) uninstall_services ;;
    *) fail "Usage: bash scripts/install-macos-daemons.sh install|status|uninstall" ;;
  esac
fi
