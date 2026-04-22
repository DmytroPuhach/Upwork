#!/bin/bash
# OptimizeUp Extension — First Install Helper
# Run on Mac: curl -fsSL https://app.optimizeup.io/ext/install.sh | bash
# Downloads latest .zip, unpacks to ~/optimizeup-extension/, opens chrome://extensions

set -e

URL="https://app.optimizeup.io/ext/releases/optimizeup-extension-latest.zip"
TARGET="$HOME/optimizeup-extension"
TMP_ZIP="/tmp/optimizeup-extension.zip"

echo ""
echo "📦 OptimizeUp Extension — First Install"
echo ""

echo "→ Downloading latest version..."
curl -fsSL "$URL" -o "$TMP_ZIP"
SIZE=$(stat -f%z "$TMP_ZIP" 2>/dev/null || stat -c%s "$TMP_ZIP")
echo "  $SIZE bytes downloaded"

echo "→ Unpacking to $TARGET..."
rm -rf "$TARGET"
mkdir -p "$TARGET"
unzip -oq "$TMP_ZIP" -d "$TARGET"
rm "$TMP_ZIP"

echo ""
echo "✅ Extension unpacked to: $TARGET"
echo ""
echo "NEXT STEPS in Chrome:"
echo "  1. Chrome will open chrome://extensions/ automatically"
echo "  2. Turn ON 'Developer mode' (top-right toggle) if not already"
echo "  3. Click 'Load unpacked'"
echo "  4. Select this folder:"
echo "     $TARGET"
echo ""
echo "  That's it. Extension will appear in the list."
echo ""

# Open chrome://extensions
if command -v open >/dev/null 2>&1; then
  open -a "Google Chrome" "chrome://extensions/" 2>/dev/null || true
fi

echo "To update later: bash ~/optimizeup-extension/update.sh"
