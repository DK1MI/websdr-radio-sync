#!/bin/sh
# Registers the Hamlib helper with Chrome/Chromium/Brave/Edge (Linux and macOS).
# Usage: ./install.sh                  (for this extension's fixed ID)
#        ./install.sh <extension-id>   (e.g. a Chrome Web Store build, which has its own ID)
#        ./install.sh --uninstall
set -eu

NAME=websdr_radio_sync.hamlib
DEFAULT_ID=kpaeajaipgjalgohpjfejkccajdpoiij  # from the "key" in manifest.json
DIR=$(cd "$(dirname "$0")" && pwd)
HOST="$DIR/websdr_radio_sync_host.py"

case "$(uname -s)" in
  Darwin) BASES="$HOME/Library/Application Support/Google/Chrome
$HOME/Library/Application Support/Chromium
$HOME/Library/Application Support/BraveSoftware/Brave-Browser
$HOME/Library/Application Support/Microsoft Edge" ;;
  *) BASES="$HOME/.config/google-chrome
$HOME/.config/google-chrome-beta
$HOME/.config/google-chrome-unstable
$HOME/.config/chromium
$HOME/.config/BraveSoftware/Brave-Browser
$HOME/.config/microsoft-edge
$HOME/.config/vivaldi" ;;
esac

if [ "${1:-}" = "--uninstall" ]; then
  echo "$BASES" | while IFS= read -r b; do
    rm -f "$b/NativeMessagingHosts/$NAME.json"
  done
  echo "Removed $NAME."
  exit 0
fi

ID=${1:-$DEFAULT_ID}
case "$ID" in
  [a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p][a-p]) ;;
  *) echo "Usage: $0 <extension-id>   (32 letters a-p, shown in the panel and on chrome://extensions)" >&2; exit 1 ;;
esac

command -v python3 >/dev/null || { echo "python3 is required." >&2; exit 1; }
command -v rigctld >/dev/null || echo "Warning: rigctld not found. Install Hamlib (Arch: pacman -S hamlib, Debian/Ubuntu: apt install libhamlib-utils, macOS: brew install hamlib)." >&2
chmod +x "$HOST"

echo "$BASES" | while IFS= read -r b; do
  [ -d "$b" ] || continue
  mkdir -p "$b/NativeMessagingHosts"
  cat > "$b/NativeMessagingHosts/$NAME.json" <<EOF
{
  "name": "$NAME",
  "description": "Hamlib rigctld bridge for Web SDR Radio Sync",
  "path": "$HOST",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$ID/"]
}
EOF
  echo "Installed for $b"
done
echo "Done. Back in the panel, click Connect radio again (no browser restart needed)."
