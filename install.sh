#!/usr/bin/env bash
# Copy the mods and layouts into Herdr's config and merge the key bindings.
set -euo pipefail
cd "$(dirname "$0")"
DEST="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
mkdir -p "$DEST/mods" "$DEST/layouts"

for m in mods/*/; do
  name=$(basename "$m")
  mkdir -p "$DEST/mods/$name"
  cp -r "$m". "$DEST/mods/$name/"
  echo "mod     $name"
done
cp layouts/*.json "$DEST/layouts/" && echo "layout  sidebar-lab"

# macOS already has cmd-f for the find bar, and uses cmd- shortcuts.
KEYS=keys.json
[ "$(uname -s)" = Darwin ] && KEYS=keys.macos.json

if command -v jq >/dev/null; then
  [ -f "$DEST/keys.json" ] || echo '{}' > "$DEST/keys.json"
  jq -s '.[0] * .[1]' "$DEST/keys.json" "$KEYS" > "$DEST/keys.json.new" && mv "$DEST/keys.json.new" "$DEST/keys.json"
  echo "keys    merged ($KEYS)"
else
  echo "keys    jq not found: merge $KEYS into $DEST/keys.json by hand"
fi

if command -v herdr-app >/dev/null; then
  for m in mods/*/; do herdr-app check "$DEST/mods/$(basename "$m")" >/dev/null || echo "check failed: $m"; done
fi
SWITCH=Ctrl+Shift+L
[ "$(uname -s)" = Darwin ] && SWITCH=Cmd+Shift+L
echo "Done. In Herdr pick the layout with $SWITCH: sidebar-lab."
