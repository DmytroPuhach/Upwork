#!/bin/bash
# OptimizeUp Extension Auto-Deploy
# Creates ZIP (not .crx) - Chrome blocks .crx install from URLs.
# Load unpacked workflow: download zip -> unzip -> chrome://extensions -> Load unpacked

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/Upwork}"
EXT_DIR="$REPO_DIR/extension"
RELEASES_DIR="/var/www/optimizeup-ext/releases"
SB_URL="https://nsmcaexdqbipusjuzfht.supabase.co"
RELEASE_SECRET="${RELEASE_SECRET:-optimizeup_release_2026_ZpQ9xA}"

R="\033[0;31m"; G="\033[0;32m"; Y="\033[1;33m"; B="\033[0;34m"; N="\033[0m"

echo -e "${B}=== OptimizeUp Extension Deploy (ZIP) ===${N}"

if [ ! -d "$EXT_DIR" ]; then
  echo -e "${R}FATAL: $EXT_DIR not found${N}"; exit 1
fi

VERSION=$(python3 -c "import json; print(json.load(open('$EXT_DIR/manifest.json'))['version'])")
echo -e "Version: ${Y}$VERSION${N}"

# 1. Build ZIP
ZIP_TARGET="$RELEASES_DIR/optimizeup-extension-v$VERSION.zip"
ZIP_LATEST="$RELEASES_DIR/optimizeup-extension-latest.zip"
mkdir -p "$RELEASES_DIR"
rm -f "$ZIP_TARGET" "$ZIP_LATEST"

# Zip the extension folder (from inside $EXT_DIR so paths are clean)
cd "$EXT_DIR"
zip -rq "$ZIP_TARGET" . -x "*.DS_Store"
cp "$ZIP_TARGET" "$ZIP_LATEST"
chmod 644 "$ZIP_TARGET" "$ZIP_LATEST"
chmod 755 "$RELEASES_DIR"

SIZE=$(stat -c %s "$ZIP_TARGET")
SHA256=$(sha256sum "$ZIP_TARGET" | awk '{print $1}')
echo -e "  Size: ${B}$SIZE bytes${N}"
echo -e "  SHA256: ${B}${SHA256:0:16}...${N}"
echo -e "${G}✓ $ZIP_TARGET${N}"
echo -e "${G}✓ $ZIP_LATEST (alias)${N}"

# 2. Changelog from commit
CHANGELOG=$(git -C "$REPO_DIR" log -1 --pretty=%B 2>/dev/null | head -c 500 | tr '\n' ' ' | sed 's/"/\\"/g' || echo "Manual deploy")

# 3. Register in Supabase
echo -e "${G}Registering v$VERSION in Supabase...${N}"
curl -s -X POST "$SB_URL/functions/v1/extension-release/register" \
  -H "Content-Type: application/json" \
  -H "X-Release-Secret: $RELEASE_SECRET" \
  -d "{
    \"version\": \"$VERSION\",
    \"download_url\": \"https://app.optimizeup.io/ext/releases/optimizeup-extension-v$VERSION.zip\",
    \"crx_size_bytes\": $SIZE,
    \"crx_sha256\": \"$SHA256\",
    \"changelog\": \"$CHANGELOG\",
    \"packed_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
  }" | python3 -m json.tool 2>/dev/null || echo "(non-json response)"

# 4. Publish
echo -e "${G}Publishing...${N}"
curl -s -X POST "$SB_URL/functions/v1/extension-release/publish" \
  -H "Content-Type: application/json" \
  -H "X-Release-Secret: $RELEASE_SECRET" \
  -d "{\"version\": \"$VERSION\"}" | python3 -m json.tool 2>/dev/null || echo "(non-json response)"

# 5. Verify
HTTP_CODE=$(curl -sSLo /dev/null -w "%{http_code}" "https://app.optimizeup.io/ext/releases/optimizeup-extension-latest.zip" || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  echo -e "${G}========================================${N}"
  echo -e "${G}  ✅ DEPLOYED v$VERSION${N}"
  echo -e "${G}========================================${N}"
  echo -e "  Latest: https://app.optimizeup.io/ext/releases/optimizeup-extension-latest.zip"
  echo -e "  Pinned: https://app.optimizeup.io/ext/releases/optimizeup-extension-v$VERSION.zip"
else
  echo -e "${R}⚠️  Download HTTP $HTTP_CODE${N}"; exit 1
fi
