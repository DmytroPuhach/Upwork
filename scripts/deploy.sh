#!/bin/bash
# OptimizeUp Extension Auto-Deploy
# Run on VPS after git pull
#
# Usage: ./scripts/deploy.sh
# Requires:
#   - chromium-browser installed
#   - /home/optimizeup/.keys/ext.pem (signing key)
#   - Nginx serving /var/www/optimizeup-ext/releases/
#
# What it does:
#   1. Read version from extension/manifest.json
#   2. Pack .crx using chromium + .pem
#   3. Copy to /var/www/optimizeup-ext/releases/vX.Y.Z.crx
#   4. POST /extension-release/register + /publish to Supabase

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/Upwork}"
EXT_DIR="$REPO_DIR/extension"
PEM="${PEM:-/home/optimizeup/.keys/ext.pem}"
RELEASES_DIR="/var/www/optimizeup-ext/releases"
SB_URL="https://nsmcaexdqbipusjuzfht.supabase.co"
RELEASE_SECRET="${RELEASE_SECRET:-optimizeup_release_2026_ZpQ9xA}"

# Colors
R="\033[0;31m"; G="\033[0;32m"; Y="\033[1;33m"; N="\033[0m"

echo -e "${G}OptimizeUp deploy starting...${N}"

# 1. Get version
VERSION=$(python3 -c "import json; print(json.load(open('$EXT_DIR/manifest.json'))['version'])")
echo -e "Version: ${Y}$VERSION${N}"

# 2. Check if already deployed
if [ -f "$RELEASES_DIR/v$VERSION.crx" ]; then
  echo -e "${Y}v$VERSION already exists. Deleting to repack.${N}"
  rm -f "$RELEASES_DIR/v$VERSION.crx"
fi

# 3. Pack .crx using chromium
echo -e "${G}Packing .crx...${N}"
chromium-browser --pack-extension="$EXT_DIR" --pack-extension-key="$PEM" --no-sandbox --no-message-box 2>&1 | grep -v "^Fontconfig" || true

# Chrome outputs .crx next to the source folder
CRX_OUT="${EXT_DIR}.crx"
if [ ! -f "$CRX_OUT" ]; then
  echo -e "${R}FAIL: Chrome did not produce $CRX_OUT${N}"
  exit 1
fi

SIZE=$(stat -c %s "$CRX_OUT")
SHA256=$(sha256sum "$CRX_OUT" | awk '{print $1}')
echo -e "Size: $SIZE bytes, SHA256: ${SHA256:0:16}..."

# 4. Move to releases
mkdir -p "$RELEASES_DIR"
mv "$CRX_OUT" "$RELEASES_DIR/v$VERSION.crx"
echo -e "${G}→ $RELEASES_DIR/v$VERSION.crx${N}"

# 5. Get changelog from latest commit
CHANGELOG=$(git -C "$REPO_DIR" log -1 --pretty=%B | head -c 500 | sed 's/"/\\"/g')

# 6. Register in Supabase
echo -e "${G}Registering in Supabase...${N}"
REG_RESP=$(curl -s -X POST "$SB_URL/functions/v1/extension-release/register" \
  -H "Content-Type: application/json" \
  -H "X-Release-Secret: $RELEASE_SECRET" \
  -d "{
    \"version\": \"$VERSION\",
    \"download_url\": \"https://app.optimizeup.io/ext/releases/v$VERSION.crx\",
    \"crx_size_bytes\": $SIZE,
    \"crx_sha256\": \"$SHA256\",
    \"changelog\": \"$CHANGELOG\",
    \"packed_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
  }")
echo "$REG_RESP" | python3 -m json.tool 2>/dev/null || echo "$REG_RESP"

# 7. Publish
echo -e "${G}Publishing...${N}"
PUB_RESP=$(curl -s -X POST "$SB_URL/functions/v1/extension-release/publish" \
  -H "Content-Type: application/json" \
  -H "X-Release-Secret: $RELEASE_SECRET" \
  -d "{\"version\": \"$VERSION\"}")
echo "$PUB_RESP" | python3 -m json.tool 2>/dev/null || echo "$PUB_RESP"

# 8. Verify
echo -e "${G}Verifying download...${N}"
HTTP_CODE=$(curl -sSLo /dev/null -w "%{http_code}" "https://app.optimizeup.io/ext/releases/v$VERSION.crx")
if [ "$HTTP_CODE" = "200" ]; then
  echo -e "${G}✅ Deployed v$VERSION — all systems go${N}"
  echo -e "   Download: https://app.optimizeup.io/ext/releases/v$VERSION.crx"
  echo -e "   Extension will auto-update within ~5 min"
else
  echo -e "${R}⚠️  Download URL returned HTTP $HTTP_CODE — check nginx${N}"
fi
