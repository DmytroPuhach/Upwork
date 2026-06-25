# OptimizeUp Metrics — teammate-side tool (SEPARATE build)

A minimal tool for **bidding accounts** (Dima / Davyd / Vasya). One job: a manual
**Scan** button on Upwork stat pages that reads the page and POSTs metrics.

## 🚫 HARD BOUNDARY (do not violate)
This build runs on **bidding accounts**, so it must be **inert except on button press**.
It MUST NEVER contain — and the manifest must never be widened to allow:
- job-feed monitoring / search-card scraping (`content.js` card logic)
- auto-reload of any tab
- background service worker with monitoring logic
- background tabs / enrichment
- any timer/observer that scrapes the feed

**Feed monitoring lives ONLY on the radar** (a dedicated WATCH account, never a bidding
account). If feed-monitoring code ever appears in this build, a bidding account starts
scraping and the whole risk isolation breaks.

Enforcement: the manifest injects `scripts/metrics.js` on **only the 4 stat pages**
(`my-stats`, `proposals`, `plans/connects/history`, `ab/notifications`). It is never
injected on `/nx/search/jobs`. Keep it that way.

## Invariants (system-wide)
- radar = watch account, never bidding.
- feed monitoring = radar-only.
- no extension ever holds the Supabase `service_role` key (anon key only; privileged
  writes gated server-side).

## Status
| Page | Parser | State |
|---|---|---|
| my-stats | `parseMyStats` (ported from radar, PROVEN — 62 runs) | ✅ Scan → parse → POST `/profile-sync/my-stats` (verified: row lands) |
| proposals | `parseProposals` (`__NUXT__.state.lists` via MAIN-world bridge) | ✅ Scan → parse → POST `/profile-sync/proposals` (verified: 2 rows landed) |
| connects-history | `parseConnectsHistory` (DOM table `#connects-history-table`) | ✅ Scan → parse → POST `/profile-sync/connects-history` (verified: rows landed in connects_ledger) |
| notifications | `parseNotifications` (`notificationsMap` via bridge) | ✅ Scan → parse → POST `/profile-sync/notifications` (verified: proposal viewed_at update landed) |

Note: connects history is client-rendered (not in `__NUXT__`); parsed from the DOM table. Rows have
no stable txn id and can be identical, so the id is synthesized `${dateISO}#${action}#${delta}#${seq}`
(stable for historical days). No balance column on the table → `balance_after` is null.

Reading `window.__NUXT__` (live object) requires `scripts/nuxt-bridge.js` (a read-only MAIN-world
content script) because the isolated content script can't see page globals. my-stats uses the
`__NUXT_DATA__` script literal directly (no bridge needed).

All four parsers were built **one at a time** against captured live DOM/Nuxt samples and each
verified to land a row before moving on (no blind writes). notifications updates `proposals`
(viewed_at/hired_at), matched by job id (jobs.upwork_job_id → proposals.job_id).

## Flow
`operator opens stat page → clicks Scan → metrics.js reads page → POST (anon key +
machine_id) → profile-sync edge`. Account is resolved via `extension-config/identify`
(machine_id + page uid) — read-only, no service_role.

## Cadence + reminder (v1.4.0)
Per-page freshness: my-stats 6h · proposals 2h · connects-history 24h · notifications 4h.
- **Auto-scan-on-visit:** when the operator opens a stat page that is stale, it scans automatically.
  It only ever runs the page the operator is already on — it NEVER opens tabs or runs in the
  background (the HARD BOUNDARY stays intact: no auto tab-opening on a bidding account).
- **Reminder banner:** on any stat page, shows which pages are overdue ("⏰ давно не сканил: …")
  so the operator knows to open + Scan them. Just a nudge — no auto-action on pages not open.

## Install
Load `optimizeup-metrics/` as an unpacked extension on the teammate's Chrome.
This is a SEPARATE extension from the radar build — never merge the two.
