// OptimizeUp Extension v19.0.1 — Background Service Worker
// v19.0.1: Fix stale-job guard — skip jobs where actualAge (posted + time in buffer) > 30 min (logged, not silent).
//   Also addToBuffer() rejects items already >25 min old at enqueue time.
// v19.0.0: Fast Manual Triage Mode — 4 independent pipeline stages.
//   JobWatcher (content.js) → PreMatcher (content.js prematchDecide) → JobReviewer (reviewJob) → CoverGenerator (leadgen-v2)
//   Removed: hourly caps, 30s-5min delays, dual in-flight flags, enrichLogCircuit, prerank top-10, ENRICH_MAX_QUEUE=50
//   Added: CONFIG, activeJobLock, candidateBuffer (max 10, TTL 15min), processNextCandidate(), reviewJob()
//   Explicit log tags: FOUND | SKIPPED | OPENED | MATCHED | CLOSED_NOT_MATCH | ERROR

const SB_URL = 'https://nsmcaexdqbipusjuzfht.supabase.co';
const SB_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zbWNhZXhkcWJpcHVzanV6Zmh0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM3MzcxMzcsImV4cCI6MjA4OTMxMzEzN30.SNZmkdBscH23J29nTfwd3luKc5MYyPXnNkp2eNxFU1Y';
// service_role key — SW context only, not accessible to web pages
const SB_SVC_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5zbWNhZXhkcWJpcHVzanV6Zmh0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzczNzEzNywiZXhwIjoyMDg5MzEzMTM3fQ.8cziy072fTbGRO9A26PdHi5XOqonPJifCNyA1EeBhTo';
const EXT_VERSION = chrome.runtime.getManifest().version;

console.log('[OU] Background loaded — version', EXT_VERSION);

// ═══════════════════════════════════════════════════════════
// CONFIG — single source of truth for pipeline behaviour
// ═══════════════════════════════════════════════════════════

const CONFIG = {
  version: '19.0.1',
  bufferMaxSize: 10,              // max candidates in live buffer
  bufferTtlMs: 15 * 60 * 1000,   // drop candidates older than 15 min in buffer
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
    const data = await res.json();
    console.log('[OU] Heartbeat OK');

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

async function maybeReloadUpworkTab() {
  try {
    const { cachedIdentity, lastReloadAt, pausedUntilUpdate } = await chrome.storage.local.get([
      'cachedIdentity', 'lastReloadAt', 'pausedUntilUpdate'
    ]);

    if (!cachedIdentity?.member?.is_bidding_enabled) return;
    if (pausedUntilUpdate) { console.log('[OU] reload skip: paused for update'); return; }

    const settings = cachedIdentity?.scrape_settings;
    if (!settings || !settings.enabled) { console.log('[OU] reload skip: scraper disabled'); return; }
    if (settings.pattern_mode === 'paused') { console.log('[OU] reload skip: pattern_mode=paused'); return; }
    if (isInQuietHours(cachedIdentity)) { console.log('[OU] reload skip: quiet hours (account TZ)'); return; }

    const minSec = getSmartIntervalSec();
    const maxSec = Math.max(settings.max_interval_sec || 2700, minSec + 60);

    const sinceLastReload = lastReloadAt ? (Date.now() - lastReloadAt) / 1000 : Infinity;
    if (sinceLastReload < minSec) {
      console.log(`[OU] reload skip: last reload ${Math.round(sinceLastReload)}s ago, min ${minSec}s`);
      return;
    }

    if (settings.next_scrape_at) {
      const nextAt = new Date(settings.next_scrape_at).getTime();
      if (Date.now() < nextAt) {
        const waitSec = Math.round((nextAt - Date.now()) / 1000);
        console.log(`[OU] reload wait: server says next scrape in ${waitSec}s`);
        return;
      }
    }

    const { scrapingTabId } = await chrome.storage.local.get('scrapingTabId');
    let tab = null;
    if (scrapingTabId) {
      try {
        tab = await chrome.tabs.get(scrapingTabId);
        if (tab && !/\/nx\/(search\/jobs|find-work)/.test(tab.url || '')) {
          console.log('[OU] reload skip: scraping tab is no longer on search page');
          return;
        }
      } catch { tab = null; }
    }

    if (!tab) {
      const tabs = await chrome.tabs.query({
        url: ['https://www.upwork.com/nx/search/jobs/*', 'https://www.upwork.com/nx/find-work/*']
      });
      if (tabs.length === 0) { console.log('[OU] reload skip: no Upwork job-search tab open'); return; }
      tab = tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    }
    const jitterMs = Math.floor((Math.random() - 0.5) * 60 * 1000);
    const delayMs = Math.max(0, jitterMs);

    console.log(`[OU] ⏰ Scheduling reload of tab ${tab.id} in ${Math.round(delayMs/1000)}s`);
    setTimeout(async () => {
      try {
        await chrome.tabs.reload(tab.id);
        await chrome.storage.local.set({ lastReloadAt: Date.now() });
        console.log('[OU] 🔄 Reloaded tab', tab.id, tab.url);
      } catch (e) { console.warn('[OU] reload failed:', e); }
    }, delayMs);

  } catch (e) { console.warn('[OU] maybeReloadUpworkTab error:', e); }
}

function isInQuietHours(cachedIdentity) {
  try {
    const tz = cachedIdentity?.account?.timezone
            || cachedIdentity?.scrape_settings?.timezone
            || 'UTC';
    const qStart = cachedIdentity?.scrape_settings?.quiet_hours_start ?? 22;
    const qEnd   = cachedIdentity?.scrape_settings?.quiet_hours_end   ?? 7;

    const hourStr = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, hour: '2-digit'
    }).format(new Date());
    const hour = parseInt(hourStr, 10);
    if (isNaN(hour)) return false;

    if (qStart <= qEnd) {
      return hour >= qStart && hour < qEnd;
    }
    return hour >= qStart || hour < qEnd;
  } catch {
    return false;
  }
}

function getSmartIntervalSec() {
  try {
    const h = parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Berlin', hour12: false, hour: '2-digit'
    }).format(new Date()), 10);
    if (isNaN(h)) return 120;
    return (h >= 9 && h < 23) ? 60 : 270;
  } catch { return 120; }
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        machine_id: machineId,
        account_slug: cachedIdentity?.member?.slug,
        status,
        ...details,
      }),
    }).catch(() => {});
  } catch {}
}

// processNextCandidate — pull one item from buffer and review it
async function processNextCandidate() {
  if (activeJobLock) return;

  const { cachedIdentity, pausedUntilUpdate } = await chrome.storage.local.get([
    'cachedIdentity', 'pausedUntilUpdate'
  ]);
  if (pausedUntilUpdate) return;
  if (!cachedIdentity?.member?.is_bidding_enabled) return;
  if (cachedIdentity?.scrape_settings?.pattern_mode === 'paused') return;
  if (isInQuietHours(cachedIdentity)) return;

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
  }

  // Check for next item immediately — no artificial inter-job delay
  setTimeout(() => processNextCandidate().catch(() => {}), 1000);
}

// reviewJob — Stage 3: open tab, inject enrich.js, send to pipeline
async function reviewJob(item) {
  const startedAt = Date.now();

  // Guard: skip if job aged past threshold while sitting in buffer
  const timeInBufferMin = (Date.now() - (item.queued_at ?? Date.now())) / 60000;
  const actualAgeMin = (item.posted_ago_min ?? 0) + timeInBufferMin;
  if (actualAgeMin > CONFIG.maxActualAgeMin) {
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
    // Stage 4: CoverGenerator — send to extension-job-enrich → leadgen-v2 (async, doesn't block scraping)
    const { machineId, cachedIdentity } = await chrome.storage.local.get(['machineId', 'cachedIdentity']);
    try {
      const res = await fetch(`${SB_URL}/functions/v1/extension-job-enrich`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

      const mySlug = cachedIdentity?.member?.slug;
      const biddingAccounts = data?.bidding_accounts;
      const shouldBid = Array.isArray(biddingAccounts) && mySlug && biddingAccounts.includes(mySlug);

      if (shouldBid) {
        console.log(`[OU] MATCHED ${item.upwork_id} — keeping tab open for ${mySlug}`);
        logEvent('success', { upwork_job_id: item.upwork_id, description_chars: payload.description.length, duration_ms });
      } else {
        console.log(`[OU] CLOSED_NOT_MATCH ${item.upwork_id} — ${mySlug} not in [${(biddingAccounts || []).join(',') || 'none'}]`);
        if (tabId) { try { await chrome.tabs.remove(tabId); } catch {} }
        logEvent('success', { upwork_job_id: item.upwork_id, description_chars: payload.description.length, duration_ms });
      }
    } catch (e) {
      console.log(`[OU] ERROR ${item.upwork_id} — post_exception: ${e?.message}`);
      if (tabId) { try { await chrome.tabs.remove(tabId); } catch {} }
      logEvent('post_failed', { upwork_job_id: item.upwork_id, error_type: 'post_exception', error_detail: String(e?.message || e), duration_ms });
    }
    return;
  }

  // No usable description — close tab and log
  if (tabId) { try { await chrome.tabs.remove(tabId); } catch {} }
  const errType = payload?.error_type || (payload?.description ? 'description_too_short' : 'no_description');
  console.log(`[OU] CLOSED_NOT_MATCH ${item.upwork_id} — ${errType} (desc=${payload?.description?.length || 0})`);
  logEvent('failed', { upwork_job_id: item.upwork_id, error_type: errType, error_detail: payload?.error_detail || 'No usable description', duration_ms });
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
      .then(r => sendResponse({
        active: !!r.scrapingActive,
        tabId: r.scrapingTabId || null,
        preset: r.cachedIdentity?.scrape_preset || { query: 'seo', sort: 'recency', hourly: null }
      }));
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

  try {
    // PATCH team_members (slug=davyd) — accounts table has slug "david", different table
    const res = await fetch(
      `${SB_URL}/rest/v1/team_members?slug=eq.${encodeURIComponent(slug)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SB_SVC_KEY,
          'Authorization': `Bearer ${SB_SVC_KEY}`,
          'Content-Profile': 'upwork',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ is_bidding_enabled: next }),
      }
    );
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
  const { cachedIdentity } = await chrome.storage.local.get(['cachedIdentity']);
  if (!cachedIdentity?.member?.slug) return { skipped: 'no_identity' };

  const slug = cachedIdentity.member.slug;
  const sbH = {
    'apikey': SB_SVC_KEY,
    'Authorization': `Bearer ${SB_SVC_KEY}`,
    'Accept-Profile': 'upwork',
    'Content-Profile': 'upwork',
    'Content-Type': 'application/json',
  };

  const accRes = await fetch(`${SB_URL}/rest/v1/accounts?select=id&slug=eq.${encodeURIComponent(slug)}&limit=1`, { headers: sbH });
  const accData = await accRes.json();
  const accountId = accData?.[0]?.id;
  if (!accountId) return { skipped: 'no_account', slug };

  const nameQ = encodeURIComponent(payload.client_name || '');
  const clientRes = await fetch(`${SB_URL}/rest/v1/clients?select=id&name=ilike.${nameQ}&limit=1`, { headers: sbH });
  const clientData = await clientRes.json();
  const clientId = clientData?.[0]?.id;
  if (!clientId) return { skipped: 'client_not_found', name: payload.client_name };

  const insertRes = await fetch(`${SB_URL}/rest/v1/messages_context`, {
    method: 'POST',
    headers: { ...sbH, 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      client_id: clientId,
      account_id: accountId,
      message_direction: 'outbound',
      raw_text: payload.text,
      summary: payload.text?.substring(0, 300) || '',
      story_id: payload.story_id || null,
    }),
  });

  if (!insertRes.ok) {
    const err = await insertRes.text();
    return { error: `insert failed: ${err}` };
  }
  return { ok: true, saved: 'outbound', client: payload.client_name };
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
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
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
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
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
