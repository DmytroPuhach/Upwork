// OptimizeUp Extension v17.1.4 — Profile Sync Injectable
// Runs in a background tab after it's fully loaded on one of:
//   /nx/my-stats/
//   /nx/proposals/
//   /nx/plans/connects/history/
//
// Extracts Nuxt state (3 or 2 depending on page), parses into the shape
// expected by the profile-sync edge function, POSTs it, and reports
// { ok, page, ingested, updated, error } back to background.js.
//
// Contract: emits ONE message via chrome.runtime.sendMessage:
//   { type: 'PROFILE_SYNC_RESULT', payload: {...} }
//
// Design constraint: all HTTP activity goes through the page's own fetch()
// with credentials:'include' — this way cookies, UA, TLS fingerprint and
// Cloudflare clearance all look identical to normal user browsing. No XHR
// to separate endpoints that could skew the fingerprint.

(function () {
  'use strict';

  const START_TS = Date.now();
  const HARD_TIMEOUT_MS = 20000;
  const POLL_INTERVAL_MS = 400;
  const SB_URL = 'https://nsmcaexdqbipusjuzfht.supabase.co';
  const SYNC_ENDPOINT = `${SB_URL}/functions/v1/profile-sync`;

  function log(...a) { console.log('[OU profile-sync]', ...a); }
  function warn(...a) { console.warn('[OU profile-sync]', ...a); }

  try { sessionStorage.setItem('ou_profile_sync_active', '1'); } catch {}

  // ═══════════════════════════════════════════════════════════
  // AUTH DETECTION — bail cleanly if Upwork logged us out
  // ═══════════════════════════════════════════════════════════

  function detectAuthFailure() {
    const href = location.href;
    if (/\/ab\/account-security\/login/i.test(href)) return 'login_redirect';
    if (/\/nx\/signup/i.test(href)) return 'signup_redirect';
    if (/\/ab\/(?:verify|challenge|captcha)/i.test(href)) return 'challenge';
    const body = document.body?.textContent || '';
    if (/access denied|unusual activity|please verify you are human/i.test(body.substring(0, 2000))) {
      return 'bot_check';
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  // PAGE TYPE DETECTION
  // ═══════════════════════════════════════════════════════════

  function detectPage() {
    const p = location.pathname;
    if (/\/nx\/my-stats/i.test(p)) return 'my-stats';
    if (/\/nx\/proposals/i.test(p)) return 'proposals';
    if (/\/nx\/plans\/connects\/history/i.test(p)) return 'connects-history';
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  // NUXT 3 DEVALUE HYDRATOR (my-stats + connects-history)
  // Input: array like [["Reactive",1], {foo:2}, 3, "bar", ...]
  // Each element is either a primitive, a plain object whose values are
  // indices into the array, or an array of such indices. We resolve
  // recursively starting from index 1 (the standard root).
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
        for (const k in val) {
          if (Object.prototype.hasOwnProperty.call(val, k)) {
            out[k] = resolve(val[k], s);
          }
        }
        return out;
      }

      return val;
    }

    try { return resolve(1, new Set()); } catch (e) { warn('hydrate fail', e); return null; }
  }

  function readNuxt3DataFromPage() {
    // Primary: window.__NUXT_DATA__ literal in a <script>
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const txt = s.textContent || '';
      const m = txt.match(/window\.__NUXT_DATA__\s*=\s*(\[[\s\S]+?\])\s*[;<]/);
      if (m) {
        try { return JSON.parse(m[1]); } catch (e) { warn('NUXT_DATA JSON parse fail', e); }
      }
    }
    // Fallback: data-ssr element carrying the payload (older shape)
    const el = document.getElementById('__NUXT_DATA__');
    if (el?.textContent) {
      try { return JSON.parse(el.textContent); } catch {}
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  // NUXT 2 IIFE PARSER (/nx/proposals/)
  // Pattern: window.__NUXT__=(function(a,b,c,...){...return {state:{...}}}(arg1,arg2,...));
  // We eval the IIFE via new Function in the page context (safe — it's
  // Upwork's own script, we're just re-running it to get its return value).
  // ═══════════════════════════════════════════════════════════

  function readNuxt2FromPage() {
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const txt = s.textContent || '';
      if (txt.indexOf('window.__NUXT__') === -1) continue;
      // Try literal first (sometimes Nuxt 2 outputs a plain object too)
      const lit = txt.match(/window\.__NUXT__\s*=\s*(\{[\s\S]+?\})\s*;/);
      if (lit) {
        try { return JSON.parse(lit[1]); } catch {}
      }
      // IIFE form
      const iife = txt.match(/window\.__NUXT__\s*=\s*(\(function\s*\([^)]*\)\s*\{[\s\S]+?\}\s*\([\s\S]+?\)\));?/);
      if (iife) {
        try {
          // Re-evaluate as expression. We wrap in parens to force expression
          // context. This is Upwork's own serialized state — no external input.
          const fn = new Function('return ' + iife[1]);
          return fn();
        } catch (e) {
          warn('NUXT 2 IIFE eval fail:', e?.message);
        }
      }
    }
    // Last-resort: some Nuxt 2 installs ALSO hydrate through window.__NUXT__
    // after the script ran. Since enrich runs at document_idle, check it.
    try {
      if (typeof window.__NUXT__ === 'object' && window.__NUXT__) return window.__NUXT__;
    } catch {}
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  // PARSER: /nx/my-stats/
  // ═══════════════════════════════════════════════════════════

  function parseMyStats(state) {
    if (!state) return null;

    const out = {
      jss: null,
      earnings_12mo_usd: null,
      connects_balance: null,
      connects_earned_next_month: null,
      proposals_sent_7d: null,
      proposals_viewed_7d: null,
      interviews_7d: null,
      hires_7d: null,
      profile_views_7d: null,
      invites_7d: null,
      impressions_7d: null,
      client_relationships_90d_plus_pct: null,
    };

    // Profile header stats items
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

    // Connects balance
    const cb = state?.plansConnects?.connectsBalance;
    if (cb) {
      if (typeof cb.total === 'number') out.connects_balance = cb.total;
      if (typeof cb.earnedNextMonth === 'number') out.connects_earned_next_month = cb.earnedNextMonth;
    }

    // 7-day metrics — sum BOOSTED + ORGANIC per metric
    const metrics = state?.userProposalMetrics?.data?.items;
    if (Array.isArray(metrics)) {
      const bucket = {
        PROPOSALS_SENT: 0, PROPOSALS_VIEWED: 0, PROPOSALS_INTERVIEWED: 0,
        PROPOSALS_HIRED: 0, PROFILE_VIEWS: 0, INVITES: 0, IMPRESSIONS: 0,
      };
      for (const m of metrics) {
        const rawName = String(m?.reasonName || m?.name || '');
        const sum = Number(m?.sum ?? m?.count ?? 0) || 0;
        for (const k of Object.keys(bucket)) {
          if (rawName.includes(k)) { bucket[k] += sum; break; }
        }
      }
      out.proposals_sent_7d = bucket.PROPOSALS_SENT;
      out.proposals_viewed_7d = bucket.PROPOSALS_VIEWED;
      out.interviews_7d = bucket.PROPOSALS_INTERVIEWED;
      out.hires_7d = bucket.PROPOSALS_HIRED;
      out.profile_views_7d = bucket.PROFILE_VIEWS;
      out.invites_7d = bucket.INVITES;
      out.impressions_7d = bucket.IMPRESSIONS;
    }

    return out;
  }

  // ═══════════════════════════════════════════════════════════
  // PARSER: /nx/proposals/
  // ═══════════════════════════════════════════════════════════

  function msToIso(n) {
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return null;
    // Upwork sometimes sends seconds, sometimes ms
    const ms = n < 10_000_000_000 ? n * 1000 : n;
    try { return new Date(ms).toISOString(); } catch { return null; }
  }

  function parseProposals(state) {
    const list =
      state?.user?.proposals?.list ||
      state?.proposals?.list ||
      state?.applications?.list ||
      [];
    if (!Array.isArray(list)) return [];

    const out = [];
    for (const p of list) {
      const appUid = p?.applicationUID || p?.applicationUid || p?.uid;
      if (!appUid) continue;

      const createdTs =
        p?.auditDetails?.createdTs ?? p?.auditDetails?.created_ts ?? p?.createdTs ?? null;
      const viewedTs =
        p?.auditDetails?.viewedTs ?? p?.viewedTs ?? null;
      const repliedTs =
        p?.auditDetails?.firstClientReplyTs ?? p?.firstClientReplyTs ?? null;
      const hiredTs =
        p?.auditDetails?.hiredTs ?? p?.hiredTs ?? null;

      const connectsBid =
        p?.terms?.connectsBid ?? p?.connectsBid ?? p?.connects_bid ?? null;
      const connectsBoost =
        p?.terms?.connectsBoost ?? p?.connectsBoost ?? 0;
      const connectsUsed =
        connectsBid != null ? Number(connectsBid) + Number(connectsBoost || 0) : null;

      const interviewCount =
        p?.interviewCount ?? p?.otherAnnotations?.interviewCount ?? 0;

      const isWinner = p?.status === 'HIRED' || !!p?.isWinner;
      const outcomeStr =
        p?.status === 'HIRED' ? 'hired' :
        p?.status === 'DECLINED' ? 'declined' :
        p?.status === 'WITHDRAWN' ? 'withdrawn' :
        null;

      const jobUid = p?.openingUID || p?.opening_uid || p?.jobUid || null;

      out.push({
        upwork_proposal_id: String(appUid).replace(/^~/, ''),
        upwork_proposal_url: jobUid ? `https://www.upwork.com/jobs/~${String(jobUid).replace(/^~/, '')}` : null,
        status: p?.status || null,
        sent_at: msToIso(createdTs),
        viewed_at: msToIso(viewedTs),
        first_client_reply_at: msToIso(repliedTs),
        replied_at: msToIso(repliedTs),
        hired_at: msToIso(hiredTs),
        connects_used: connectsUsed,
        interview_count: Number(interviewCount) || 0,
        is_winner: isWinner,
        outcome: outcomeStr,
      });
    }
    return out;
  }

  // ═══════════════════════════════════════════════════════════
  // PARSER: /nx/plans/connects/history/
  // ═══════════════════════════════════════════════════════════

  // Mapping confirmed empirically (see parsing doc §3):
  // 3=bid, 30=boost, 7=job_cancellation_refund, 31=withdraw_refund,
  // 28=availability_badge, 35=unknown_TBD
  const REASON_MAP = {
    3: 'bid',
    30: 'boost',
    7: 'job_cancellation_refund',
    31: 'withdraw_refund',
    28: 'availability_badge',
    35: 'unknown_reason_35',
  };

  function parseConnectsHistory(state) {
    const rows =
      state?.connectsHistory?.items ||
      state?.connectsLedger?.items ||
      state?.plansConnects?.history?.items ||
      state?.history?.items ||
      [];
    if (!Array.isArray(rows)) return [];

    const out = [];
    for (const r of rows) {
      const txId = r?.id || r?.transactionId || r?.txId;
      if (!txId) continue;

      const reasonId = Number(r?.reasonId ?? r?.reason_id ?? -1);
      const mappedType = REASON_MAP[reasonId] || (r?.transactionType || r?.type || 'other');

      const delta = Number(r?.amount ?? r?.delta ?? 0);
      if (!isFinite(delta)) continue;

      const balanceAfter =
        typeof r?.balanceAfter === 'number' ? r.balanceAfter :
        typeof r?.balance_after === 'number' ? r.balance_after : null;

      const occurredMs = r?.occurredAt ?? r?.occurred_at ?? r?.createdTs ?? r?.timestamp ?? null;
      const occurredIso = msToIso(typeof occurredMs === 'number' ? occurredMs : null) ||
        (typeof occurredMs === 'string' ? occurredMs : null);
      if (!occurredIso) continue;

      // `reference` is the applicationUID for bid/boost, the job id for refunds
      const reference = r?.reference || r?.reference_id || r?.referenceId || null;
      const upwork_proposal_id = /^~?\d{15,}$/.test(String(reference || '')) ? String(reference).replace(/^~/, '') : null;

      const jobId = r?.upworkJobId || r?.jobId || r?.opening_uid || null;

      // Bid-side transactions are DEBIT (negative delta). Upwork sometimes
      // ships positive numbers with a separate sign flag — normalize here.
      const sign =
        r?.direction === 'CREDIT' || r?.sign === 1 ? 1 :
        r?.direction === 'DEBIT' || r?.sign === -1 ? -1 :
        delta >= 0 ? 1 : -1;
      const signedDelta = Math.abs(delta) * sign;

      out.push({
        upwork_transaction_id: String(txId),
        upwork_proposal_id,
        upwork_job_id: jobId ? String(jobId).replace(/^~/, '') : null,
        transaction_type: mappedType,
        delta: signedDelta,
        balance_after: balanceAfter,
        description: (r?.description || r?.label || '').substring(0, 500) || null,
        occurred_at: occurredIso,
        raw: r,
      });
    }
    return out;
  }

  // ═══════════════════════════════════════════════════════════
  // WAIT FOR HYDRATION — SPA pages have a window where __NUXT_DATA__
  // isn't mounted yet. Poll for up to HARD_TIMEOUT_MS.
  // ═══════════════════════════════════════════════════════════

  async function waitForNuxt(page) {
    const started = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        const auth = detectAuthFailure();
        if (auth) return resolve({ auth_failure: auth });

        const state = page === 'proposals' ? readNuxt2FromPage() : hydrateNuxt3(readNuxt3DataFromPage());
        if (state && typeof state === 'object') return resolve({ state });

        if (Date.now() - started > HARD_TIMEOUT_MS) return resolve({ timeout: true });
        setTimeout(tick, POLL_INTERVAL_MS);
      };
      tick();
    });
  }

  // ═══════════════════════════════════════════════════════════
  // MAIN
  // ═══════════════════════════════════════════════════════════

  async function run() {
    const page = detectPage();
    if (!page) {
      report({ ok: false, error_type: 'wrong_page', error_detail: location.pathname });
      return;
    }
    log('started on', page, location.href.substring(0, 120));

    const early = detectAuthFailure();
    if (early) { report({ ok: false, page, error_type: early }); return; }

    // Short human-like scroll — consistent with enrich.js anti-ban posture.
    try {
      window.scrollTo({ top: 200 + Math.floor(Math.random() * 200), behavior: 'smooth' });
      await sleep(800 + Math.random() * 700);
      window.scrollTo({ top: 500 + Math.floor(Math.random() * 400), behavior: 'smooth' });
      await sleep(900 + Math.random() * 900);
    } catch {}

    const res = await waitForNuxt(page);
    if (res.auth_failure) { report({ ok: false, page, error_type: res.auth_failure }); return; }
    if (res.timeout) { report({ ok: false, page, error_type: 'nuxt_timeout' }); return; }

    const state =
      res.state?.state /* nuxt 2 has .state inside */ ||
      res.state?._state ||
      res.state;

    // Parse
    let body;
    let parsedCount = 0;
    try {
      if (page === 'my-stats') {
        const stats = parseMyStats(state);
        if (!stats) { report({ ok: false, page, error_type: 'parse_empty' }); return; }
        body = { stats, raw_payload: null /* omit to keep payload small */ };
        parsedCount = 1;
      } else if (page === 'proposals') {
        const proposals = parseProposals(state);
        body = { proposals };
        parsedCount = proposals.length;
      } else if (page === 'connects-history') {
        const transactions = parseConnectsHistory(state);
        body = { transactions };
        parsedCount = transactions.length;
      }
    } catch (e) {
      report({ ok: false, page, error_type: 'parser_exception', error_detail: String(e?.message || e) });
      return;
    }

    if (!body || (parsedCount === 0 && page !== 'my-stats')) {
      report({ ok: false, page, error_type: 'no_items', error_detail: `state keys: ${Object.keys(state || {}).slice(0, 10).join(',')}` });
      return;
    }

    // Account slug — background.js passes it via document.body dataset before inject,
    // or we fall back to sessionStorage.
    const accountSlug = (document.body?.dataset?.ouAccountSlug) ||
                        sessionStorage.getItem('ou_account_slug') ||
                        null;
    if (!accountSlug) {
      report({ ok: false, page, error_type: 'no_account_slug' });
      return;
    }

    // POST from page context (same cookies / TLS / UA as the user).
    try {
      const res = await fetch(`${SYNC_ENDPOINT}/${page}`, {
        method: 'POST',
        credentials: 'omit',  // Supabase endpoint, no need for Upwork cookies
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_slug: accountSlug, ...body }),
      });
      const data = await res.json().catch(() => ({}));
      report({
        ok: !!data.ok,
        page,
        parsed: parsedCount,
        ingested: data.ingested ?? data.updated ?? (data.ok ? 1 : 0),
        updated: data.updated ?? 0,
        status: res.status,
        error: data.error || null,
      });
    } catch (e) {
      report({ ok: false, page, error_type: 'post_failed', error_detail: String(e?.message || e) });
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function report(payload) {
    payload.duration_ms = Date.now() - START_TS;
    try { chrome.runtime.sendMessage({ type: 'PROFILE_SYNC_RESULT', payload }); } catch {}
  }

  run().catch((e) => {
    warn('run threw', e);
    report({ ok: false, error_type: 'exception', error_detail: String(e?.message || e).substring(0, 300) });
  });
})();
