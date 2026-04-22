#!/bin/bash
# OptimizeUp — auto git pull and deploy if extension/ changed
# Run via cron every minute:
#   * * * * * /opt/Upwork/scripts/auto-pull.sh >> /var/log/optimizeup-deploy.log 2>&1

set -e
cd /opt/Upwork

OLD_HASH=$(git log -1 --format=%H -- extension/ 2>/dev/null || echo "none")
git fetch origin main --quiet
git reset --hard origin/main --quiet
NEW_HASH=$(git log -1 --format=%H -- extension/ 2>/dev/null || echo "none")

if [ "$OLD_HASH" != "$NEW_HASH" ]; then
  echo "[$(date -Iseconds)] extension/ changed: $OLD_HASH -> $NEW_HASH"
  bash /opt/Upwork/scripts/deploy.sh
else
  # No changes, silent
  exit 0
fi
