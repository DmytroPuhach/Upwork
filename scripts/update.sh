#!/bin/bash
# OptimizeUp Extension — Update Helper
# Run on Mac: curl -fsSL https://app.optimizeup.io/ext/update.sh | bash
# OR from installed folder: bash ~/optimizeup-extension/update.sh

set -e

URL="https://app.optimizeup.io/ext/releases/optimizeup-extension-latest.zip"
TARGET="$HOME/optimizeup-extension"
TMP_ZIP="/tmp/optimizeup-extension-update.zip"

echo ""
echo "🔄 OptimizeUp Extension — Update"
echo ""

if [ ! -d "$TARGET" ]; then
  echo "⚠️  Extension not installed at $TARGET"
  echo "Run first install instead:"
  echo "  curl -fsSL https://app.optimizeup.io/ext/install.sh | bash"
  exit 1
fi

echo "→ Downloading latest..."
curl -fsSL "$URL" -o "$TMP_ZIP"

echo "→ Replacing $TARGET contents..."
# Keep the folder itself (so Chrome doesn't lose reference), replace contents
find "$TARGET" -mindepth 1 -delete 2>/dev/null || true
unzip -oq "$TMP_ZIP" -d "$TARGET"
rm "$TMP_ZIP"

echo ""
echo "✅ Files updated. Reload the extension in Chrome:"
echo "   1. Open chrome://extensions/"
echo "   2. Click the ⟳ Reload button on OptimizeUp Agency Assistant"
echo ""

if command -v open >/dev/null 2>&1; then
  open -a "Google Chrome" "chrome://extensions/" 2>/dev/null || true
fi
