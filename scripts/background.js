// OptimizeUp Extension v19.6.4 — Background Service Worker
// v19.6.4: maybeReloadUpworkTab skips reload while operatorBusyUntil is in the future (operator
//   interacting with the panel) — fixes the panel blinking/closing mid-click.
// v19.6.3: + OPEN_JOB_TAB → chrome.tabs.create (reliable job open; content-script window.open is
//   blocked on Upwork by CSP/popup rules).
// v19.6.2: + CANCEL_COVER → leadgen-v2 cancel_cover (mark proposal cancelled after a sent cover).
// v19.6.1: AI never opens tabs. ANALYZE_FROM_PAGE scores the description content.js read off the
//   operator's OWN open job page (no enrich tab). processNextCandidate/reviewJob disabled (dead).
// v19.4.1: sendPanelCard broadcasts the scored card to ALL upwork tabs (search feed + the job-detail
//   tab the operator opened — the detail panel now lives on the job page).
// v19.4.0: operator-gated AI — removed auto enrich+score. ANALYZE_JOB opens job + enrich + score_route
//   ONLY on operator click (reviewJob returns scoreData + pushes PANEL_CARD; forceAnalyze bypasses stale guard).
//   prematch + peak-window + skip=silence + full_text passthrough unchanged.
// v19.3.0: STEP 2B radar — RADAR_BUILD flag; peak-window + manual-Start + tab-focus gating on
//   reload (jittered 45–90s); reviewJob enrich→score_route→PANEL_CARD; APPROVE_COVERS → generate_cover×N.
//   Monitoring/enrich/panel run ONLY on the radar (RADAR_BUILD); never in the Step 3 teammate build.
// v19.2.3: heartbeat logs HTTP status (diagnose network-fail vs server-reject for stale rows).
// v19.2.0: detectUpworkUser — read Nuxt-serialized ~01 cipher from inline scripts (new Upwork UI).
// v19.1.1: outbound message call now sends machine_id (server authenticates it against extension_status).
// v19.1.0: STEP 0 SECURITY — REMOVED service_role key from extension. toggleBidding now calls
//   extension-config/toggle-bidding; outbound messages call extension-job-enrich/outbound — both with anon key.
// v19.0.5: Add Authorization: Bearer header to all edge function fetch calls (leadgen-v2, extension-job-enrich — were returning 401 silently).
// v19.0.4: Remove quiet hours from processNextCandidate() — pipeline now runs 24/7 while bidding enabled.
// v19.0.3: Removed quiet hours + scrape_settings gate — reload fires every 60s while bidding enabled.
// v19.0.2: Zero-delay pipeline drain — after each job, immediately start next (no setTimeout).
//   handleJobsCandidates adds backup retry in 3s so lock contention never strands jobs.
//   bufferTtlMs reduced 15min → 5min (stale cleanup, not a delay).
// v19.0.1: Fix stale-job guard — skip jobs where actualAge (posted + time in buffer) > 30 min (logged, not silent).
//   Also addToBuffer() rejects items already >25 min old at enqueue time.
// v19.0.0: Fast Manual Triage Mode — 4 independent pipeline stages.
//   JobWatcher (content.js) → PreMatcher (content.js prematchDecide) → JobReviewer (reviewJob) → CoverGenerator (leadgen-v2)
//   Removed: hourly caps, 30s-5min delays, dual in-flight flags, enrichLogCircuit, prerank top-10, ENRICH_MAX_QUEUE=50
//   Added: CONFIG, activeJobLock, candidateBuffer (max 10, TTL 15min), processNextCandidate(), reviewJob()
//   Explicit log tags: FOUND | SKIPPED | OPENED | MATCHED | CLOSED_NOT_MATCH | ERROR

const SB_URL = 'https://nsmcaexdqbipusjuzfht.supabase.co';
const SB_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zbWNhZXhkcWJpcHVzanV6Zmh0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM3MzcxMzcsImV4cCI6MjA4OTMxMzEzN30.SNZmkdBscH23J29nTfwd3luKc5MYyPXnNkp2eNxFU1Y';
// STEP 0: service_role key REMOVED from the extension. The extension must never hold it.
// All privileged writes now go through edge functions authenticated with the anon key.
const EXT_VERSION = chrome.runtime.getManifest().version;

console.log('[OU] Background loaded — version', EXT_VERSION);

// ═══════════════════════════════════════════════════════════
// RADAR_BUILD — feed monitoring + enrich + operator panel run ONLY on the radar.
// INVARIANT: the Step 3 teammate-metrics build MUST ship with RADAR_BUILD = false
// (or strip this file's monitoring entirely). Never run the panel on teammate machines.
// ═══════════════════════════════════════════════════════════
const RADAR_BUILD = true;

// ═══════════════════════════════════════════════════════════
// CONFIG — single source of truth for pipeline behaviour
// ═══════════════════════════════════════════════════════════

const CONFIG = {
  version: '19.0.2',
  bufferMaxSize: 10,              // max candidates in live buffer
  bufferTtlMs: 5 * 60 * 1000,    // drop candidates older than 5 min in buffer
  maxJobAgeMin: 25,               // reject jobs already >25 min old at enqueue time
  maxActualAgeMin: 30,            // skip if posted_ago_min + time_in_buffer > 30 min (logged)
  tabTimeoutMs: 30 * 1000,        // hard timeout per job tab
  postLoadDelayMin: 1000,         // min delay after tab loads before inject
  postLoadDelayMax: 3000,         // max delay after tab loads before inject
};

// ═══════════════════════════════════════════════════════════
// MACHINE IDENTITY
// ═══════════════════════════════════════════════════════════

async function getMachineId() {
  const stored = await chrome.storage.local.get('machineId');
  if (stored.machineId) return stored.machineId;
  const newId = crypto.randomUUID();
  await chrome.storage.local.set({ machineId: newId });
  console.log('[OU] Generated machineId:', newId);
  return newId;
}

async function detectUpworkUser() {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://www.upwork.com/*', 'https://*.upwork.com/*'] });
    if (tabs.length === 0) return null;
    for (const tab of tabs) {
      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            try {
              // v18.0.7: current Upwork (Nuxt SSR) — the logged-in user cipher (~01xxxxxxxxxxxxxxxx)
              // is serialized into inline <script> state, readable from the isolated world.
              // Job uids start ~02, so anchoring on ~01 avoids grabbing a job id.
              for (const s of document.querySelectorAll('script')) {
                const txt = s.textContent || '';
                if (txt.length < 50) continue;
                const m = txt.match(/~01[0-9a-f]{14,18}/);
                if (m) return { uid: m[0], method: 'nuxt-cipher' };
              }
              if (window.USER_DATA?.cipherUid) return { uid: window.USER_DATA.cipherUid, method: 'window.USER_DATA' };
              if (window.USER?.cipher) return { uid: window.USER.cipher, method: 'window.USER' };
              const metaUid = document.querySelector('meta[name="user-id"], meta[name="cipher-uid"]')?.content;
              if (metaUid) return { uid: metaUid, method: 'meta' };
              const bodyUid = document.body?.dataset?.userId || document.body?.dataset?.cipherUid;
              if (bodyUid) return { uid: bodyUid, method: 'body-data' };
              const profileLink = document.querySelector('a[href*="/freelancers/~"]')?.href;
              const profMatch = profileLink?.match(/~[\w]+/);
              if (profMatch) return { uid: profMatch[0], method: 'profile-link' };
              const scripts = Array.from(document.querySelectorAll('script'));
              for (const s of scripts) {
                const m = s.textContent?.match(/"cipherUid":"(~[\w]+)"/);
                if (m) return { uid: m[1], method: 'script-json' };
              }
            } catch (e) { return { error: String(e) }; }
            return null;
          }
        });
        if (result?.result?.uid) {
          console.log('[OU] Detected upwork_user_id:', result.result.uid, 'via', result.result.method);
          return result.result.uid;
        }
      } catch (e) {}
    }
  } catch (e) { console.warn('[OU] detectUpworkUser error:', e); }
  return null;
}

async function identify() {
  const machineId = await getMachineId();
  const upworkUserId = await detectUpworkUser();
  const body = { machine_id: machineId, upwork_user_id: upworkUserId || null };
  try {
    const res = await fetch(`${SB_URL}/functions/v1/extension-config/identify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await res.json();
    await chrome.storage.local.set({ cachedIdentity: data, cachedIdentityAt: Date.now() });
    console.log('[OU] Identity:', data?.member?.slug || 'unknown');
    return data;
  } catch (e) { console.error('[OU] Identify failed:', e); return null; }
}

// ═══════════════════════════════════════════════════════════
// HEARTBEAT
// ═══════════════════════════════════════════════════════════

async function heartbeat() {
  const { cachedIdentity, machineId, jobsScrapedToday, messagesCapturedToday, lastScraperError }
    = await chrome.storage.local.get([
      'cachedIdentity', 'machineId', 'jobsScrapedToday', 'messagesCapturedToday', 'lastScraperError'
    ]);

  if (!machineId) { console.warn('[OU] heartbeat: no machineId'); return; }

  const body = {
    machine_id: machineId, version: EXT_VERSION,
    account_slug: cachedIdentity?.member?.slug || 'unknown',
    upwork_user_id: cachedIdentity?.member?.upwork_user_id || null,
    user_agent: navigator.userAgent.substring(0, 200),
    scraper_status: lastScraperError ? 'error' : 'active',
    scraper_error: lastScraperError || null,
    jobs_scraped_today: jobsScrapedToday || 0,
    messages_captured_today: messagesCapturedToday || 0
  };

  try {
    const res = await fetch(`${SB_URL}/functions/v1/extension-config/heartbeat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    // v19.2.3: log the actual HTTP status so a stale extension_status row can be
    // diagnosed as network-fail (throw → catch) vs server reject (non-2xx here).
    console.log(`[OU] Heartbeat → HTTP ${res.status} ${res.ok ? 'OK' : 'NON-OK'} (machine ${String(machineId).slice(0,8)} v${EXT_VERSION})`);

    if (body.scraper_error || lastScraperError) {
      await chrome.storage.local.remove('lastScraperError');
    }

    if (data.update_info?.update_available) {
      await chrome.storage.local.set({ pendingUpdate: data.update_info, pausedUntilUpdate: data.force_update });
      if (data.force_update) console.warn('[OU] FORCE UPDATE — scraper paused');
    } else {
      await chrome.storage.local.remove(['pendingUpdate', 'pausedUntilUpdate']);
    }
  } catch (e) {
    console.error('[OU] Heartbeat failed:', e);
    await chrome.storage.local.set({ lastScraperError: String(e).substring(0, 300) });
  }

  await identify();
  await maybeReloadUpworkTab();
  await processNextCandidate();
}

// ═══════════════════════════════════════════════════════════
// AUTO-RELOAD SCHEDULER
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// PEAK-WINDOW GATING (2B.1)
// peak_windows live in accounts.scrape_preset.peak_windows (radar account),
// returned inside cachedIdentity.scrape_preset by /identify.
// Shape: [ { start: "HH:MM", end: "HH:MM", timezone: "Europe/Berlin" }, ... ]
// ═══════════════════════════════════════════════════════════

function getPeakWindows(cachedIdentity) {
  const pw = cachedIdentity?.scrape_preset?.peak_windows;
  return Array.isArray(pw) ? pw : [];
}

// No windows configured → always-in-window (radar still runs once Start is pressed).
function isInPeakWindow(cachedIdentity) {
  const windows = getPeakWindows(cachedIdentity);
  if (windows.length === 0) return true;
  for (const w of windows) {
    try {
      const tz = w.timezone || cachedIdentity?.account?.timezone || 'Europe/Berlin';
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
      const nowMin = parseInt(parts.find(p => p.type === 'hour')?.value, 10) * 60 + parseInt(parts.find(p => p.type === 'minute')?.value, 10);
      const [sh, sm] = String(w.start || '00:00').split(':').map(n => parseInt(n, 10) || 0);
      const [eh, em] = String(w.end || '23:59').split(':').map(n => parseInt(n, 10) || 0);
      const startMin = sh * 60 + sm, endMin = eh * 60 + em;
      const inWin = startMin <= endMin ? (nowMin >= startMin && nowMin < endMin) : (nowMin >= startMin || nowMin < endMin);
      if (inWin) return true;
    } catch {}
  }
  return false;
}

async function isSearchTabFocused() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return !!(tab && /\/nx\/(search\/jobs|find-work)/.test(tab.url || ''));
  } catch { return false; }
}

// Single gate for all radar monitoring: Start ON + inside peak window + search tab focused.
async function radarMonitoringStatus() {
  if (!RADAR_BUILD) return { ok: false, reason: 'not_radar_build' };
  const { scrapingActive, pausedUntilUpdate, cachedIdentity } = await chrome.storage.local.get(['scrapingActive', 'pausedUntilUpdate', 'cachedIdentity']);
  if (pausedUntilUpdate) return { ok: false, reason: 'paused_for_update' };
  if (!scrapingActive) return { ok: false, reason: 'scan_off' };
  if (!isInPeakWindow(cachedIdentity)) return { ok: false, reason: 'outside_peak_window' };
  if (!(await isSearchTabFocused())) return { ok: false, reason: 'search_tab_not_focused' };
  return { ok: true };
}

const RELOAD_MIN_MS = 45000, RELOAD_MAX_MS = 90000;  // jittered reload interval

async function maybeReloadUpworkTab() {
  try {
    const status = await radarMonitoringStatus();
    if (!status.ok) { console.log(`[OU] reload skip: ${status.reason}`); return; }

    // Don't reload while the operator is interacting with the panel (viewing a card / clicking) —
    // a reload mid-interaction wipes the page ("blinks and won't open"). content.js sets this.
    const { operatorBusyUntil } = await chrome.storage.local.get('operatorBusyUntil');
    if (operatorBusyUntil && Date.now() < operatorBusyUntil) { console.log('[OU] reload skip: operator_busy'); return; }

    const { lastReloadAt, nextReloadGapMs } = await chrome.storage.local.get(['lastReloadAt', 'nextReloadGapMs']);
    const gap = nextReloadGapMs || RELOAD_MIN_MS;
    const sinceLast = lastReloadAt ? (Date.now() - lastReloadAt) : Infinity;
    if (sinceLast < gap) { console.log(`[OU] reload skip: ${Math.round(sinceLast / 1000)}s < ${Math.round(gap / 1000)}s gap`); return; }

    const { scrapingTabId } = await chrome.storage.local.get('scrapingTabId');
    let tab = null;
    if (scrapingTabId) {
      try {
        tab = await chrome.tabs.get(scrapingTabId);
        if (tab && !/\/nx\/(search\/jobs|find-work)/.test(tab.url || '')) { console.log('[OU] reload skip: scraping tab left search'); return; }
      } catch { tab = null; }
    }
    if (!tab) {
      const tabs = await chrome.tabs.query({ url: ['https://www.upwork.com/nx/search/jobs/*', 'https://www.upwork.com/nx/find-work/*'] });
      if (tabs.length === 0) { console.log('[OU] reload skip: no search tab'); return; }
      tab = tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    }

    console.log(`[OU] 🔄 Reloading tab ${tab.id}`);
    await chrome.tabs.reload(tab.id);
    const nextGap = RELOAD_MIN_MS + Math.floor(Math.random() * (RELOAD_MAX_MS - RELOAD_MIN_MS));  // 45–90s jitter
    await chrome.storage.local.set({ lastReloadAt: Date.now(), nextReloadGapMs: nextGap });
  } catch (e) { console.warn('[OU] maybeReloadUpworkTab error:', e); }
}

function normalizeJobUrl(url) {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    u.pathname = u.pathname.replace(/span-class-highlight-[^-\/]+-span-/gi, '');
    return u.toString();
  } catch { return url; }
}

// ═══════════════════════════════════════════════════════════
// PIPELINE — Stage 3: JobReviewer
// candidateBuffer (max 10, TTL 15min) → processNextCandidate() → reviewJob()
// ═══════════════════════════════════════════════════════════

let activeJobLock = false;  // one job tab at a time

async function getBuffer() {
  const { candidateBuffer } = await chrome.storage.local.get('candidateBuffer');
  return Array.isArray(candidateBuffer) ? candidateBuffer : [];
}

async function setBuffer(buf) {
  await chrome.storage.local.set({ candidateBuffer: buf.slice(0, CONFIG.bufferMaxSize) });
}

async function clearStaleBuffer() {
  const buf = await getBuffer();
  const now = Date.now();
  const fresh = buf.filter(item => (now - item.queued_at) < CONFIG.bufferTtlMs);
  if (fresh.length < buf.length) {
    const dropped = buf.length - fresh.length;
    console.log(`[OU] SKIPPED ${dropped} stale buffer items (TTL expired)`);
    await setBuffer(fresh);
  }
  return fresh;
}

async function addToBuffer(items) {
  await clearStaleBuffer();
  const buf = await getBuffer();
  const seen = new Set(buf.map(x => x.upwork_id));
  let added = 0;
  for (const it of items) {
    if (!it?.upwork_id || !it?.url) continue;
    if (seen.has(it.upwork_id)) { continue; }
    if (buf.length >= CONFIG.bufferMaxSize) {
      console.log(`[OU] SKIPPED ${it.upwork_id} — buffer full (${CONFIG.bufferMaxSize})`);
      continue;
    }
    // Reject jobs already too old at enqueue time — no point opening them
    if (typeof it.posted_ago_min === 'number' && it.posted_ago_min > CONFIG.maxJobAgeMin) {
      console.log(`[OU] SKIPPED ${it.upwork_id} — too_old at enqueue (${it.posted_ago_min}m > ${CONFIG.maxJobAgeMin}m)`);
      continue;
    }
    buf.push({
      upwork_id: it.upwork_id,
      url: normalizeJobUrl(it.url),
      title: (it.title || '').substring(0, 200),
      skills: (it.skills || []).slice(0, 10),
      posted_ago_min: typeof it.posted_ago_min === 'number' ? it.posted_ago_min : null,
      client_spent_rough: typeof it.client_spent_rough === 'number' ? it.client_spent_rough : null,
      matched_skills: Number(it.matched_skills) || 0,
      total_skills: Number(it.total_skills) || 0,
      queued_at: Date.now(),
    });
    seen.add(it.upwork_id);
    added++;
  }
  await setBuffer(buf);
  return added;
}

// Simple fire-and-forget event log — no circuit breaker
async function logEvent(status, details) {
  try {
    const { machineId, cachedIdentity } = await chrome.storage.local.get(['machineId', 'cachedIdentity']);
    fetch(`${SB_URL}/functions/v1/extension-job-enrich/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SB_ANON_KEY}` },
      body: JSON.stringify({
        machine_id: machineId,
        account_slug: cachedIdentity?.member?.slug,
        status,
        ...details,
      }),
    }).catch(() => {});
  } catch {}
}

// processNextCandidate — DISABLED under operator-gated AI (v19.6.1).
// Nothing auto-opens job tabs anymore. AI runs only when the operator opens a job page itself
// (content.js reads it in place → ANALYZE_FROM_PAGE). Keeping this a no-op kills the last
// auto-tab-opening path — the radar account never opens jobs by itself (bot-detection safety).
async function processNextCandidate() {
  return;
  /* legacy auto-enrich path below — intentionally unreachable */
  // eslint-disable-next-line no-unreachable
  if (activeJobLock) return;

  const { cachedIdentity, pausedUntilUpdate, scrapingActive } = await chrome.storage.local.get([
    'cachedIdentity', 'pausedUntilUpdate', 'scrapingActive'
  ]);
  if (pausedUntilUpdate) return;
  if (RADAR_BUILD) { if (!scrapingActive) return; }
  else if (!cachedIdentity?.member?.is_bidding_enabled) return;

  const buf = await clearStaleBuffer();
  if (buf.length === 0) return;

  const item = buf[0];
  const rest = buf.slice(1);
  await setBuffer(rest);

  activeJobLock = true;
  try {
    await reviewJob(item);
  } catch (e) {
    console.warn('[OU] ERROR reviewJob threw:', item.upwork_id, e?.message);
    logEvent('error', { upwork_job_id: item.upwork_id, error_type: 'exception', error_detail: String(e?.message || e) });
  } finally {
    activeJobLock = false;
    processNextCandidate().catch(() => {});  // immediate drain — no delay
  }
}

// reviewJob — Stage 3: open tab, inject enrich.js, send to pipeline
async function reviewJob(item) {
  const startedAt = Date.now();

  // Guard: skip if job aged past threshold while sitting in buffer
  const timeInBufferMin = (Date.now() - (item.queued_at ?? Date.now())) / 60000;
  const actualAgeMin = (item.posted_ago_min ?? 0) + timeInBufferMin;
  // forceAnalyze (operator pressed Analyze) bypasses the stale-age guard — they chose this job.
  if (!item.forceAnalyze && actualAgeMin > CONFIG.maxActualAgeMin) {
    console.log(`[OU] SKIPPED ${item.upwork_id} — stale in buffer (posted ${Math.round(item.posted_ago_min ?? 0)}m + ${Math.round(timeInBufferMin)}m wait = ${Math.round(actualAgeMin)}m)`);
    logEvent('failed', { upwork_job_id: item.upwork_id, error_type: 'too_old_in_buffer', error_detail: `actualAge=${Math.round(actualAgeMin)}m`, duration_ms: 0 });
    return;
  }

  console.log(`[OU] OPENED ${item.upwork_id} — "${item.title?.substring(0, 60)}" (age=${Math.round(actualAgeMin)}m)`);

  let tabId = null;
  let settled = false;

  const resultPromise = new Promise((resolve) => {
    const listener = (msg, sender) => {
      if (msg?.type !== 'ENRICH_RESULT') return;
      if (sender?.tab?.id && tabId && sender.tab.id !== tabId) return;
      if (settled) return;
      settled = true;
      chrome.runtime.onMessage.removeListener(listener);
      resolve(msg.payload);
    };
    chrome.runtime.onMessage.addListener(listener);

    setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.runtime.onMessage.removeListener(listener);
      resolve({ ok: false, error_type: 'tab_timeout', error_detail: 'Hard timeout', upwork_job_id: item.upwork_id, url: item.url });
    }, CONFIG.tabTimeoutMs);
  });

  try {
    const tab = await chrome.tabs.create({ url: item.url, active: false, pinned: false });
    tabId = tab.id;
  } catch (e) {
    console.log(`[OU] ERROR ${item.upwork_id} — tab_create_fail: ${e?.message}`);
    logEvent('error', { upwork_job_id: item.upwork_id, error_type: 'tab_create_fail', error_detail: String(e?.message || e), duration_ms: Date.now() - startedAt });
    return;
  }

  // Wait for page load (max 15s)
  await new Promise((resolve) => {
    const onUpdated = (id, changeInfo) => {
      if (id !== tabId) return;
      if (changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); }, 15000);
  });

  // 1-3s natural dwell before injection
  const readDelay = CONFIG.postLoadDelayMin + Math.floor(Math.random() * (CONFIG.postLoadDelayMax - CONFIG.postLoadDelayMin));
  await new Promise(r => setTimeout(r, readDelay));

  if (tabId) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['scripts/enrich.js'] });
    } catch (e) {
      console.warn('[OU] inject fail:', e?.message);
    }
  }

  const payload = await resultPromise;
  const duration_ms = Date.now() - startedAt;

  // Auth failure — log and bail (don't halt the whole pipeline)
  const authFailures = ['login_redirect', 'signup_redirect', 'challenge', 'bot_check'];
  if (payload && !payload.ok && authFailures.includes(payload.error_type)) {
    console.log(`[OU] ERROR ${item.upwork_id} — auth_failure: ${payload.error_type}`);
    logEvent('auth_failure', { upwork_job_id: item.upwork_id, error_type: payload.error_type, error_detail: payload.error_detail, duration_ms });
    if (tabId) { try { await chrome.tabs.remove(tabId); } catch {} }
    return;
  }

  if (payload?.ok && payload.description && payload.description.length >= 200) {
    // Radar: enrich the job → score_route (via extension-job-enrich, which writes the enriched
    // job to DB + returns the full score). Then push a card to the operator panel. Radar never bids.
    const { machineId, cachedIdentity } = await chrome.storage.local.get(['machineId', 'cachedIdentity']);
    let scoreData = null;
    try {
      const res = await fetch(`${SB_URL}/functions/v1/extension-job-enrich`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SB_ANON_KEY}` },
        body: JSON.stringify({
          machine_id: machineId,
          account_slug: cachedIdentity?.member?.slug,
          enrichment: payload,
          search_title: item.title || null,
          matched_skills: Number(item.matched_skills) || 0,
          total_skills: Number(item.total_skills) || 0,
        }),
      });
      const data = await res.json().catch(() => ({}));
      scoreData = data?.score || null;
      console.log(`[OU] SCORED ${item.upwork_id} — score=${scoreData?.match_score} decision=${scoreData?.decision} fit=${(scoreData?.account_fit||[]).length}`);
      logEvent('success', { upwork_job_id: item.upwork_id, description_chars: payload.description.length, duration_ms });
    } catch (e) {
      console.log(`[OU] ERROR ${item.upwork_id} — post_exception: ${e?.message}`);
      logEvent('post_failed', { upwork_job_id: item.upwork_id, error_type: 'post_exception', error_detail: String(e?.message || e), duration_ms });
    }

    // Radar never bids → always close the job tab. The panel lives on the search tab.
    if (tabId) { try { await chrome.tabs.remove(tabId); } catch {} }

    if (RADAR_BUILD && scoreData && scoreData.job_id) {
      await sendPanelCard({
        job_id: scoreData.job_id,
        upwork_id: item.upwork_id,
        title: item.title || payload.title || '',
        url: item.url,
        full_text: payload.description,        // pass the enriched text through (do NOT re-fetch truncated)
        match_score: scoreData.match_score ?? null,
        decision: scoreData.decision || null,
        breakdown: scoreData.breakdown || {},
        detected_tech_stack: scoreData.detected_tech_stack || [],
        account_fit: Array.isArray(scoreData.account_fit) ? scoreData.account_fit : [],
      });
      return scoreData;
    }
    return null;
  }

  // No usable description — close tab and log
  if (tabId) { try { await chrome.tabs.remove(tabId); } catch {} }
  const errType = payload?.error_type || (payload?.description ? 'description_too_short' : 'no_description');
  console.log(`[OU] CLOSED ${item.upwork_id} — ${errType} (desc=${payload?.description?.length || 0})`);
  logEvent('failed', { upwork_job_id: item.upwork_id, error_type: errType, error_detail: payload?.error_detail || 'No usable description', duration_ms });
}

// Push an enriched+scored job to the operator panel on the search tab (radar only).
async function sendPanelCard(card) {
  try {
    // Broadcast to ALL upwork tabs — the search-tab feed AND the job-detail tab the operator opened
    // both need the scored update (the detail panel lives on the job page now).
    const tabs = await chrome.tabs.query({ url: ['https://www.upwork.com/*'] });
    let sent = 0;
    for (const t of tabs) {
      if (!t.id) continue;
      try { await chrome.tabs.sendMessage(t.id, { type: 'PANEL_CARD', payload: card }); sent++; } catch {}
    }
    console.log(`[OU] PANEL_CARD → ${sent} tab(s) "${(card.title || '').substring(0, 40)}" score=${card.match_score} fit=[${(card.account_fit || []).map(f => f.account_slug + ':' + f.fit_score).join(',')}]`);
  } catch (e) { console.warn('[OU] sendPanelCard error:', e); }
}

// Operator opened the job page; content.js read the description IN PLACE and sent it here.
// We score WITHOUT opening any tab (no bot footprint). enrichment = ENRICH_RESULT shape from the page.
async function handleAnalyzeFromPage(payload) {
  const enrichment = payload?.enrichment;
  if (!enrichment?.description || enrichment.description.length < 200) return { ok: false, error: 'no description from page' };
  try {
    const { machineId, cachedIdentity } = await chrome.storage.local.get(['machineId', 'cachedIdentity']);
    const res = await fetch(`${SB_URL}/functions/v1/extension-job-enrich`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SB_ANON_KEY}` },
      body: JSON.stringify({
        machine_id: machineId,
        account_slug: cachedIdentity?.member?.slug,
        enrichment,
        search_title: enrichment.title || null,
        matched_skills: Number(payload.matched_skills) || 0,
        total_skills: Number(payload.total_skills) || 0,
      }),
    });
    const data = await res.json().catch(() => ({}));
    const scoreData = data?.score || null;
    if (!scoreData || !scoreData.job_id) return { ok: false, error: data?.error || 'no score' };
    await sendPanelCard({
      job_id: scoreData.job_id,
      upwork_id: payload.upwork_id || enrichment.upwork_job_id,
      title: enrichment.title || '',
      url: enrichment.url,
      full_text: enrichment.description,
      match_score: scoreData.match_score ?? null,
      decision: scoreData.decision || null,
      breakdown: scoreData.breakdown || {},
      detected_tech_stack: scoreData.detected_tech_stack || [],
      account_fit: Array.isArray(scoreData.account_fit) ? scoreData.account_fit : [],
    });
    return { ok: true, scored: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// Operator pressed "Отмена" → mark the job's proposal(s) cancelled in DB (TG already delivered).
async function handleCancelCover(payload) {
  const { job_id, account_slug } = payload || {};
  if (!job_id) return { ok: false, error: 'need job_id' };
  try {
    const res = await fetch(`${SB_URL}/functions/v1/leadgen-v2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SB_ANON_KEY}` },
      body: JSON.stringify({ mode: 'cancel_cover', job_id, account_slug: account_slug || null }),
    });
    const data = await res.json().catch(() => ({}));
    return data?.ok ? { ok: true } : { ok: false, error: data?.error || 'fail' };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
}

// Operator approved N accounts for a job → generate_cover per account → TG to each owner.
async function handleApproveCovers(payload) {
  const { job_id, full_text, accounts } = payload || {};
  if (!job_id || !Array.isArray(accounts) || accounts.length === 0) return { ok: false, error: 'need job_id + accounts[]' };
  const results = [];
  for (const account_slug of accounts) {
    try {
      const res = await fetch(`${SB_URL}/functions/v1/leadgen-v2`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SB_ANON_KEY}` },
        body: JSON.stringify({ mode: 'generate_cover', job_id, account_slug, full_text }),
      });
      const data = await res.json().catch(() => ({}));
      results.push({ account_slug, ok: !!data.ok, tg_sent: !!data.tg_sent, proposal_id: data.proposal_id || null, error: data.error || null });
      console.log(`[OU] COVER ${account_slug} job=${job_id} → ok=${!!data.ok} tg_sent=${!!data.tg_sent}`);
    } catch (e) {
      results.push({ account_slug, ok: false, tg_sent: false, error: String(e?.message || e) });
    }
  }
  return { ok: true, results };
}

// handleJobsCandidates — Stage 2 output / Stage 3 input
// Receives pre-matched batch from content.js, logs each as FOUND, adds to buffer
async function handleJobsCandidates(payload) {
  const jobs = payload?.jobs || [];
  if (jobs.length === 0) return { ok: true, added: 0 };

  const { cachedIdentity } = await chrome.storage.local.get('cachedIdentity');
  if (!cachedIdentity?.member?.is_bidding_enabled) return { skipped: 'bidding_disabled' };

  const blocked = cachedIdentity.account?.blocked_countries
               || cachedIdentity.member?.blocked_countries
               || [];
  const filtered = jobs.filter(j => !isBlockedCountry(j.client_country, blocked));
  const strippedBlocked = jobs.length - filtered.length;

  for (const j of filtered) {
    console.log(`[OU] FOUND ${j.upwork_id} — "${j.title?.substring(0, 60)}" (age=${j.posted_ago_min}m, skills=${j.matched_skills}/${j.total_skills})`);
  }

  const added = await addToBuffer(filtered.map(j => ({
    upwork_id: j.upwork_id,
    url: j.url,
    title: j.title,
    skills: j.skills,
    posted_ago_min: j.posted_ago_min ?? null,
    client_spent_rough: j.client_spent_rough ?? null,
    matched_skills: Number(j.matched_skills) || 0,
    total_skills: Number(j.total_skills) || 0,
  })));

  const buf = await getBuffer();
  console.log(`[OU] buffer: +${added} added, ${buf.length}/${CONFIG.bufferMaxSize} total`);

  processNextCandidate().catch(() => {});
  setTimeout(() => processNextCandidate().catch(() => {}), 3000);  // backup if lock was held

  return { ok: true, added, total_candidates: jobs.length, stripped_blocked: strippedBlocked };
}

// ═══════════════════════════════════════════════════════════
// DAILY RESET
// ═══════════════════════════════════════════════════════════

async function dailyReset() {
  const today = new Date().toDateString();
  const { countsDate } = await chrome.storage.local.get('countsDate');
  if (countsDate !== today) {
    await chrome.storage.local.set({ countsDate: today, jobsScrapedToday: 0, messagesCapturedToday: 0 });
    console.log('[OU] Daily counters reset');
  }
}

// ═══════════════════════════════════════════════════════════
// MESSAGE ROUTER
// ═══════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'INBOUND_MESSAGE') {
    handleInboundMessage(msg.payload).then(r => sendResponse(r)).catch(e => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg?.type === 'OUTBOUND_MESSAGE') {
    handleOutboundMessage(msg.payload).then(r => sendResponse(r)).catch(e => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg?.type === 'JOB_SCRAPED') {
    handleScrapedJob(msg.payload).then(r => sendResponse(r)).catch(e => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg?.type === 'JOB_SCRAPED_SKIP') {
    handleScrapedJobSkip(msg.payload).then(r => sendResponse(r)).catch(e => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg?.type === 'JOBS_CANDIDATES') {
    handleJobsCandidates(msg.payload).then(r => sendResponse(r)).catch(e => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg?.type === 'APPROVE_COVERS') {
    handleApproveCovers(msg.payload).then(r => sendResponse(r)).catch(e => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg?.type === 'ANALYZE_FROM_PAGE') {
    handleAnalyzeFromPage(msg.payload).then(r => sendResponse(r)).catch(e => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg?.type === 'CANCEL_COVER') {
    handleCancelCover(msg.payload).then(r => sendResponse(r)).catch(e => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg?.type === 'OPEN_JOB_TAB') {
    // content-script window.open is unreliable on Upwork (CSP/popup blocker); open via the SW tabs API.
    if (msg.url) chrome.tabs.create({ url: msg.url, active: true }).catch(e => console.warn('[OU] open tab:', e));
    sendResponse({ ok: !!msg.url });
    return true;
  }
  if (msg?.type === 'GET_IDENTITY') {
    chrome.storage.local.get(['cachedIdentity', 'machineId']).then(r => sendResponse(r));
    return true;
  }
  if (msg?.type === 'FORCE_IDENTIFY') {
    identify().then(r => sendResponse({ ok: true, identity: r }));
    return true;
  }
  if (msg?.type === 'START_SCRAPING') {
    startScraping(msg.payload || {}).then(r => sendResponse(r)).catch(e => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg?.type === 'STOP_SCRAPING') {
    stopScraping().then(r => sendResponse(r)).catch(e => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg?.type === 'UPDATE_PRESET') {
    updatePreset(msg.payload || {}).then(r => sendResponse(r)).catch(e => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg?.type === 'TOGGLE_BIDDING') {
    toggleBidding().then(r => sendResponse(r)).catch(e => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg?.type === 'GET_SCRAPING_STATE') {
    chrome.storage.local.get(['scrapingActive', 'scrapingTabId', 'cachedIdentity'])
      .then(r => {
        const inPeak = isInPeakWindow(r.cachedIdentity);
        sendResponse({
          active: !!r.scrapingActive,
          tabId: r.scrapingTabId || null,
          preset: r.cachedIdentity?.scrape_preset || { query: 'seo', sort: 'recency', hourly: null },
          radar_build: RADAR_BUILD,
          in_peak_window: inPeak,
          peak_windows: getPeakWindows(r.cachedIdentity),
          peak_status: inPeak ? 'in peak window' : 'outside peak window',
        });
      });
    return true;
  }
  if (msg?.type === 'PROFILE_SYNC_TRIGGER') {
    const tabId = sender?.tab?.id;
    handleProfileSyncTrigger(tabId)
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ error: String(e) }));
    return true;
  }
  // ENRICH_RESULT is handled via per-tab listener inside reviewJob
});

// ═══════════════════════════════════════════════════════════
// START/STOP SCRAPING + UPDATE PRESET + TOGGLE BIDDING
// ═══════════════════════════════════════════════════════════

function buildSearchUrl(preset) {
  const q = encodeURIComponent((preset?.query || 'seo').trim());
  const sort = preset?.sort === 'relevance' ? 'relevance' : 'recency';
  const params = [
    `q=${q}`,
    `sort=${sort}`,
    `from_recent_search=true`,
  ];
  if (preset?.hourly === true) params.push('t=0');
  if (preset?.hourly === false) params.push('t=1');
  return `https://www.upwork.com/nx/search/jobs/?${params.join('&')}`;
}

async function startScraping(opts) {
  const { cachedIdentity, scrapingTabId, machineId } = await chrome.storage.local.get([
    'cachedIdentity', 'scrapingTabId', 'machineId'
  ]);

  if (!cachedIdentity?.member?.is_bidding_enabled) {
    return { ok: false, error: 'Bidding disabled for this account' };
  }

  if (scrapingTabId) {
    try {
      const tab = await chrome.tabs.get(scrapingTabId);
      if (tab) {
        await chrome.tabs.update(scrapingTabId, { active: true });
        if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
        return { ok: true, reused: true, tabId: scrapingTabId };
      }
    } catch {}
  }

  const preset = opts.preset || cachedIdentity?.scrape_preset || { query: 'seo', sort: 'recency' };
  const url = buildSearchUrl(preset);
  console.log('[OU] ▶ START scraping at', url);

  const tab = await chrome.tabs.create({ url, active: true });
  await chrome.storage.local.set({
    scrapingActive: true,
    scrapingTabId: tab.id,
    scrapingStartedAt: Date.now(),
  });
  return { ok: true, tabId: tab.id, url };
}

async function stopScraping() {
  const { scrapingTabId } = await chrome.storage.local.get('scrapingTabId');
  if (scrapingTabId) {
    try { await chrome.tabs.remove(scrapingTabId); } catch {}
  }
  await chrome.storage.local.set({
    scrapingActive: false,
    scrapingTabId: null,
  });
  console.log('[OU] ⏸ STOP scraping');
  return { ok: true };
}

async function toggleBidding() {
  const { cachedIdentity } = await chrome.storage.local.get('cachedIdentity');
  const slug = cachedIdentity?.member?.slug;
  if (!slug) return { ok: false, error: 'account not identified' };

  const current = !!cachedIdentity?.member?.is_bidding_enabled;
  const next = !current;
  const { machineId } = await chrome.storage.local.get('machineId');

  try {
    // STEP 0: route through edge function with anon key (no service_role in extension).
    // Edge flips team_members.is_bidding_enabled (single source of truth).
    const res = await fetch(`${SB_URL}/functions/v1/extension-config/toggle-bidding`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SB_ANON_KEY}`,
      },
      body: JSON.stringify({ machine_id: machineId, slug, enabled: next }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}: ${txt.substring(0, 100)}` };
    }
    if (cachedIdentity?.member) {
      cachedIdentity.member.is_bidding_enabled = next;
      await chrome.storage.local.set({ cachedIdentity });
    }
    console.log(`[OU] Bidding toggled: ${slug} → ${next ? 'ON' : 'OFF'}`);
    return { ok: true, bidding_enabled: next };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function updatePreset(newPreset) {
  const { machineId, cachedIdentity } = await chrome.storage.local.get(['machineId', 'cachedIdentity']);
  if (!machineId) return { ok: false, error: 'no machine_id' };

  const sanitized = {
    query: String(newPreset.query || 'seo').substring(0, 100).trim() || 'seo',
    sort: newPreset.sort === 'relevance' ? 'relevance' : 'recency',
    hourly: newPreset.hourly === true ? true : newPreset.hourly === false ? false : null,
  };

  try {
    const res = await fetch(`${SB_URL}/functions/v1/extension-config/preset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machine_id: machineId, scrape_preset: sanitized }),
    });
    const data = await res.json();
    if (!data.ok) return { ok: false, error: data.error || 'preset save failed' };

    if (cachedIdentity) {
      cachedIdentity.scrape_preset = data.scrape_preset;
      await chrome.storage.local.set({ cachedIdentity });
    }
    return { ok: true, scrape_preset: data.scrape_preset };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { scrapingTabId } = await chrome.storage.local.get('scrapingTabId');
  if (scrapingTabId && scrapingTabId === tabId) {
    await chrome.storage.local.set({ scrapingActive: false, scrapingTabId: null });
    console.log('[OU] scraping tab closed by user → scrapingActive=false');
  }
});

// ═══════════════════════════════════════════════════════════
// INBOUND / OUTBOUND MESSAGE HANDLERS
// ═══════════════════════════════════════════════════════════

async function handleInboundMessage(payload) {
  const { cachedIdentity, machineId, pausedUntilUpdate } = await chrome.storage.local.get([
    'cachedIdentity', 'machineId', 'pausedUntilUpdate'
  ]);
  if (pausedUntilUpdate) return { skipped: 'paused_for_update' };
  if (!cachedIdentity?.member) return { skipped: 'no_identity' };

  const body = { ...payload, account_slug: cachedIdentity.member.slug, machine_id: machineId };
  try {
    const r = await fetch(`${SB_URL}/functions/v1/reply-generator`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await r.json();
    const today = new Date().toDateString();
    const stored = await chrome.storage.local.get(['messagesCapturedToday', 'countsDate']);
    const count = (stored.countsDate === today) ? (stored.messagesCapturedToday || 0) + 1 : 1;
    await chrome.storage.local.set({ messagesCapturedToday: count, countsDate: today });
    return { ok: true, data };
  } catch (e) { return { error: String(e) }; }
}

async function handleOutboundMessage(payload) {
  const { cachedIdentity, machineId } = await chrome.storage.local.get(['cachedIdentity', 'machineId']);
  if (!cachedIdentity?.member?.slug) return { skipped: 'no_identity' };

  const slug = cachedIdentity.member.slug;
  try {
    // STEP 0: route through edge function with anon key (no service_role in extension).
    // machine_id authenticates the caller server-side (validated against extension_status).
    // Edge resolves account from the machine + client_id, then inserts into messages_context.
    const res = await fetch(`${SB_URL}/functions/v1/extension-job-enrich/outbound`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SB_ANON_KEY}`,
      },
      body: JSON.stringify({
        machine_id: machineId,
        account_slug: slug,
        client_name: payload.client_name || '',
        text: payload.text || '',
        chat_url: payload.chat_url || null,
      }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      return { error: `outbound failed: HTTP ${res.status} ${err.substring(0, 100)}` };
    }
    return await res.json();
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

// ═══════════════════════════════════════════════════════════
// JOB SCRAPED HANDLERS (single-job flow from content.js)
// ═══════════════════════════════════════════════════════════

// In-memory debounce — collapse parallel JOB_SCRAPED events on the same upwork_id
const recentIngests = new Map();
const INGEST_DEDUP_MS = 10 * 60 * 1000;
function shouldSkipDuplicateIngest(upworkId) {
  if (!upworkId) return false;
  const now = Date.now();
  if (recentIngests.size > 500) {
    for (const [k, ts] of recentIngests.entries()) {
      if (now - ts > INGEST_DEDUP_MS) recentIngests.delete(k);
    }
  }
  const prev = recentIngests.get(upworkId);
  if (prev && now - prev < INGEST_DEDUP_MS) return true;
  recentIngests.set(upworkId, now);
  return false;
}

function isBlockedCountry(jobCountry, blockedList) {
  if (!jobCountry || !Array.isArray(blockedList) || blockedList.length === 0) return false;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '').trim();
  const j = norm(jobCountry);
  if (j.length < 2) return false;
  for (const bc of blockedList) {
    const b = norm(bc);
    if (!b || b.length < 2) continue;
    if (j === b) return true;
    if (j.length >= 3 && b.length >= 3 && (j.includes(b) || b.includes(j))) return true;
  }
  return false;
}

async function handleScrapedJobSkip(payload) {
  const { cachedIdentity, machineId, pausedUntilUpdate } = await chrome.storage.local.get([
    'cachedIdentity', 'machineId', 'pausedUntilUpdate'
  ]);
  if (pausedUntilUpdate) return { skipped: 'paused_for_update' };
  if (!cachedIdentity?.member?.is_bidding_enabled) return { skipped: 'bidding_disabled' };

  const reason = payload.prematch_reason || 'unknown';
  console.log(`[OU] SKIPPED ${payload.upwork_id} — prematch: ${reason}`);

  const body = {
    account_slug: cachedIdentity.member.slug,
    machine_id: machineId,
    job: {
      upwork_id: payload.upwork_id,
      title: payload.title,
      url: payload.url,
      description: payload.description || '',
      budget_type: payload.budget_type,
      budget_min: payload.budget_min,
      budget_max: payload.budget_max,
      client_country: payload.client_country,
      client_rating: payload.client_rating,
      skills: payload.skills || [],
    },
    ingest_only: true,
    prematch_reason: reason,
    prematch_score: payload.prematch_score ?? 0,
    matched_skills: Number(payload.matched_skills) || 0,
    total_skills: Number(payload.total_skills) || 0,
  };

  fetch(`${SB_URL}/functions/v1/leadgen-v2`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SB_ANON_KEY}` }, body: JSON.stringify(body)
  }).catch(() => {});

  const today = new Date().toDateString();
  const stored = await chrome.storage.local.get(['jobsScrapedToday', 'countsDate']);
  const count = (stored.countsDate === today) ? (stored.jobsScrapedToday || 0) + 1 : 1;
  await chrome.storage.local.set({ jobsScrapedToday: count, countsDate: today });

  return { ok: true, skipped_reason: reason, upwork_id: payload.upwork_id };
}

async function handleScrapedJob(payload) {
  const { cachedIdentity, machineId, pausedUntilUpdate } = await chrome.storage.local.get([
    'cachedIdentity', 'machineId', 'pausedUntilUpdate'
  ]);
  if (pausedUntilUpdate) return { skipped: 'paused_for_update' };
  if (!cachedIdentity?.member?.is_bidding_enabled) return { skipped: 'bidding_disabled' };

  if (shouldSkipDuplicateIngest(payload?.upwork_id)) {
    return { skipped: 'debounce', upwork_id: payload?.upwork_id };
  }

  const blocked = cachedIdentity.account?.blocked_countries
               || cachedIdentity.member?.blocked_countries
               || [];
  const countryBlocked = isBlockedCountry(payload.client_country, blocked);

  const body = {
    account_slug: cachedIdentity.member.slug,
    machine_id: machineId,
    job: payload,
    ingest_only: true,
    matched_skills: Number(payload.matched_skills) || 0,
    total_skills: Number(payload.total_skills) || 0,
  };
  if (countryBlocked) {
    body.prematch_reason = 'country';
    body.prematch_score = 0;
  }

  fetch(`${SB_URL}/functions/v1/leadgen-v2`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SB_ANON_KEY}` }, body: JSON.stringify(body)
  }).catch(() => {});

  const today = new Date().toDateString();
  const stored = await chrome.storage.local.get(['jobsScrapedToday', 'countsDate']);
  const count = (stored.countsDate === today) ? (stored.jobsScrapedToday || 0) + 1 : 1;
  await chrome.storage.local.set({ jobsScrapedToday: count, countsDate: today });

  return { ok: true, queued: payload.upwork_id || payload.url, prematch_skip: countryBlocked };
}

// ═══════════════════════════════════════════════════════════
// PROFILE SYNC WORKER (2x/day, background tab)
// ═══════════════════════════════════════════════════════════

const PROFILE_SYNC_PAGES = [
  { slug: 'notifications',    url: 'https://www.upwork.com/ab/notifications/' },
  { slug: 'my-stats',         url: 'https://www.upwork.com/nx/my-stats/' },
  { slug: 'proposals',        url: 'https://www.upwork.com/nx/proposals/' },
  { slug: 'connects-history', url: 'https://www.upwork.com/nx/plans/connects/history/' },
];
const PROFILE_SYNC_PAGE_TIMEOUT_MS = 45000;
const PROFILE_SYNC_READ_MS_MIN = 4000;
const PROFILE_SYNC_READ_MS_MAX = 9000;
const PROFILE_SYNC_JITTER_MS_MIN = 15000;
const PROFILE_SYNC_JITTER_MS_MAX = 30000;
const PROFILE_SYNC_WINDOWS = [
  { start_hour: 7,  start_min: 40, span_min: 40 },
  { start_hour: 18, start_min: 40, span_min: 40 },
];

function randBetween(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

async function shouldRunProfileSyncNow() {
  const { pausedUntilUpdate, scrapingActive, profileSyncLastRunAt, profileSyncNextSlotAt } =
    await chrome.storage.local.get([
      'pausedUntilUpdate', 'scrapingActive', 'profileSyncLastRunAt', 'profileSyncNextSlotAt'
    ]);

  if (pausedUntilUpdate) return { run: false, reason: 'paused_for_update' };

  if (profileSyncLastRunAt && (Date.now() - profileSyncLastRunAt) < 5 * 3600 * 1000) {
    return { run: false, reason: 'too_soon_since_last' };
  }

  if (profileSyncNextSlotAt && Date.now() < profileSyncNextSlotAt) {
    return { run: false, reason: 'waiting_for_slot', next_at: profileSyncNextSlotAt };
  }

  const nowBerlinH = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin', hour: '2-digit', hour12: false
  }).format(new Date()));
  const nowBerlinM = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin', minute: '2-digit'
  }).format(new Date()));
  const nowMinOfDay = nowBerlinH * 60 + nowBerlinM;

  for (const w of PROFILE_SYNC_WINDOWS) {
    const start = w.start_hour * 60 + w.start_min;
    const end = start + w.span_min;
    if (nowMinOfDay >= start && nowMinOfDay < end) {
      return { run: true, window: w, minute_of_day: nowMinOfDay };
    }
  }

  return { run: false, reason: 'outside_window', minute_of_day: nowMinOfDay };
}

async function handleProfileSyncTrigger(tabId) {
  if (!tabId) return { ok: false, reason: 'no_tab' };

  const { cachedIdentity, pausedUntilUpdate } = await chrome.storage.local.get([
    'cachedIdentity', 'pausedUntilUpdate'
  ]);
  if (pausedUntilUpdate) return { ok: false, reason: 'paused_for_update' };
  const accountSlug = cachedIdentity?.member?.slug;
  if (!accountSlug) return { ok: false, reason: 'no_account_slug' };

  try {
    const [already] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => sessionStorage.getItem('ou_profile_sync_active'),
    });
    if (already?.result === '1') return { ok: false, reason: 'already_injected' };
  } catch {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (slug) => {
        try {
          document.body.dataset.ouAccountSlug = slug;
          sessionStorage.setItem('ou_account_slug', slug);
        } catch {}
      },
      args: [accountSlug],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['scripts/profile-sync.js'],
    });
    return { ok: true, injected: true, account_slug: accountSlug };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function runProfileSyncOnce(tabId, page, accountSlug) {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      chrome.runtime.onMessage.removeListener(listener);
      resolve(payload);
    };

    const listener = (msg, sender) => {
      if (sender?.tab?.id !== tabId) return;
      if (msg?.type !== 'PROFILE_SYNC_RESULT') return;
      finish(msg.payload || { ok: false, error_type: 'empty_result' });
    };
    chrome.runtime.onMessage.addListener(listener);

    const timer = setTimeout(() => finish({ ok: false, error_type: 'tab_timeout', page: page.slug }), PROFILE_SYNC_PAGE_TIMEOUT_MS);

    (async () => {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (slug) => { try { document.body.dataset.ouAccountSlug = slug; sessionStorage.setItem('ou_account_slug', slug); } catch {} },
          args: [accountSlug],
        });
        await new Promise(r => setTimeout(r, randBetween(PROFILE_SYNC_READ_MS_MIN, PROFILE_SYNC_READ_MS_MAX)));
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['scripts/profile-sync.js'],
        });
      } catch (e) {
        clearTimeout(timer);
        finish({ ok: false, error_type: 'inject_failed', error_detail: String(e?.message || e), page: page.slug });
      }
    })();
  });
}

async function runProfileSyncAllPages() {
  const startedAt = Date.now();
  const { cachedIdentity } = await chrome.storage.local.get('cachedIdentity');
  const accountSlug = cachedIdentity?.member?.slug;
  if (!accountSlug) {
    console.log('[OU profile-sync] no account slug cached, skip');
    return { ok: false, reason: 'no_account' };
  }

  const { profileSyncRunning } = await chrome.storage.local.get('profileSyncRunning');
  if (profileSyncRunning) return { ok: false, reason: 'already_running' };
  await chrome.storage.local.set({ profileSyncRunning: true });

  const results = [];
  try {
    for (let i = 0; i < PROFILE_SYNC_PAGES.length; i++) {
      const page = PROFILE_SYNC_PAGES[i];
      console.log(`[OU profile-sync] → ${page.slug}`);

      let tab;
      try {
        tab = await chrome.tabs.create({ url: page.url, active: false });
      } catch (e) {
        results.push({ page: page.slug, ok: false, error: 'tab_create_failed' });
        continue;
      }

      await new Promise((resolve) => {
        const onUpdated = (updatedId, info) => {
          if (updatedId === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(onUpdated);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(onUpdated);
        setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); }, 15000);
      });

      const r = await runProfileSyncOnce(tab.id, page, accountSlug);
      results.push({ page: page.slug, ...r });

      try { await chrome.tabs.remove(tab.id); } catch {}

      if (i < PROFILE_SYNC_PAGES.length - 1) {
        await new Promise(r => setTimeout(r, randBetween(PROFILE_SYNC_JITTER_MS_MIN, PROFILE_SYNC_JITTER_MS_MAX)));
      }
    }
  } finally {
    await chrome.storage.local.set({
      profileSyncRunning: false,
      profileSyncLastRunAt: Date.now(),
      profileSyncLastResults: results,
      profileSyncLastDurationMs: Date.now() - startedAt,
    });
  }

  console.log('[OU profile-sync] done', results.map(r => `${r.page}:${r.ok ? 'ok' : r.error_type || r.error || 'fail'}`).join(' | '));
  return { ok: true, results };
}

async function maybeRunProfileSync() {
  const check = await shouldRunProfileSyncNow();
  if (!check.run) { return; }
  console.log('[OU profile-sync] window hit, starting', check.window);
  await runProfileSyncAllPages();
}

// ═══════════════════════════════════════════════════════════
// SEARCH QUERY ROTATION (default OFF, opt-in)
// ═══════════════════════════════════════════════════════════

const SEARCH_ROTATION = ['seo', 'Technical SEO', 'SEO audit', 'Shopify SEO', 'On-Page SEO'];
const SEARCH_ROTATION_MIN_GAP_MIN = 55;
const SEARCH_USER_IDLE_MIN = 10;

async function maybeRotateSearch() {
  try {
    const { pausedUntilUpdate, searchRotationLastAt, searchRotationIndex,
            searchRotationEnabled } = await chrome.storage.local.get([
      'pausedUntilUpdate', 'searchRotationLastAt', 'searchRotationIndex',
      'searchRotationEnabled'
    ]);

    // DEFAULT OFF. Enable: chrome.storage.local.set({searchRotationEnabled: true})
    if (searchRotationEnabled !== true) return;
    if (pausedUntilUpdate) return;

    const nowMs = Date.now();
    if (searchRotationLastAt && (nowMs - searchRotationLastAt) < SEARCH_ROTATION_MIN_GAP_MIN * 60000) return;

    const tabs = await chrome.tabs.query({ url: 'https://www.upwork.com/nx/search/jobs/*' });
    if (tabs.length === 0) return;
    const tab = tabs[0];

    if (tab.lastAccessed && (nowMs - tab.lastAccessed) < SEARCH_USER_IDLE_MIN * 60000) {
      console.log('[OU search-rotate] user active in tab, skip cycle');
      return;
    }

    const idx = typeof searchRotationIndex === 'number' ? searchRotationIndex : 0;
    const nextIdx = (idx + 1) % SEARCH_ROTATION.length;
    const nextQuery = SEARCH_ROTATION[nextIdx];

    const newUrl = 'https://www.upwork.com/nx/search/jobs/?q=' + encodeURIComponent(nextQuery) + '&sort=recency';
    await chrome.tabs.update(tab.id, { url: newUrl });

    await chrome.storage.local.set({
      searchRotationIndex: nextIdx,
      searchRotationLastAt: nowMs,
      searchRotationLastQuery: nextQuery,
    });

    console.log('[OU search-rotate] ' + SEARCH_ROTATION[idx] + ' -> ' + nextQuery);
  } catch (e) {
    console.warn('[OU search-rotate] error:', e?.message);
  }
}

// ═══════════════════════════════════════════════════════════
// ALARMS
// ═══════════════════════════════════════════════════════════

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[OU] Installed — setting up alarms, reason=', details?.reason);
  await chrome.alarms.clearAll();
  chrome.alarms.create('heartbeat', { periodInMinutes: 2 });
  chrome.alarms.create('daily-reset', { periodInMinutes: 60 });
  chrome.alarms.create('enrich-drain', { periodInMinutes: 1 });
  chrome.alarms.create('profile-sync-check', { periodInMinutes: 10 });
  chrome.alarms.create('search-rotate', { periodInMinutes: 15 });

  // Clear stale buffer on install/update
  if (details?.reason === 'update' || details?.reason === 'install') {
    const { candidateBuffer, enrichQueue } = await chrome.storage.local.get(['candidateBuffer', 'enrichQueue']);
    if ((Array.isArray(candidateBuffer) && candidateBuffer.length > 0) ||
        (Array.isArray(enrichQueue) && enrichQueue.length > 0)) {
      console.log('[OU upgrade] clearing stale buffers');
      await chrome.storage.local.set({ candidateBuffer: [], enrichQueue: [] });
    }
  }

  await identify();
  await dailyReset();
  await heartbeat();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[OU] Startup');
  await chrome.alarms.clearAll();
  chrome.alarms.create('heartbeat', { periodInMinutes: 2 });
  chrome.alarms.create('daily-reset', { periodInMinutes: 60 });
  chrome.alarms.create('enrich-drain', { periodInMinutes: 1 });
  chrome.alarms.create('profile-sync-check', { periodInMinutes: 10 });
  chrome.alarms.create('search-rotate', { periodInMinutes: 15 });
  await identify();
  await dailyReset();
  await heartbeat();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'heartbeat') await heartbeat();
  if (alarm.name === 'daily-reset') await dailyReset();
  if (alarm.name === 'enrich-drain') await processNextCandidate();
  if (alarm.name === 'profile-sync-check') await maybeRunProfileSync();
  if (alarm.name === 'search-rotate') await maybeRotateSearch();
});

(async () => {
  await getMachineId();
  const stored = await chrome.storage.local.get('cachedIdentityAt');
  const needsIdentify = !stored.cachedIdentityAt || (Date.now() - stored.cachedIdentityAt > 30 * 60 * 1000);
  if (needsIdentify) await identify();
  await heartbeat();
})();
