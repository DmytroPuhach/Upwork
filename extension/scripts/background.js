
// OptimizeUp Extension v17.0.4 — Background Service Worker
// NEW: auto-reload scheduler — pulls next_scrape_at from server, reloads Upwork tab
// when it's time, respecting quiet_hours + min_interval + human-like jitter.

const SB_URL = 'https://nsmcaexdqbipusjuzfht.supabase.co';
const EXT_VERSION = chrome.runtime.getManifest().version;

console.log('[OU] Background loaded — version', EXT_VERSION);

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
// HEARTBEAT — ALWAYS re-identify to get fresh scrape_settings
// ═══════════════════════════════════════════════════════════

async function heartbeat() {
  const { cachedIdentity, machineId, jobsScrapedToday, messagesCapturedToday, lastScraperError } 
    = await chrome.storage.local.get([
      'cachedIdentity', 'machineId', 'jobsScrapedToday', 'messagesCapturedToday', 'lastScraperError'
    ]);

  if (!machineId) { console.warn('[OU] heartbeat: no machineId'); return; }

  // Heartbeat
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

  // Re-identify every heartbeat to get fresh scrape_settings
  await identify();

  // Check if it's time to reload the Upwork tab
  await maybeReloadUpworkTab();
}

// ═══════════════════════════════════════════════════════════
// AUTO-RELOAD SCHEDULER — v17.0.4
// ═══════════════════════════════════════════════════════════

async function maybeReloadUpworkTab() {
  try {
    const { cachedIdentity, lastReloadAt, pausedUntilUpdate } = await chrome.storage.local.get([
      'cachedIdentity', 'lastReloadAt', 'pausedUntilUpdate'
    ]);

    // Gate: need bidding-enabled freelancer + not paused for update
    if (!cachedIdentity?.member?.is_bidding_enabled) return;
    if (pausedUntilUpdate) { console.log('[OU] reload skip: paused for update'); return; }

    const settings = cachedIdentity?.scrape_settings;
    if (!settings || !settings.enabled) { console.log('[OU] reload skip: scraper disabled'); return; }
    if (settings.pattern_mode === 'paused') { console.log('[OU] reload skip: pattern_mode=paused (quiet hours)'); return; }

    // Check quiet hours in user's TZ (use local for simplicity; scheduler already accounts for TZ)
    const nowHour = new Date().getUTCHours();  // approximate — scheduler is authoritative
    // Actually trust pattern_mode='paused' from server for quiet hours

    // Minimum interval since last reload (absolute floor, prevent too-frequent reloads)
    const minSec = Math.max(settings.min_interval_sec || 180, 120);  // at least 2 min
    const maxSec = Math.max(settings.max_interval_sec || 2700, minSec + 60);

    const sinceLastReload = lastReloadAt ? (Date.now() - lastReloadAt) / 1000 : Infinity;
    if (sinceLastReload < minSec) {
      console.log(`[OU] reload skip: last reload ${Math.round(sinceLastReload)}s ago, min ${minSec}s`);
      return;
    }

    // Check server's next_scrape_at — if in future, wait
    if (settings.next_scrape_at) {
      const nextAt = new Date(settings.next_scrape_at).getTime();
      if (Date.now() < nextAt) {
        const waitSec = Math.round((nextAt - Date.now()) / 1000);
        console.log(`[OU] reload wait: server says next scrape in ${waitSec}s`);
        return;
      }
    }

    // Find an open Upwork job-search tab
    const tabs = await chrome.tabs.query({
      url: ['https://www.upwork.com/nx/search/jobs/*', 'https://www.upwork.com/nx/find-work/*']
    });

    if (tabs.length === 0) {
      console.log('[OU] reload skip: no Upwork job-search tab open');
      return;
    }

    // Pick the most recently active tab
    const tab = tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];

    // Add human-like jitter: ±30 sec randomness
    const jitterMs = Math.floor((Math.random() - 0.5) * 60 * 1000);
    const delayMs = Math.max(0, jitterMs);

    console.log(`[OU] ⏰ Scheduling reload of tab ${tab.id} in ${Math.round(delayMs/1000)}s (with jitter)`);

    setTimeout(async () => {
      try {
        await chrome.tabs.reload(tab.id);
        await chrome.storage.local.set({ lastReloadAt: Date.now() });
        console.log('[OU] 🔄 Reloaded tab', tab.id, tab.url);
      } catch (e) {
        console.warn('[OU] reload failed:', e);
      }
    }, delayMs);

  } catch (e) {
    console.warn('[OU] maybeReloadUpworkTab error:', e);
  }
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
  if (msg?.type === 'GET_IDENTITY') {
    chrome.storage.local.get(['cachedIdentity', 'machineId']).then(r => sendResponse(r));
    return true;
  }
  if (msg?.type === 'FORCE_IDENTIFY') {
    identify().then(r => sendResponse({ ok: true, identity: r }));
    return true;
  }
});

async function handleInboundMessage(payload) {
  const { cachedIdentity, machineId, pausedUntilUpdate } = await chrome.storage.local.get([
    'cachedIdentity', 'machineId', 'pausedUntilUpdate'
  ]);
  if (pausedUntilUpdate) return { skipped: 'paused_for_update' };
  if (!cachedIdentity?.member) return { skipped: 'no_identity' };

  const body = {
    ...payload,
    account_slug: cachedIdentity.member.slug,
    machine_id: machineId
  };

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
  const { cachedIdentity, machineId, pausedUntilUpdate } = await chrome.storage.local.get([
    'cachedIdentity', 'machineId', 'pausedUntilUpdate'
  ]);
  if (pausedUntilUpdate) return { skipped: 'paused_for_update' };
  if (!cachedIdentity?.member?.is_bidding_enabled) return { skipped: 'bidding_disabled' };

  const body = {
    account_slug: cachedIdentity.member.slug,
    machine_id: machineId,
    job: payload
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

// ═══════════════════════════════════════════════════════════
// ALARMS — heartbeat every 2 min (was 5) so reload check is responsive
// ═══════════════════════════════════════════════════════════

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[OU] Installed — setting up alarms');
  await chrome.alarms.clearAll();
  chrome.alarms.create('heartbeat', { periodInMinutes: 2 });
  chrome.alarms.create('daily-reset', { periodInMinutes: 60 });
  await identify();
  await dailyReset();
  await heartbeat();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[OU] Startup');
  await chrome.alarms.clearAll();
  chrome.alarms.create('heartbeat', { periodInMinutes: 2 });
  chrome.alarms.create('daily-reset', { periodInMinutes: 60 });
  await identify();
  await dailyReset();
  await heartbeat();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'heartbeat') await heartbeat();
  if (alarm.name === 'daily-reset') await dailyReset();
});

// Initial run
(async () => {
  await getMachineId();
  const stored = await chrome.storage.local.get('cachedIdentityAt');
  const needsIdentify = !stored.cachedIdentityAt || (Date.now() - stored.cachedIdentityAt > 30 * 60 * 1000);
  if (needsIdentify) await identify();
  await heartbeat();
})();
