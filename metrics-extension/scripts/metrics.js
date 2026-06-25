// OptimizeUp Metrics v1.0.0 — Teammate-side metrics tool (content script)
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ HARD BOUNDARY — THIS BUILD RUNS ON BIDDING ACCOUNTS (Dima/Davyd/Vasya).    ║
// ║ It MUST stay inert except on an explicit "Scan" button press.             ║
// ║ It MUST NEVER contain: job-feed monitoring, auto-reload, search-card       ║
// ║ scraping, background.js, or any timer/observer that scrapes the feed.      ║
// ║ Feed monitoring lives ONLY on the radar (watch account). If feed code      ║
// ║ appears here, a bidding account starts scraping and risk isolation breaks. ║
// ║ The manifest only injects on the 4 stat pages — keep it that way.          ║
// ╚══════════════════════════════════════════════════════════════════════════╝

(function () {
  'use strict';

  const SB_URL = 'https://nsmcaexdqbipusjuzfht.supabase.co';
  // anon key is public by design; privileged writes are gated server-side. NO service_role here.
  const SB_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zbWNhZXhkcWJpcHVzanV6Zmh0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM3MzcxMzcsImV4cCI6MjA4OTMxMzEzN30.SNZmkdBscH23J29nTfwd3luKc5MYyPXnNkp2eNxFU1Y';
  const SYNC = `${SB_URL}/functions/v1/profile-sync`;

  function log(...a) { console.log('[OU metrics]', ...a); }
  function warn(...a) { console.warn('[OU metrics]', ...a); }

  function pageType() {
    const p = location.pathname;
    if (/\/nx\/my-stats/.test(p)) return 'my-stats';
    if (/\/nx\/proposals/.test(p)) return 'proposals';
    if (/\/nx\/plans\/connects\/history/.test(p)) return 'connects-history';
    if (/\/ab\/notifications/.test(p)) return 'notifications';
    return null;
  }

  // ── identity (read-only): machine_id + slug via extension-config/identify ──
  async function getMachineId() {
    const r = await chrome.storage.local.get('metricsMachineId');
    if (r.metricsMachineId) return r.metricsMachineId;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ metricsMachineId: id });
    return id;
  }

  // Nuxt SSR serializes the logged-in user's cipher (~01…) into inline scripts.
  function detectUid() {
    for (const s of document.querySelectorAll('script')) {
      const t = s.textContent || '';
      if (t.length < 50) continue;
      const m = t.match(/~01[0-9a-f]{14,18}/);
      if (m) return m[0];
    }
    return null;
  }

  async function resolveAccountSlug() {
    const cached = await chrome.storage.local.get(['metricsSlug', 'metricsSlugAt']);
    if (cached.metricsSlug && cached.metricsSlugAt && (Date.now() - cached.metricsSlugAt < 6 * 3600 * 1000)) {
      return cached.metricsSlug;
    }
    const machine_id = await getMachineId();
    const upwork_user_id = detectUid();
    try {
      const res = await fetch(`${SB_URL}/functions/v1/extension-config/identify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SB_ANON_KEY}` },
        body: JSON.stringify({ machine_id, upwork_user_id }),
      });
      const data = await res.json().catch(() => ({}));
      const slug = data?.member?.slug || null;
      if (slug) await chrome.storage.local.set({ metricsSlug: slug, metricsSlugAt: Date.now() });
      return slug;
    } catch (e) { warn('identify failed', e?.message); return null; }
  }

  // ═══════════════════════════════════════════════════════════
  // NUXT 3 DEVALUE HYDRATOR (ported verbatim from the proven radar profile-sync)
  // ═══════════════════════════════════════════════════════════
  function hydrateNuxt3(arr) {
    if (!Array.isArray(arr) || arr.length < 2) return null;
    function resolve(idx, seen) {
      if (idx === -1 || idx === undefined || idx === null) return null;
      if (typeof idx !== 'number') return idx;
      if (seen.has(idx)) return null;
      const s = new Set(seen); s.add(idx);
      const val = arr[idx];
      if (val === undefined) return null;
      if (Array.isArray(val)) return val.map(x => resolve(x, s));
      if (val !== null && typeof val === 'object') {
        const out = {};
        for (const k in val) if (Object.prototype.hasOwnProperty.call(val, k)) out[k] = resolve(val[k], s);
        return out;
      }
      return val;
    }
    try { return resolve(1, new Set()); } catch (e) { warn('hydrate fail', e); return null; }
  }

  function readNuxt3DataFromPage() {
    for (const s of document.querySelectorAll('script')) {
      const txt = s.textContent || '';
      const m = txt.match(/window\.__NUXT_DATA__\s*=\s*(\[[\s\S]+?\])\s*[;<]/);
      if (m) { try { return JSON.parse(m[1]); } catch (e) { warn('NUXT_DATA parse fail', e); } }
    }
    const el = document.getElementById('__NUXT_DATA__');
    if (el?.textContent) { try { return JSON.parse(el.textContent); } catch {} }
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  // PARSER: /nx/my-stats/  — PROVEN (62 successful runs). Kept verbatim.
  // ═══════════════════════════════════════════════════════════
  function parseMyStats(state) {
    if (!state) return null;
    const out = {
      jss: null, earnings_12mo_usd: null, connects_balance: null, connects_earned_next_month: null,
      proposals_sent_7d: null, proposals_viewed_7d: null, interviews_7d: null, hires_7d: null,
      profile_views_7d: null, invites_7d: null, impressions_7d: null, client_relationships_90d_plus_pct: null,
    };
    const headerItems = state?.userProfileStatsHeader?.data?.stats?.items;
    if (Array.isArray(headerItems)) {
      for (const it of headerItems) {
        const t = it?.type || it?.statType || '';
        const amt = it?.amount ?? it?.pci?.display ?? null;
        if (/JOB_SUCCESS_SCORE/i.test(t)) out.jss = Number(it?.pci?.display ?? amt) || null;
        else if (/EARNINGS_365_NO_PENDING|EARNINGS_12MO/i.test(t)) out.earnings_12mo_usd = Number(amt) || null;
        else if (/CLIENT_RELATIONSHIPS_90_PLUS/i.test(t)) out.client_relationships_90d_plus_pct = Number(amt) || null;
      }
    }
    const cb = state?.plansConnects?.connectsBalance;
    if (cb) {
      if (typeof cb.total === 'number') out.connects_balance = cb.total;
      if (typeof cb.earnedNextMonth === 'number') out.connects_earned_next_month = cb.earnedNextMonth;
    }
    const metrics = state?.userProposalMetrics?.data?.items;
    if (Array.isArray(metrics)) {
      const bucket = { PROPOSALS_SENT: 0, PROPOSALS_VIEWED: 0, PROPOSALS_INTERVIEWED: 0, PROPOSALS_HIRED: 0, PROFILE_VIEWS: 0, INVITES: 0, IMPRESSIONS: 0 };
      for (const m of metrics) {
        const rawName = String(m?.reasonName || m?.name || '');
        const sum = Number(m?.sum ?? m?.count ?? 0) || 0;
        for (const k of Object.keys(bucket)) if (rawName.includes(k)) { bucket[k] += sum; break; }
      }
      out.proposals_sent_7d = bucket.PROPOSALS_SENT; out.proposals_viewed_7d = bucket.PROPOSALS_VIEWED;
      out.interviews_7d = bucket.PROPOSALS_INTERVIEWED; out.hires_7d = bucket.PROPOSALS_HIRED;
      out.profile_views_7d = bucket.PROFILE_VIEWS; out.invites_7d = bucket.INVITES; out.impressions_7d = bucket.IMPRESSIONS;
    }
    return out;
  }

  // ── POST helper (anon key + machine_id; no service_role) ──
  async function post(page, body) {
    const account_slug = await resolveAccountSlug();
    if (!account_slug) return { ok: false, error: 'account not identified (open this page while logged in)' };
    const machine_id = await getMachineId();
    const res = await fetch(`${SYNC}/${page}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SB_ANON_KEY}` },
      body: JSON.stringify({ account_slug, machine_id, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    return { http: res.status, ...data };
  }

  // ═══════════════════════════════════════════════════════════
  // SCAN handlers
  //   my-stats   → PROVEN parser → POST
  //   proposals / connects-history / notifications → NOT BUILT YET.
  //     Per spec: capture the live DOM/state sample first, build the parser
  //     against the real Nuxt3 shape, verify a row lands, THEN swap to parse+POST.
  //     Until then, Scan CAPTURES the sample to clipboard so it can be sent for build.
  // ═══════════════════════════════════════════════════════════

  async function scanMyStats(setStatus) {
    const state = hydrateNuxt3(readNuxt3DataFromPage());
    const stats = parseMyStats(state);
    if (!stats) { setStatus('❌ parse_empty (open /nx/my-stats and let it load)'); return; }
    setStatus('Posting…');
    const r = await post('my-stats', { stats, raw_payload: null });
    setStatus(r.ok ? `✅ saved (jss=${stats.jss ?? '?'}, sent7d=${stats.proposals_sent_7d ?? '?'})` : `❌ ${r.error || ('HTTP ' + r.http)}`);
  }

  function captureSample(page, setStatus) {
    // First step of building a parser: dump the real Nuxt3 state + a data-test map.
    const rawData = readNuxt3DataFromPage();
    const hydrated = hydrateNuxt3(rawData);
    const sample = {
      page, url: location.href,
      nuxt3_present: !!rawData,
      hydrated_top_keys: hydrated && typeof hydrated === 'object' ? Object.keys(hydrated).slice(0, 60) : null,
      nuxt_global_keys: (window.__NUXT__ && typeof window.__NUXT__ === 'object') ? Object.keys(window.__NUXT__).slice(0, 40) : null,
      data_test: [...new Set([...document.querySelectorAll('[data-test]')].map(e => e.getAttribute('data-test')))].slice(0, 80),
      hydrated_sample: hydrated ? JSON.stringify(hydrated).slice(0, 6000) : null,
    };
    const out = JSON.stringify(sample);
    try { (navigator.clipboard && navigator.clipboard.writeText(out)); } catch {}
    console.log('[OU metrics] SAMPLE ' + page + ':\n' + JSON.stringify(sample, null, 2));
    setStatus('📋 Sample captured → console + clipboard. Send it to dev to build this parser.');
  }

  // ── UI: single Scan button for the current stat page ──
  function mount() {
    const page = pageType();
    if (!page) return;
    if (document.getElementById('ou-metrics-btn')) return;

    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;display:flex;flex-direction:column;gap:6px;align-items:flex-end;';
    const built = page === 'my-stats';
    const btn = document.createElement('button');
    btn.id = 'ou-metrics-btn';
    btn.textContent = built ? `📊 Scan ${page}` : `📋 Capture ${page} sample`;
    btn.style.cssText = `background:${built ? '#14a800' : '#3c8dbc'};color:#fff;border:0;border-radius:8px;padding:10px 14px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.2);`;
    const status = document.createElement('div');
    status.style.cssText = 'background:#fff;border:1px solid #d5d5d5;border-radius:6px;padding:6px 9px;max-width:300px;color:#001e00;box-shadow:0 2px 8px rgba(0,0,0,.12);display:none;';
    const setStatus = (t) => { status.style.display = 'block'; status.textContent = t; };

    btn.onclick = async () => {
      btn.disabled = true; const orig = btn.textContent; btn.textContent = '…';
      try {
        if (page === 'my-stats') await scanMyStats(setStatus);
        else captureSample(page, setStatus);
      } catch (e) { setStatus('❌ ' + (e?.message || e)); }
      btn.disabled = false; btn.textContent = orig;
    };

    wrap.append(status, btn);
    document.body.appendChild(wrap);
    log('mounted on', page);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(mount, 1200);
  else window.addEventListener('DOMContentLoaded', () => setTimeout(mount, 1200));
})();
