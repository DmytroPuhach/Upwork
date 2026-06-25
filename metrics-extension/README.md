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
| connects-history | — | 📋 Scan = capture live sample (connects_ledger empty since creation) |
| notifications | — | 📋 Scan = capture live sample (0 runs ever) |

Reading `window.__NUXT__` (live object) requires `scripts/nuxt-bridge.js` (a read-only MAIN-world
content script) because the isolated content script can't see page globals. my-stats uses the
`__NUXT_DATA__` script literal directly (no bridge needed).

The three missing parsers are built **one at a time**: capture live DOM/Nuxt sample →
write parser against the REAL current shape → verify a row lands → next. No blind writes.

## Flow
`operator opens stat page → clicks Scan → metrics.js reads page → POST (anon key +
machine_id) → profile-sync edge`. Account is resolved via `extension-config/identify`
(machine_id + page uid) — read-only, no service_role.

## Install
Load `optimizeup-metrics/` as an unpacked extension on the teammate's Chrome.
This is a SEPARATE extension from the radar build — never merge the two.
