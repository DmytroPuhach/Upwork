// OptimizeUp Extension v17.1.3 — Background Service Worker
// v17.1.3: debounce duplicate JOB_SCRAPED sends (was 3-5x parallel → 1 req/job),
//   accept prematch_reason/prematch_score from content.js and pass to leadgen-v2
//   (surfaces "skip: country" in dashboard instead of silent pending).
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
const ENRICH_MAX_PER_HOUR = 8;                // v17.1.7: was 5, +60% throughput
// v17.1.2: human read/click cadence. Distribution approximates a real freelancer:
// most opens 30-75s apart, sometimes slower, and ~5% "long pause" (3-5 min)
// simulating distraction / coffee break. Gives avg ~75s between opens.
const ENRICH_DELAY_WEIGHTS = [                // (weight, minMs, maxMs)
  [0.35, 30000, 45000],    // 30-45s  — quick sequence
  [0.40, 45000, 75000],    // 45-75s  — normal
  [0.20, 75000, 140000],   // 75-140s — slower read
  [0.05, 180000, 300000],  // 3-5 min — distraction
];
const ENRICH_TAB_TIMEOUT_MS = 60000;          // force-close if stuck
// v17.1.2: human read time on the single-job page before we extract.
// Real freelancers spend 15-40s reading a brief. We stay on the low end
// of that (8-15s) to still drain the queue, but far above the old 2-4s
// that was clearly synthetic.
const ENRICH_MIN_READ_MS = 8000;
const ENRICH_READ_JITTER_MS = 7000;
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
  await maybeProcessFreshLane();
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
    // v17.1.2: client-side quiet hours in account's own TZ
    if (isInQuietHours(cachedIdentity)) { console.log('[OU] reload skip: quiet hours (account TZ)'); return; }

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

// v17.1.2: client-side quiet-hours check using account's own timezone.
// Uses Intl.DateTimeFormat to convert "now" to the account's local hour.
// Guards against both server-TZ (Edmonton) and account-TZ being wrong.
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

    // Quiet hours wrap midnight (e.g. 22 → 7) or don't (e.g. 0 → 7)
    if (qStart <= qEnd) {
      return hour >= qStart && hour < qEnd;
    }
    return hour >= qStart || hour < qEnd;
  } catch {
    return false;
  }
}

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

// v17.1.5: priority score — lower is better (обработается раньше).
// Formula:
//   base = posted_ago_min (свежак → маленький скор → в начало)
//   - 1000 если client_spent_rough >= $5K (жирный клиент в приоритете)
//   - 500  если client_spent_rough >= $1K
//   unknown posted_ago_min → 15 (предполагаем свежак от scraper)
// v17.1.7: FRESH FIRST. По бизнес-данным Димы: первый подавшийся = ~80%
// успеха. Всё остальное второстепенно. Свежаки <10 мин получают mega-boost
// (-9999) и обгоняют всю очередь независимо от matching/spent. Старые —
// сортируются по matched_skills и spent как раньше.
function computePriority(item) {
  const age = typeof item.posted_ago_min === 'number' ? item.posted_ago_min : 15;

  // Fresh lane: <10 min — прямой аванс перед всеми остальными.
  if (age <= 10) return -9999 + age;  // -9999..-9989 для очередности по свежести

  // Обычный расчёт
  let prio = age;
  const matched = Number(item.matched_skills) || 0;
  prio -= matched * 200;
  const spent = item.client_spent_rough;
  if (typeof spent === 'number') {
    if (spent >= 5000) prio -= 1000;
    else if (spent >= 1000) prio -= 500;
  }
  return prio;
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
      // v17.1.5: запоминаем метрики для prio-sort и потом в pipeline
      posted_ago_min: typeof it.posted_ago_min === 'number' ? it.posted_ago_min : null,
      client_spent_rough: typeof it.client_spent_rough === 'number' ? it.client_spent_rough : null,
      matched_skills: Number(it.matched_skills) || 0,
      total_skills: Number(it.total_skills) || 0,
      priority: computePriority(it),
      queued_at: Date.now(),
      attempts: 0,
    });
    seen.add(it.upwork_id);
    addedIds.push(it.upwork_id);
  }
  // v17.1.5: сортируем всю очередь по priority ASC (fresh + fat first).
  // stale + light уходят в конец — их либо съест следующий час, либо вытеснят
  // новые поступления.
  q.sort((a, b) => (a.priority ?? 9999) - (b.priority ?? 9999));
  await setQueue(q);
  if (addedIds.length > 0) {
    const sample = q.slice(0, 3).map(x => {
      const sk = x.matched_skills ? ` · 🎯${x.matched_skills}` : '';
      return `${x.title?.substring(0, 25)}(p=${x.priority}${sk})`;
    }).join(' | ');
    console.log(`[OU enrich] +${addedIds.length} queued, total ${q.length}. Top: ${sample}`);
  }
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
let _freshInFlight = false;  // v17.2.0: separate slot for fresh jobs (<15min)

// v17.2.0: FRESH FAST LANE.
// Если в очереди есть fresh job (<15 min) — обрабатываем его немедленно в
// параллельном slot, минуя 25s gap и pickDelayMs. Rate cap 8/hr применяется
// к обоим slot'ам вместе (общий счётчик). Индусы подают в первые 30s — мы
// тоже должны быть на feed'е как только job появился.
async function maybeProcessFreshLane() {
  if (_freshInFlight) return;

  const haltedUntil = await getHaltedUntil();
  if (Date.now() < haltedUntil) return;

  const { cachedIdentity, pausedUntilUpdate } = await chrome.storage.local.get([
    'cachedIdentity', 'pausedUntilUpdate'
  ]);
  if (pausedUntilUpdate) return;
  if (!cachedIdentity?.member?.is_bidding_enabled) return;
  if (cachedIdentity?.scrape_settings?.pattern_mode === 'paused') return;
  if (isInQuietHours(cachedIdentity)) return;

  const hourly = await getHourlyCount();
  if (hourly >= ENRICH_MAX_PER_HOUR) return;

  const q = await getQueue();
  if (q.length === 0) return;

  // Find first fresh (<15 min) job in queue
  const freshIdx = q.findIndex(item =>
    typeof item.posted_ago_min === 'number' && item.posted_ago_min <= 15
  );
  if (freshIdx < 0) return;  // no fresh — regular lane handles

  const head = q[freshIdx];
  const rest = q.slice(0, freshIdx).concat(q.slice(freshIdx + 1));
  await setQueue(rest);

  _freshInFlight = true;
  try {
    console.log(`[OU fresh] ⚡ instant process: ${head.title?.substring(0, 50)} (age=${head.posted_ago_min}m)`);
    await processOneJob(head, { fresh: true });
  } catch (e) {
    console.warn('[OU fresh] processOneJob threw', e);
  } finally {
    _freshInFlight = false;
  }

  // Immediately check for another fresh — no pickDelayMs wait
  setTimeout(() => { maybeProcessFreshLane().catch(() => {}); }, 3000);
}

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
    console.log('[OU enrich] skip: quiet hours (server-reported)');
    return;
  }

  // v17.1.2: double-check quiet hours client-side against the account's own
  // timezone. scrape_commands.timezone is generic (Edmonton) but accounts.timezone
  // reflects the operator's real location. We want Upwork to see activity only
  // during the operator's waking hours.
  if (isInQuietHours(cachedIdentity)) {
    console.log('[OU enrich] skip: quiet hours (account TZ)');
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

  // v17.2.0: fresh jobs (<15 min) skipped here — fresh lane handles them in parallel
  const head = q.find(item =>
    !(typeof item.posted_ago_min === 'number' && item.posted_ago_min <= 15)
  );
  if (!head) return;  // only fresh items left, let fresh lane drain
  const rest = q.filter(x => x.upwork_id !== head.upwork_id);
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

async function processOneJob(item, opts = {}) {
  const fresh = !!opts.fresh;
  const startedAt = Date.now();
  console.log(`[OU ${fresh ? 'fresh' : 'enrich'}] ▶ opening`, item.upwork_id, item.title?.substring(0, 60));

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
  // v17.2.0: fresh jobs get 3-5s read (speed > stealth), regular 8-15s (human sim)
  const readBase = fresh ? 3000 : ENRICH_MIN_READ_MS;
  const readJitter = fresh ? 2000 : ENRICH_READ_JITTER_MS;
  await new Promise(r => setTimeout(r, readBase + Math.floor(Math.random() * readJitter)));

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
          matched_skills: Number(item.matched_skills) || 0,
          total_skills: Number(item.total_skills) || 0,
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
  // v17.1.5: jobs которые content.js prematch'нул. Не идут в enrichment queue,
  // пишутся сразу в match_scores как skip с причиной.
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

// v17.1.3: in-memory debounce map to collapse 3-5x parallel JOB_SCRAPED
// events on the same upwork_id — fixes ~137/day upsert_job_error spam
// in leadgen_debug. 10 min is enough (content.js seen-set already dedups
// per page session; this covers cross-tab / fast re-observes).
const recentIngests = new Map();  // upwork_id -> ts
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

// v17.1.3: normalize country strings for comparison against account.blocked_countries.
// Handles "United Arab Emirates" / "ARE" / "U.A.E" style variants; fallback is
// case-insensitive substring match (also handles "blocked=India" vs job="India").
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

// v17.1.5: когда content.js prematch'нул job — шлём в leadgen-v2 с
// prematch_reason, но БЕЗ enrichment queue. В дашборде сразу видно
// "skip: country" / "skip: off_niche" / etc. вместо молчаливого pending.
async function handleScrapedJobSkip(payload) {
  const { cachedIdentity, machineId, pausedUntilUpdate } = await chrome.storage.local.get([
    'cachedIdentity', 'machineId', 'pausedUntilUpdate'
  ]);
  if (pausedUntilUpdate) return { skipped: 'paused_for_update' };
  if (!cachedIdentity?.member?.is_bidding_enabled) return { skipped: 'bidding_disabled' };

  const reason = payload.prematch_reason || 'unknown';
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
    // v17.1.6: Upwork skill-overlap
    matched_skills: Number(payload.matched_skills) || 0,
    total_skills: Number(payload.total_skills) || 0,
  };

  fetch(`${SB_URL}/functions/v1/leadgen-v2`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }).catch(() => {});

  // Still increment today's counter — the job WAS scraped, just not pursued
  const today = new Date().toDateString();
  const stored = await chrome.storage.local.get(['jobsScrapedToday', 'countsDate']);
  const count = (stored.countsDate === today) ? (stored.jobsScrapedToday || 0) + 1 : 1;
  await chrome.storage.local.set({ jobsScrapedToday: count, countsDate: today });

  return { ok: true, skipped_reason: reason, upwork_id: payload.upwork_id };
}

async function handleScrapedJob(payload) {
  // v17.1.3: pre-match skip on search page. If job's country is in
  // account.blocked_countries — still call leadgen-v2 with ingest_only, but
  // attach prematch_reason so the skip is recorded in match_scores and we
  // don't waste an enrichment slot on a job we'd reject post-enrich anyway.
  // Scoring for non-skipped jobs is triggered by extension-job-enrich after
  // full description arrives.
  const { cachedIdentity, machineId, pausedUntilUpdate } = await chrome.storage.local.get([
    'cachedIdentity', 'machineId', 'pausedUntilUpdate'
  ]);
  if (pausedUntilUpdate) return { skipped: 'paused_for_update' };
  if (!cachedIdentity?.member?.is_bidding_enabled) return { skipped: 'bidding_disabled' };

  // v17.1.3 debounce — collapse parallel JOB_SCRAPED for the same job
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
    // v17.1.6: Upwork skill-overlap
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

  // v17.1.5: blocked-country filter теперь делается в content.js prematchDecide
  // (с шансом попасть в match_scores как 'skip: country'). Здесь дубликатный
  // guard на случай если client_country пришла не из content.js (defensive).
  const blocked = cachedIdentity.account?.blocked_countries
               || cachedIdentity.member?.blocked_countries
               || [];
  const filtered = jobs.filter(j => !isBlockedCountry(j.client_country, blocked));
  const stripped = jobs.length - filtered.length;

  if (filtered.length === 0) return { ok: true, enqueued: 0, stripped_blocked: stripped };

  const spec = cachedIdentity.account?.specialization || cachedIdentity.member?.specialization || [];
  const top = prerank(filtered, spec);

  // v17.1.5: передаём posted_ago_min + client_spent_rough в очередь,
  // чтобы enqueueForEnrichment() мог отсортировать по приоритету
  // (свежие + жирные клиенты первые).
  const addedIds = await enqueueForEnrichment(top.map(j => ({
    upwork_id: j.upwork_id,
    url: j.url,
    title: j.title,
    skills: j.skills,
    posted_ago_min: j.posted_ago_min ?? null,
    client_spent_rough: j.client_spent_rough ?? null,
  })));

  maybeProcessFreshLane().catch(() => {});
  maybeProcessEnrichQueue().catch(() => {});

  return { ok: true, enqueued: addedIds.length, total_candidates: jobs.length, stripped_blocked: stripped };
}

// ═══════════════════════════════════════════════════════════
// v17.1.4 — PROFILE SYNC WORKER (2x/day, background tab)
// ═══════════════════════════════════════════════════════════
//
// Once every ~12 hours (morning ~08:00 + evening ~19:00 Berlin, ±20min jitter),
// open 3 Upwork SSR pages in a background tab, inject profile-sync.js, let it
// parse Nuxt state and POST to profile-sync edge function.
//
// Mirrors enrich.js posture: human scroll, natural read-time, single tab at a
// time, full credentialed context. NOT a fetch() — a real tab visit, so the
// session/cookies/TLS fingerprint is identical to normal user browsing.

const PROFILE_SYNC_PAGES = [
  { slug: 'my-stats',         url: 'https://www.upwork.com/nx/my-stats/' },
  { slug: 'proposals',        url: 'https://www.upwork.com/nx/proposals/' },
  { slug: 'connects-history', url: 'https://www.upwork.com/nx/plans/connects/history/' },
];
const PROFILE_SYNC_PAGE_TIMEOUT_MS = 45000;    // per-tab ceiling
const PROFILE_SYNC_READ_MS_MIN = 4000;         // dwell after load before inject
const PROFILE_SYNC_READ_MS_MAX = 9000;
const PROFILE_SYNC_JITTER_MS_MIN = 15000;      // between pages
const PROFILE_SYNC_JITTER_MS_MAX = 30000;
// Morning window: 07:40–08:20, evening: 18:40–19:20 Berlin.
// We convert to the user's local tz at runtime using account.timezone
// (defaults to Europe/Berlin per identify() payload).
const PROFILE_SYNC_WINDOWS = [
  { start_hour: 7,  start_min: 40, span_min: 40 },  // ~08:00 ± 20
  { start_hour: 18, start_min: 40, span_min: 40 },  // ~19:00 ± 20
];

function randBetween(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

async function shouldRunProfileSyncNow() {
  const { pausedUntilUpdate, scrapingActive, profileSyncLastRunAt, profileSyncNextSlotAt } =
    await chrome.storage.local.get([
      'pausedUntilUpdate', 'scrapingActive', 'profileSyncLastRunAt', 'profileSyncNextSlotAt'
    ]);

  if (pausedUntilUpdate) return { run: false, reason: 'paused_for_update' };

  // Min gap 5h between runs so we don't double-fire on clock skew
  if (profileSyncLastRunAt && (Date.now() - profileSyncLastRunAt) < 5 * 3600 * 1000) {
    return { run: false, reason: 'too_soon_since_last' };
  }

  // If we've pre-scheduled a slot and we're not there yet — wait
  if (profileSyncNextSlotAt && Date.now() < profileSyncNextSlotAt) {
    return { run: false, reason: 'waiting_for_slot', next_at: profileSyncNextSlotAt };
  }

  // Berlin hour check. Cheap: just compare local hour in Berlin.
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

    // Timeout guard — if the page hangs, bail
    const timer = setTimeout(() => finish({ ok: false, error_type: 'tab_timeout', page: page.slug }), PROFILE_SYNC_PAGE_TIMEOUT_MS);

    (async () => {
      try {
        // Tag the document with our account slug so profile-sync.js can read it
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (slug) => { try { document.body.dataset.ouAccountSlug = slug; sessionStorage.setItem('ou_account_slug', slug); } catch {} },
          args: [accountSlug],
        });
        // Natural read delay before parsing (mirrors enrich.js)
        await new Promise(r => setTimeout(r, randBetween(PROFILE_SYNC_READ_MS_MIN, PROFILE_SYNC_READ_MS_MAX)));
        // Inject the parser
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

  // Block concurrent runs
  const { profileSyncRunning } = await chrome.storage.local.get('profileSyncRunning');
  if (profileSyncRunning) return { ok: false, reason: 'already_running' };
  await chrome.storage.local.set({ profileSyncRunning: true });

  const results = [];
  try {
    for (let i = 0; i < PROFILE_SYNC_PAGES.length; i++) {
      const page = PROFILE_SYNC_PAGES[i];
      console.log(`[OU profile-sync] → ${page.slug}`);

      // Open background tab
      let tab;
      try {
        tab = await chrome.tabs.create({ url: page.url, active: false });
      } catch (e) {
        results.push({ page: page.slug, ok: false, error: 'tab_create_failed' });
        continue;
      }

      // Wait for complete load (or timeout handled inside runProfileSyncOnce)
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

      // Jitter between pages — except after the last
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
  if (!check.run) { /* silent — this fires every 10 min */ return; }
  console.log('[OU profile-sync] window hit, starting', check.window);
  await runProfileSyncAllPages();
}

// ═══════════════════════════════════════════════════════════
// ALARMS
// ═══════════════════════════════════════════════════════════

// v17.1.6 — SEARCH QUERY ROTATION (default OFF, opt-in)
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

    // DEFAULT OFF. Включить: chrome.storage.local.set({searchRotationEnabled: true})
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

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[OU] Installed — setting up alarms, reason=', details?.reason);
  await chrome.alarms.clearAll();
  chrome.alarms.create('heartbeat', { periodInMinutes: 2 });
  chrome.alarms.create('daily-reset', { periodInMinutes: 60 });
  chrome.alarms.create('enrich-drain', { periodInMinutes: 1 });
  chrome.alarms.create('profile-sync-check', { periodInMinutes: 10 });
  chrome.alarms.create('search-rotate', { periodInMinutes: 15 });  // v17.1.6

  // v17.1.6: clear stale enrichQueue при upgrade
  if (details?.reason === 'update' || details?.reason === 'install') {
    const { enrichQueue } = await chrome.storage.local.get('enrichQueue');
    if (Array.isArray(enrichQueue) && enrichQueue.length > 0) {
      console.log('[OU upgrade] clearing stale enrichQueue (' + enrichQueue.length + ' items)');
      await chrome.storage.local.set({ enrichQueue: [] });
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
  chrome.alarms.create('profile-sync-check', { periodInMinutes: 10 });  // v17.1.4
  chrome.alarms.create('search-rotate', { periodInMinutes: 15 });  // v17.1.6
  await identify();
  await dailyReset();
  await heartbeat();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'heartbeat') await heartbeat();
  if (alarm.name === 'daily-reset') await dailyReset();
  if (alarm.name === 'enrich-drain') {
    await maybeProcessFreshLane();
    await maybeProcessEnrichQueue();
  }
  if (alarm.name === 'profile-sync-check') await maybeRunProfileSync();  // v17.1.4
  if (alarm.name === 'search-rotate') await maybeRotateSearch();  // v17.1.6
});

(async () => {
  await getMachineId();
  const stored = await chrome.storage.local.get('cachedIdentityAt');
  const needsIdentify = !stored.cachedIdentityAt || (Date.now() - stored.cachedIdentityAt > 30 * 60 * 1000);
  if (needsIdentify) await identify();
  await heartbeat();
})();
