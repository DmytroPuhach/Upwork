#!/bin/bash
# OptimizeUp Extension Auto-Deploy
# Run on VPS after git pull
# Auto-generates .pem on first run if absent.

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/Upwork}"
EXT_DIR="$REPO_DIR/extension"
KEYS_DIR="${KEYS_DIR:-$HOME/.keys}"
PEM="${PEM:-$KEYS_DIR/ext.pem}"
RELEASES_DIR="/var/www/optimizeup-ext/releases"
SB_URL="https://nsmcaexdqbipusjuzfht.supabase.co"
RELEASE_SECRET="${RELEASE_SECRET:-optimizeup_release_2026_ZpQ9xA}"

R="\033[0;31m"; G="\033[0;32m"; Y="\033[1;33m"; B="\033[0;34m"; N="\033[0m"

echo -e "${B}=== OptimizeUp Extension Deploy ===${N}"

# 0. Check prerequisites
if ! command -v chromium-browser >/dev/null 2>&1; then
  echo -e "${R}FATAL: chromium-browser not installed.${N}"
  echo "Run: sudo apt install -y chromium-browser"
  exit 1
fi

if [ ! -d "$EXT_DIR" ]; then
  echo -e "${R}FATAL: Extension directory not found: $EXT_DIR${N}"
  echo "Run: cd /opt && sudo git clone https://github.com/DmytroPuhach/Upwork.git"
  exit 1
fi

# 1. Auto-generate .pem if missing (first run)
if [ ! -f "$PEM" ]; then
  echo -e "${Y}No .pem found at $PEM — generating new key...${N}"
  mkdir -p "$KEYS_DIR"
  openssl genrsa -out "$PEM" 2048 2>/dev/null
  chmod 600 "$PEM"
  echo -e "${G}✓ Generated new signing key at $PEM${N}"
  echo -e "${Y}⚠️  BACKUP THIS FILE: $PEM${N}"
  echo -e "${Y}    Losing it = all future updates become 'new extension' with different ID${N}"
  echo -e "${Y}    Recommended: cat $PEM | copy to 1Password NOW${N}"
  echo ""
  # Brief pause for user to notice
  sleep 2
fi

# Show .pem fingerprint (for your records)
PEM_FP=$(openssl rsa -in "$PEM" -pubout 2>/dev/null | openssl dgst -sha256 | awk '{print $2}' | head -c 16)
echo -e "Signing key fingerprint: ${B}$PEM_FP...${N}"

# 2. Read version from manifest
VERSION=$(python3 -c "import json; print(json.load(open('$EXT_DIR/manifest.json'))['version'])")
echo -e "Version: ${Y}$VERSION${N}"

# 3. Check if this version already deployed
CRX_TARGET="$RELEASES_DIR/v$VERSION.crx"
if [ -f "$CRX_TARGET" ]; then
  echo -e "${Y}v$VERSION already exists at $CRX_TARGET — will rebuild${N}"
  rm -f "$CRX_TARGET"
fi

# 4. Pack .crx using chromium
echo -e "${G}Packing .crx...${N}"
# Chromium outputs .crx next to source folder
# On headless server, need --no-sandbox + virtual display or flags
chromium-browser \
  --pack-extension="$EXT_DIR" \
  --pack-extension-key="$PEM" \
  --no-sandbox \
  --no-message-box \
  --headless=new \
  --disable-gpu \
  2>&1 | grep -Ev "^(Fontconfig|\\[.*WARN|DevTools)" || true

# Chromium puts .crx at /opt/Upwork/extension.crx
CRX_OUT="${EXT_DIR}.crx"

# Wait a moment for file write
sleep 1

if [ ! -f "$CRX_OUT" ]; then
  echo -e "${R}FAIL: Chromium did not produce $CRX_OUT${N}"
  echo "Try running manually to see errors:"
  echo "  chromium-browser --pack-extension=$EXT_DIR --pack-extension-key=$PEM --no-sandbox"
  exit 1
fi

SIZE=$(stat -c %s "$CRX_OUT")
SHA256=$(sha256sum "$CRX_OUT" | awk '{print $1}')
echo -e "  Size: ${B}$SIZE bytes${N}"
echo -e "  SHA256: ${B}${SHA256:0:16}...${N}"

# 5. Move to releases directory
mkdir -p "$RELEASES_DIR"
mv "$CRX_OUT" "$CRX_TARGET"
echo -e "${G}✓ Moved to $CRX_TARGET${N}"

# 6. Get changelog from git commit
CHANGELOG=$(git -C "$REPO_DIR" log -1 --pretty=%B 2>/dev/null | head -c 500 | sed 's/"/\\"/g; s/\n/ /g' || echo "Manual deploy")

# 7. Register in Supabase
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
    \"pem_fingerprint\": \"$PEM_FP\",
    \"packed_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
  }")
echo "$REG_RESP" | python3 -m json.tool 2>/dev/null || echo "$REG_RESP"

# 8. Publish (make current)
echo -e "${G}Publishing...${N}"
PUB_RESP=$(curl -s -X POST "$SB_URL/functions/v1/extension-release/publish" \
  -H "Content-Type: application/json" \
  -H "X-Release-Secret: $RELEASE_SECRET" \
  -d "{\"version\": \"$VERSION\"}")
echo "$PUB_RESP" | python3 -m json.tool 2>/dev/null || echo "$PUB_RESP"

# 9. Verify public download
echo -e "${G}Verifying HTTPS download...${N}"
HTTP_CODE=$(curl -sSLo /dev/null -w "%{http_code}" "https://app.optimizeup.io/ext/releases/v$VERSION.crx" || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  echo -e "${G}========================================${N}"
  echo -e "${G}  ✅ DEPLOYED v$VERSION${N}"
  echo -e "${G}========================================${N}"
  echo -e "  Download: https://app.optimizeup.io/ext/releases/v$VERSION.crx"
  echo -e "  Chrome auto-update in ~5 min"
else
  echo -e "${R}⚠️  Download URL returned HTTP $HTTP_CODE${N}"
  echo "Check nginx config and /var/www/optimizeup-ext/releases/"
  exit 1
fi
