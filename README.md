# OptimizeUp Agency Workspace

Private repo for OptimizeUp Upwork agency tooling.

## Structure

- `extension/` — Chrome extension (manifest v3) that runs on team members' machines
- `scripts/` — Deploy scripts for VPS
- `docs/` — Architecture decisions, runbooks

## Extension auto-deploy pipeline

1. **Code change** → Claude (via Supabase Edge Function `github-push`) commits to `main`
2. **VPS cron** → `scripts/auto-pull.sh` runs every minute, detects change in `extension/`
3. **Build** → `scripts/deploy.sh` packs `.crx` with stored `.pem` key
4. **Publish** → HTTP POST to `extension-release/register` + `/publish`
5. **Auto-update** → Chrome checks `extension-updates-xml` every ~5 min, downloads new version
6. **Team updated** → All 5 freelancers on latest version within ~10 min, zero manual action

## VPS setup (one-time)

```bash
ssh optimizeup@161.97.148.194

sudo apt install -y chromium-browser
cd /opt && sudo git clone https://github.com/DmytroPuhach/Upwork.git
sudo chown -R optimizeup:optimizeup /opt/Upwork

mkdir -p ~/.keys
# Upload .pem from local (on your Mac):
#   scp ~/optimizeup-extension-v17.pem optimizeup@VPS:/home/optimizeup/.keys/ext.pem
chmod 600 ~/.keys/ext.pem

# Cron for auto-deploy on every push
( crontab -l 2>/dev/null; echo "* * * * * /opt/Upwork/scripts/auto-pull.sh >> /var/log/optimizeup-deploy.log 2>&1" ) | crontab -

sudo touch /var/log/optimizeup-deploy.log
sudo chown optimizeup:optimizeup /var/log/optimizeup-deploy.log
```

## Manual deploy (if cron paused)

```bash
cd /opt/Upwork && git pull && ./scripts/deploy.sh
```

## Install extension on a freelancer's machine

1. Open `https://app.optimizeup.io/ext/releases/v17.0.1.crx` in Chrome
2. Confirm install
3. On first Upwork page load — extension identifies itself and posts heartbeat
4. Popup shows `Account: davyd` (or whatever the slug is)

## Team onboarding

New freelancer = SQL INSERT in `team_members`. No code changes needed.

```sql
INSERT INTO upwork.team_members (
  slug, full_name, display_name, aliases, role, is_active, is_bidding_enabled
) VALUES (
  'newguy', 'New Guy', 'NewGuy', ARRAY['newguy','ng'],
  'freelancer', true, true
);
```

## Status dashboards

- `SELECT * FROM upwork.v_extension_health;` — who's online, version, heartbeats
- `SELECT * FROM upwork.v_scraper_health;` — selector success/failure last 24h
- `SELECT * FROM upwork.v_member_costs WHERE day >= CURRENT_DATE - 7;` — per-member ROI
