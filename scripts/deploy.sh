#!/bin/bash
# OptimizeUp Extension Auto-Deploy
# Run on VPS after git pull. Auto-generates .pem on first run.
# Chrome binary: tries google-chrome > chromium > chromium-browser

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

# 0. Find chrome binary (google-chrome preferred, snap chromium doesn't work with /opt/)
CHROME=""
for binary in google-chrome google-chrome-stable chrome chromium chromium-browser; do
  if command -v "$binary" >/dev/null 2>&1; then
    # Skip snap chromium (it's sandboxed)
    BINPATH=$(command -v "$binary")
    if readlink -f "$BINPATH" 2>/dev/null | grep -q snap; then
      echo -e "${Y}Skipping $binary (snap sandbox can't access /opt/)${N}"
      continue
    fi
    CHROME="$binary"
    break
  fi
done

if [ -z "$CHROME" ]; then
  echo -e "${R}FATAL: No suitable Chrome/Chromium found.${N}"
  echo "Install via:"
  echo "  wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
  echo "  sudo apt install -y ./google-chrome-stable_current_amd64.deb"
  exit 1
fi
echo -e "Chrome binary: ${B}$CHROME${N} ($(command -v $CHROME))"

if [ ! -d "$EXT_DIR" ]; then
  echo -e "${R}FATAL: Extension directory not found: $EXT_DIR${N}"
  exit 1
fi

# 1. Auto-generate .pem if missing
if [ ! -f "$PEM" ]; then
  echo -e "${Y}No .pem found — generating new RSA key at $PEM...${N}"
  mkdir -p "$KEYS_DIR"
  openssl genrsa -out "$PEM" 2048 2>/dev/null
  chmod 600 "$PEM"
  echo -e "${G}✓ Generated${N}"
  echo -e "${Y}⚠️  BACKUP THIS FILE: $PEM${N}"
  echo -e "${Y}    cat $PEM  # copy to 1Password NOW${N}"
  sleep 2
fi

PEM_FP=$(openssl rsa -in "$PEM" -pubout 2>/dev/null | openssl dgst -sha256 | awk '{print $2}' | head -c 16)
echo -e "Signing key fingerprint: ${B}$PEM_FP${N}"

# 2. Version
VERSION=$(python3 -c "import json; print(json.load(open('$EXT_DIR/manifest.json'))['version'])")
echo -e "Version: ${Y}$VERSION${N}"

# 3. Clean previous build
CRX_TARGET="$RELEASES_DIR/v$VERSION.crx"
if [ -f "$CRX_TARGET" ]; then
  echo -e "${Y}v$VERSION exists — rebuilding${N}"
  rm -f "$CRX_TARGET"
fi

# Remove stale .crx if from previous run
rm -f "${EXT_DIR}.crx"

# 4. Pack .crx
echo -e "${G}Packing .crx using $CHROME...${N}"
$CHROME \
  --pack-extension="$EXT_DIR" \
  --pack-extension-key="$PEM" \
  --no-sandbox \
  --headless=new \
  --disable-gpu \
  --no-message-box \
  2>&1 | grep -Ev "^(Fontconfig|DevTools|Failed to load module|libpxbackend)" || true

sleep 2

CRX_OUT="${EXT_DIR}.crx"
if [ ! -f "$CRX_OUT" ]; then
  echo -e "${R}FAIL: Chrome did not produce $CRX_OUT${N}"
  echo "Try manually:"
  echo "  $CHROME --pack-extension=$EXT_DIR --pack-extension-key=$PEM --no-sandbox --headless=new"
  exit 1
fi

SIZE=$(stat -c %s "$CRX_OUT")
SHA256=$(sha256sum "$CRX_OUT" | awk '{print $1}')
echo -e "  Size: ${B}$SIZE bytes${N}"
echo -e "  SHA256: ${B}${SHA256:0:16}...${N}"

# 5. Move to releases
mkdir -p "$RELEASES_DIR"
mv "$CRX_OUT" "$CRX_TARGET"
echo -e "${G}✓ $CRX_TARGET${N}"

# 6. Get changelog from last commit
CHANGELOG=$(git -C "$REPO_DIR" log -1 --pretty=%B 2>/dev/null | head -c 500 | tr '\n' ' ' | sed 's/"/\\"/g' || echo "Manual deploy")

# 7. Register
echo -e "${G}Registering in Supabase...${N}"
curl -s -X POST "$SB_URL/functions/v1/extension-release/register" \
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
  }" | python3 -m json.tool 2>/dev/null || echo "(non-json response)"

# 8. Publish
echo -e "${G}Publishing...${N}"
curl -s -X POST "$SB_URL/functions/v1/extension-release/publish" \
  -H "Content-Type: application/json" \
  -H "X-Release-Secret: $RELEASE_SECRET" \
  -d "{\"version\": \"$VERSION\"}" | python3 -m json.tool 2>/dev/null || echo "(non-json response)"

# 9. Verify
echo -e "${G}Verifying HTTPS download...${N}"
HTTP_CODE=$(curl -sSLo /dev/null -w "%{http_code}" "https://app.optimizeup.io/ext/releases/v$VERSION.crx" || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  echo -e "${G}========================================${N}"
  echo -e "${G}  ✅ DEPLOYED v$VERSION${N}"
  echo -e "${G}========================================${N}"
  echo -e "  URL: https://app.optimizeup.io/ext/releases/v$VERSION.crx"
else
  echo -e "${R}⚠️  Download returned HTTP $HTTP_CODE${N}"
  exit 1
fi
