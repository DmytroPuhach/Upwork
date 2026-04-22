// OptimizeUp Extension v17.1.0 — Background Service Worker
// v17.1.0: Job enrichment worker — opens top candidates in background tabs,
// extracts full description + client stats via injected enrich.js,
// enforces human-like timing, hourly caps, and halts on login-redirect.

const SB_URL = 'https://nsmcaexdqbipusjuzfht.supabase.co';
const EXT_VERSION = chrome.runtime.getManifest().version;

console.log('[OU] Background loaded — version', EXT_VERSION);

// ═══════════════════════════════════════════════════════════
// ENRICHMENT CONSTANTS — tuned for anti-ban
// ═══════════════════════════════════════════════════════════

const ENRICH_MAX_QUEUE = 50;                  // cap in-memory queue size
const ENRICH_MAX_PER_HOUR = 5;                // hard rate cap
const ENRICH_DELAY_WEIGHTS = [                // (weight, minMs, maxMs)
  [0.40, 30000, 45000],    // 30-45s
  [0.40, 45000, 75000],    // 45-75s
  [0.20, 75000, 120000],   // 75-120s
];
const ENRICH_TAB_TIMEOUT_MS = 60000;          // force-close if stuck
const ENRICH_MIN_INITIAL_WAIT_MS = 2500;      // after tab onUpdated complete
const ENRICH_AUTH_HALT_MINUTES = 60;          // after auth_failure, halt this long

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

    // v17.1.0 Fix A: clear stale error once server confirms success.
    // Without this, a single transient fetch failure leaves a permanent
    // lastScraperError that the server keeps alerting on forever.
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
    // v17.1.0 Fix A: only persist transient network errors; don't spam
    // the server with them (server-side dedup is also added in extension-config).
    await chrome.storage.local.set({ lastScraperError: String(e).substring(0, 300) });
  }

  await identify();
  await maybeReloadUpworkTab();
  await maybeProcessEnrichQueue();
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

    const minSec = Math.max(settings.min_interval_sec || 180, 120);
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

    // v17.1.0: prefer the tracked scraping tab if Start Scraping was used
    const { scrapingTabId } = await chrome.storage.local.get('scrapingTabId');
    let tab = null;
    if (scrapingTabId) {
      try {
        tab = await chrome.tabs.get(scrapingTabId);
        if (tab && !/\/nx\/(search\/jobs|find-work)/.test(tab.url || '')) {
          // user navigated away from search — don't force reload
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

// ═══════════════════════════════════════════════════════════
// ENRICHMENT QUEUE — new in v17.1.0
// ═══════════════════════════════════════════════════════════

function pickDelayMs() {
  const r = Math.random();
  let acc = 0;
  for (const [w, minMs, maxMs] of ENRICH_DELAY_WEIGHTS) {
    acc += w;
    if (r <= acc) return minMs + Math.floor(Math.random() * (maxMs - minMs));
  }
  const [, minMs, maxMs] = ENRICH_DELAY_WEIGHTS[ENRICH_DELAY_WEIGHTS.length - 1];
  return minMs + Math.floor(Math.random() * (maxMs - minMs));
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

async function getQueue() {
  const { enrichQueue } = await chrome.storage.local.get('enrichQueue');
  return Array.isArray(enrichQueue) ? enrichQueue : [];
}

async function setQueue(q) {
  await chrome.storage.local.set({ enrichQueue: q.slice(0, ENRICH_MAX_QUEUE) });
}

async function enqueueForEnrichment(items) {
  const q = await getQueue();
  const seen = new Set(q.map(x => x.upwork_id));
  const addedIds = [];
  for (const it of items) {
    if (!it?.upwork_id || !it?.url) continue;
    if (seen.has(it.upwork_id)) continue;
    q.push({
      upwork_id: it.upwork_id,
      url: normalizeJobUrl(it.url),
      title: (it.title || '').substring(0, 200),
      skills: (it.skills || []).slice(0, 10),
      queued_at: Date.now(),
      attempts: 0,
    });
    seen.add(it.upwork_id);
    addedIds.push(it.upwork_id);
  }
  await setQueue(q);
  if (addedIds.length > 0) console.log(`[OU enrich] +${addedIds.length} queued, total ${q.length}`);
  return addedIds;
}

async function getHourlyCount() {
  const { enrichHourBucket } = await chrome.storage.local.get('enrichHourBucket');
  const nowHour = Math.floor(Date.now() / 3600000);
  if (!enrichHourBucket || enrichHourBucket.hour !== nowHour) {
    await chrome.storage.local.set({ enrichHourBucket: { hour: nowHour, count: 0 } });
    return 0;
  }
  return enrichHourBucket.count || 0;
}

async function incHourlyCount() {
  const { enrichHourBucket } = await chrome.storage.local.get('enrichHourBucket');
  const nowHour = Math.floor(Date.now() / 3600000);
  const bucket = enrichHourBucket && enrichHourBucket.hour === nowHour
    ? { hour: nowHour, count: (enrichHourBucket.count || 0) + 1 }
    : { hour: nowHour, count: 1 };
  await chrome.storage.local.set({ enrichHourBucket: bucket });
}

async function getHaltedUntil() {
  const r = await chrome.storage.local.get('enrichHaltedUntil');
  return typeof r.enrichHaltedUntil === 'number' ? r.enrichHaltedUntil : 0;
}

async function haltEnrich(reason, minutes) {
  const until = Date.now() + minutes * 60 * 1000;
  await chrome.storage.local.set({ enrichHaltedUntil: until, enrichHaltReason: reason });
  console.warn(`[OU enrich] 🛑 HALTED until ${new Date(until).toISOString()} — ${reason}`);
  await sendTgHaltAlert(reason, minutes);
}

async function sendTgHaltAlert(reason, minutes) {
  try {
    const { machineId, cachedIdentity } = await chrome.storage.local.get(['machineId', 'cachedIdentity']);
    await fetch(`${SB_URL}/functions/v1/extension-job-enrich/halt-alert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        machine_id: machineId,
        account_slug: cachedIdentity?.member?.slug,
        reason,
        halted_minutes: minutes,
      }),
    });
  } catch {}
}

async function logEnrichmentEvent(status, details) {
  // v17.1.0 Fix D: circuit breaker — if the log endpoint fails 3 times in a
  // row, back off for 10 minutes to avoid creating a new "Failed to fetch"
  // spam loop from the enrichment path.
  try {
    const { enrichLogCircuit } = await chrome.storage.local.get('enrichLogCircuit');
    if (enrichLogCircuit?.openUntil && Date.now() < enrichLogCircuit.openUntil) return;
  } catch {}

  try {
    const { machineId, cachedIdentity } = await chrome.storage.local.get(['machineId', 'cachedIdentity']);
    const res = await fetch(`${SB_URL}/functions/v1/extension-job-enrich/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        machine_id: machineId,
        account_slug: cachedIdentity?.member?.slug,
        status,
        ...details,
      }),
    });
    if (res.ok) {
      // reset circuit on any success
      await chrome.storage.local.remove('enrichLogCircuit');
    } else {
      await bumpLogCircuit();
    }
  } catch {
    await bumpLogCircuit();
  }
}

async function bumpLogCircuit() {
  try {
    const { enrichLogCircuit } = await chrome.storage.local.get('enrichLogCircuit');
    const fails = (enrichLogCircuit?.fails || 0) + 1;
    if (fails >= 3) {
      await chrome.storage.local.set({
        enrichLogCircuit: { fails: 0, openUntil: Date.now() + 10 * 60 * 1000 }
      });
      console.warn('[OU enrich] log circuit open for 10min');
    } else {
      await chrome.storage.local.set({ enrichLogCircuit: { fails, openUntil: 0 } });
    }
  } catch {}
}

let _enrichInFlight = false;

async function maybeProcessEnrichQueue() {
  if (_enrichInFlight) return;

  const haltedUntil = await getHaltedUntil();
  if (Date.now() < haltedUntil) {
    console.log(`[OU enrich] skip: halted for ${Math.round((haltedUntil - Date.now())/60000)}m more`);
    return;
  }

  const { cachedIdentity, pausedUntilUpdate, lastEnrichAt } = await chrome.storage.local.get([
    'cachedIdentity', 'pausedUntilUpdate', 'lastEnrichAt'
  ]);
  if (pausedUntilUpdate) return;
  if (!cachedIdentity?.member?.is_bidding_enabled) return;

  const settings = cachedIdentity?.scrape_settings;
  if (settings?.pattern_mode === 'paused') {
    console.log('[OU enrich] skip: quiet hours');
    return;
  }

  const hourly = await getHourlyCount();
  if (hourly >= ENRICH_MAX_PER_HOUR) {
    console.log(`[OU enrich] skip: hourly cap ${hourly}/${ENRICH_MAX_PER_HOUR}`);
    return;
  }

  if (lastEnrichAt) {
    const since = Date.now() - lastEnrichAt;
    if (since < 25000) return;
  }

  const q = await getQueue();
  if (q.length === 0) return;

  const head = q[0];
  const rest = q.slice(1);
  await setQueue(rest);

  _enrichInFlight = true;
  try {
    await processOneJob(head);
  } catch (e) {
    console.warn('[OU enrich] processOneJob threw', e);
  } finally {
    _enrichInFlight = false;
    await chrome.storage.local.set({ lastEnrichAt: Date.now() });
  }

  const nextDelay = pickDelayMs();
  console.log(`[OU enrich] ⏳ next attempt in ${Math.round(nextDelay/1000)}s`);
  setTimeout(() => { maybeProcessEnrichQueue().catch(() => {}); }, nextDelay);
}

async function processOneJob(item) {
  const startedAt = Date.now();
  console.log('[OU enrich] ▶ opening', item.upwork_id, item.title?.substring(0, 60));

  let tabId = null;
  let settled = false;
  let timeoutHandle = null;

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

    timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.runtime.onMessage.removeListener(listener);
      resolve({ ok: false, error_type: 'tab_timeout', error_detail: 'Hard timeout reached', upwork_job_id: item.upwork_id, url: item.url });
    }, ENRICH_TAB_TIMEOUT_MS);
  });

  try {
    const tab = await chrome.tabs.create({ url: item.url, active: false, pinned: false });
    tabId = tab.id;
  } catch (e) {
    await logEnrichmentEvent('failed', {
      upwork_job_id: item.upwork_id, error_type: 'tab_create_fail',
      error_detail: String(e?.message || e), duration_ms: Date.now() - startedAt,
    });
    return;
  }

  const loadedPromise = new Promise((resolve) => {
    const onUpdated = (id, changeInfo) => {
      if (id !== tabId) return;
      if (changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }, 20000);
  });

  await loadedPromise;
  await new Promise(r => setTimeout(r, ENRICH_MIN_INITIAL_WAIT_MS + Math.floor(Math.random() * 1500)));

  if (tabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['scripts/enrich.js'],
      });
    } catch (e) {
      console.warn('[OU enrich] inject fail:', e);
    }
  }

  const payload = await resultPromise;
  if (timeoutHandle) clearTimeout(timeoutHandle);

  if (tabId !== null) {
    try { await chrome.tabs.remove(tabId); } catch {}
  }

  await incHourlyCount();
  const duration_ms = Date.now() - startedAt;

  const authFailures = ['login_redirect', 'signup_redirect', 'challenge', 'bot_check'];
  if (payload && !payload.ok && authFailures.includes(payload.error_type)) {
    await logEnrichmentEvent('auth_failure', {
      upwork_job_id: item.upwork_id, error_type: payload.error_type,
      error_detail: payload.error_detail, duration_ms,
    });
    await haltEnrich(payload.error_type, ENRICH_AUTH_HALT_MINUTES);
    const q = await getQueue();
    await setQueue([item, ...q]);
    return;
  }

  if (payload?.ok && payload.description && payload.description.length >= 200) {
    const { machineId, cachedIdentity } = await chrome.storage.local.get(['machineId', 'cachedIdentity']);
    try {
      const res = await fetch(`${SB_URL}/functions/v1/extension-job-enrich`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          machine_id: machineId,
          account_slug: cachedIdentity?.member?.slug,
          enrichment: payload,
        }),
      });
      const data = await res.json().catch(() => ({}));
      await logEnrichmentEvent('success', {
        upwork_job_id: item.upwork_id,
        description_chars: payload.description.length,
        duration_ms,
      });
      console.log('[OU enrich] ✓', item.upwork_id, 'desc=', payload.description.length, 'srv=', data?.ok);
    } catch (e) {
      await logEnrichmentEvent('post_failed', {
        upwork_job_id: item.upwork_id,
        error_type: 'post_exception',
        error_detail: String(e?.message || e),
        duration_ms,
      });
    }
    return;
  }

  await logEnrichmentEvent('failed', {
    upwork_job_id: item.upwork_id,
    error_type: payload?.error_type || 'unknown',
    error_detail: payload?.error_detail || 'No description returned',
    duration_ms,
  });
  console.log('[OU enrich] ✗', item.upwork_id, payload?.error_type);
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
  if (msg?.type === 'JOB_SCRAPED') {
    handleScrapedJob(msg.payload).then(r => sendResponse(r)).catch(e => sendResponse({ error: String(e) }));
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
  // v17.1.0 — new popup controls
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
  if (msg?.type === 'GET_SCRAPING_STATE') {
    chrome.storage.local.get(['scrapingActive', 'scrapingTabId', 'cachedIdentity'])
      .then(r => sendResponse({
        active: !!r.scrapingActive,
        tabId: r.scrapingTabId || null,
        preset: r.cachedIdentity?.scrape_preset || { query: 'seo', sort: 'recency', hourly: null }
      }));
    return true;
  }
  // ENRICH_RESULT is handled via per-tab listener inside processOneJob
});

// ═══════════════════════════════════════════════════════════
// v17.1.0 — START/STOP SCRAPING + UPDATE PRESET
// ═══════════════════════════════════════════════════════════

function buildSearchUrl(preset) {
  const q = encodeURIComponent((preset?.query || 'seo').trim());
  const sort = preset?.sort === 'relevance' ? 'relevance' : 'recency';
  const params = [
    `q=${q}`,
    `sort=${sort}`,
    `from_recent_search=true`,
  ];
  if (preset?.hourly === true) params.push('t=0');   // Upwork: t=0 = hourly
  if (preset?.hourly === false) params.push('t=1');  // t=1 = fixed
  return `https://www.upwork.com/nx/search/jobs/?${params.join('&')}`;
}

async function startScraping(opts) {
  const { cachedIdentity, scrapingTabId, machineId } = await chrome.storage.local.get([
    'cachedIdentity', 'scrapingTabId', 'machineId'
  ]);

  if (!cachedIdentity?.member?.is_bidding_enabled) {
    return { ok: false, error: 'Bidding disabled for this account' };
  }

  // If there's already a scraping tab — focus it
  if (scrapingTabId) {
    try {
      const tab = await chrome.tabs.get(scrapingTabId);
      if (tab) {
        await chrome.tabs.update(scrapingTabId, { active: true });
        if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
        return { ok: true, reused: true, tabId: scrapingTabId };
      }
    } catch {
      // tab no longer exists, fall through and create a new one
    }
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

    // Update cached identity locally so next startScraping uses the new preset
    if (cachedIdentity) {
      cachedIdentity.scrape_preset = data.scrape_preset;
      await chrome.storage.local.set({ cachedIdentity });
    }
    return { ok: true, scrape_preset: data.scrape_preset };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// Track when the scraping tab is closed — clean up state
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { scrapingTabId } = await chrome.storage.local.get('scrapingTabId');
  if (scrapingTabId && scrapingTabId === tabId) {
    await chrome.storage.local.set({ scrapingActive: false, scrapingTabId: null });
    console.log('[OU] scraping tab closed by user →  scrapingActive=false');
  }
});

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

async function handleScrapedJob(payload) {
  // v17.1.0: ingest-only — leadgen-v2 upserts the row but does NOT score yet.
  // Scoring is triggered by extension-job-enrich after full description arrives.
  const { cachedIdentity, machineId, pausedUntilUpdate } = await chrome.storage.local.get([
    'cachedIdentity', 'machineId', 'pausedUntilUpdate'
  ]);
  if (pausedUntilUpdate) return { skipped: 'paused_for_update' };
  if (!cachedIdentity?.member?.is_bidding_enabled) return { skipped: 'bidding_disabled' };

  const body = {
    account_slug: cachedIdentity.member.slug,
    machine_id: machineId,
    job: payload,
    ingest_only: true,
  };

  fetch(`${SB_URL}/functions/v1/leadgen-v2`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }).catch(() => {});

  const today = new Date().toDateString();
  const stored = await chrome.storage.local.get(['jobsScrapedToday', 'countsDate']);
  const count = (stored.countsDate === today) ? (stored.jobsScrapedToday || 0) + 1 : 1;
  await chrome.storage.local.set({ jobsScrapedToday: count, countsDate: today });

  return { ok: true, queued: payload.upwork_id || payload.url };
}

function prerank(jobs, specialization) {
  // v17.1.0: specialization values are often multi-word phrases like
  // "Technical SEO Architect" / "Shopify Liquid Optimization". Matching the
  // whole phrase vs a job title rarely succeeds, so we split into meaningful
  // tokens. Drop generic words that match everything.
  const STOP = new Set(['seo', 'the', 'for', 'and', 'optimization', 'management',
    'integration', 'expert', 'specialist']);
  const tokens = new Set();
  for (const phrase of (specialization || [])) {
    const words = String(phrase || '').toLowerCase().split(/[\s\-\/,]+/).filter(Boolean);
    for (const w of words) {
      if (w.length >= 3 && !STOP.has(w)) tokens.add(w);
    }
  }
  // Add the broad 'seo' token with low weight separately (most jobs will have it
  // but it's still a useful positive signal vs non-SEO noise).
  const kws = Array.from(tokens);

  if (kws.length === 0) return jobs.slice(0, 5);

  const scored = jobs.map(j => {
    const title = (j.title || '').toLowerCase();
    const skills = (j.skills || []).join(' ').toLowerCase();
    const hay = `${title} ${skills}`;
    let score = 0;
    for (const kw of kws) {
      if (title.includes(kw)) score += 3;        // title match = strong signal
      else if (skills.includes(kw)) score += 2;  // skill chip match = medium
    }
    // Broad SEO bonus (low weight) so SEO-adjacent jobs rank above pure dev/design
    if (/\bseo\b|\baudit\b|\brank\b|\bgoogle\b/.test(title)) score += 1;
    return { job: j, score };
  });
  scored.sort((a, b) => b.score - a.score);
  // Only take scored items; if everything scored 0, fall back to first 5 by recency
  const positive = scored.filter(x => x.score > 0);
  const pool = positive.length > 0 ? positive : scored;
  return pool.slice(0, 5).map(x => x.job);
}

async function handleJobsCandidates(payload) {
  const jobs = payload?.jobs || [];
  if (jobs.length === 0) return { ok: true, enqueued: 0 };

  const { cachedIdentity } = await chrome.storage.local.get('cachedIdentity');
  if (!cachedIdentity?.member?.is_bidding_enabled) return { skipped: 'bidding_disabled' };

  const spec = cachedIdentity.account?.specialization || cachedIdentity.member?.specialization || [];
  const top = prerank(jobs, spec);

  const addedIds = await enqueueForEnrichment(top.map(j => ({
    upwork_id: j.upwork_id,
    url: j.url,
    title: j.title,
    skills: j.skills,
  })));

  maybeProcessEnrichQueue().catch(() => {});

  return { ok: true, enqueued: addedIds.length, total_candidates: jobs.length };
}

// ═══════════════════════════════════════════════════════════
// ALARMS
// ═══════════════════════════════════════════════════════════

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[OU] Installed — setting up alarms');
  await chrome.alarms.clearAll();
  chrome.alarms.create('heartbeat', { periodInMinutes: 2 });
  chrome.alarms.create('daily-reset', { periodInMinutes: 60 });
  chrome.alarms.create('enrich-drain', { periodInMinutes: 1 });
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
  await identify();
  await dailyReset();
  await heartbeat();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'heartbeat') await heartbeat();
  if (alarm.name === 'daily-reset') await dailyReset();
  if (alarm.name === 'enrich-drain') await maybeProcessEnrichQueue();
});

(async () => {
  await getMachineId();
  const stored = await chrome.storage.local.get('cachedIdentityAt');
  const needsIdentify = !stored.cachedIdentityAt || (Date.now() - stored.cachedIdentityAt > 30 * 60 * 1000);
  if (needsIdentify) await identify();
  await heartbeat();
})();
