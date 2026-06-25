# RADAR INVARIANT — read before any monitoring/panel change

Feed **monitoring + enrich + operator panel** run **ONLY on the radar machine**
(logged into a WATCH account, not a bidding account).

- Gated by `RADAR_BUILD` in `scripts/background.js`. When `true`, this build is the radar.
- **The Step 3 teammate-metrics build MUST ship with `RADAR_BUILD = false`** (or strip the
  monitoring/enrich/panel code entirely). Teammate machines only report stats — they must never
  scan the feed, open job tabs, score, or render the operator panel.
- The operator panel (`scripts/content.js`, `#ou-operator-panel`) is the **only UI surface** in
  the system. It is dormant unless `background` pushes `PANEL_CARD`, which only happens on
  `RADAR_BUILD`. Do not wire any other UI.

## Flow (radar only)
```
peak window + manual Start + search tab focused
  → reload search (jittered 45–90s)
  → content.js scrapes cards → JOBS_CANDIDATES
  → background reviewJob: open job tab → enrich.js (full_text)
  → extension-job-enrich → leadgen-v2 mode:score_route  (writes match_scores, returns account_fit)
  → PANEL_CARD → operator panel card
  → operator ticks accounts + Approve
  → APPROVE_COVERS → leadgen-v2 mode:generate_cover × N (full_text passed through)
  → TG to each ticked account's owner
```

## Peak windows
Config lives in `accounts.scrape_preset.peak_windows` (radar account), returned in
`cachedIdentity.scrape_preset` by `/identify`:
```json
"peak_windows": [{ "start": "09:00", "end": "12:30", "timezone": "Europe/Berlin" }]
```
Empty/missing → always in-window (radar runs whenever Start is pressed).
