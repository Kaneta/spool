#!/usr/bin/env bash
set -euo pipefail

SVG_SOURCE="${1:-$HOME/Downloads/spool.svg}"

SPOOL_BIN="$HOME/.local/bin/spool"
HELPER="$HOME/.local/bin/spool-clipboard"
ICON_DIR="$HOME/.local/share/icons"
ICON="$ICON_DIR/spool.svg"
APP_DIR="$HOME/.local/share/applications"
DESKTOP="$APP_DIR/spool.desktop"

if [[ ! -f "$SVG_SOURCE" ]]; then
  printf 'SVG not found: %s\n' "$SVG_SOURCE" >&2
  exit 1
fi

if [[ ! -x "$SPOOL_BIN" ]]; then
  printf 'spool executable not found: %s\n' "$SPOOL_BIN" >&2
  exit 1
fi

if ! command -v xclip >/dev/null 2>&1; then
  printf 'xclip is required for the current X11 setup.\n' >&2
  printf 'On openSUSE: sudo zypper install xclip\n' >&2
  exit 1
fi

mkdir -p "$HOME/.local/bin" "$ICON_DIR" "$APP_DIR"
cp "$SVG_SOURCE" "$ICON"

cat >"$HELPER" <<'EOF'
#!/usr/bin/env bash
set -u

tmp=$(mktemp) || exit 1
trap 'rm -f "$tmp"' EXIT

xclip -selection clipboard -o >"$tmp" || exit 1
"$HOME/.local/bin/spool" add <"$tmp"
EOF
chmod +x "$HELPER"

cat >"$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=spool
Comment=Add clipboard text to spool
Exec=$HELPER
Icon=$ICON
Terminal=false
Categories=Utility;
EOF
chmod +x "$DESKTOP"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APP_DIR" >/dev/null 2>&1 || true
fi

printf 'Installed KDE launcher:\n'
printf '  icon:    %s\n' "$ICON"
printf '  helper:  %s\n' "$HELPER"
printf '  desktop: %s\n' "$DESKTOP"
printf '\nSearch for "spool" in the KDE application launcher and add it to the panel.\n'
