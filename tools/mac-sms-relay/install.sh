#!/bin/bash
# Installs (or with --remove, uninstalls) the Mac text relay as a login item that restarts if it stops.
set -euo pipefail
LABEL=com.aaas.sms-relay
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DEST="$HOME/Library/Application Support/aaas-sms-relay"

if [[ "${1:-}" == "--remove" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Relay stopped and removed."
  exit 0
fi

: "${AAAS_SMS_URL:?Set AAAS_SMS_URL to the link from the admin app first}"
NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { echo "Node isn't installed. Install it from https://nodejs.org, then run this again."; exit 1; }
NODE="$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")"

mkdir -p "$DEST" "$HOME/Library/LaunchAgents"
cp "$(dirname "$0")/relay.mjs" "$DEST/relay.mjs"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DEST/relay.mjs</string></array>
  <key>EnvironmentVariables</key><dict><key>AAAS_SMS_URL</key><string>$AAAS_SMS_URL</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/aaas-sms-relay.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/aaas-sms-relay.log</string>
</dict></plist>
EOF
chmod 600 "$PLIST"   # the link is a secret

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Relay running."
echo "Now give Full Disk Access to: $NODE"
echo "(System Settings → Privacy & Security → Full Disk Access → +, then press Cmd+Shift+G and paste the path.)"
