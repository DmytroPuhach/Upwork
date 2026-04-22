
// OptimizeUp Extension v17.0.1 — Background Service Worker
// Centralized architecture: thin client, all logic lives in Supabase Edge Functions.

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

// ═══════════════════════════════════════════════════════════
// DETECT UPWORK USER ID (from page)
// ═══════════════════════════════════════════════════════════

async function detectUpworkUser() {
  try {
    const tabs = await chrome.tabs.query({
      url: ['https://www.upwork.com/*', 'https://*.upwork.com/*']
    });
    if (tabs.length === 0) return null;

    for (const tab of tabs) {
      try {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            // Multi-strategy user ID extraction
            try {
              // 1. window.USER_DATA
              if (window.USER_DATA?.cipherUid) return { uid: window.USER_DATA.cipherUid, method: 'window.USER_DATA' };
              if (window.USER?.cipher) return { uid: window.USER.cipher, method: 'window.USER' };

              // 2. meta tag
              const metaUid = document.querySelector('meta[name="user-id"], meta[name="cipher-uid"]')?.content;
              if (metaUid) return { uid: metaUid, method: 'meta' };

              // 3. data attribute on body
              const bodyUid = document.body?.dataset?.userId || document.body?.dataset?.cipherUid;
              if (bodyUid) return { uid: bodyUid, method: 'body-data' };

              // 4. profile link
              const profileLink = document.querySelector('a[href*="/freelancers/~"]')?.href;
              const profMatch = profileLink?.match(/~[\w]+/);
              if (profMatch) return { uid: profMatch[0], method: 'profile-link' };

              // 5. script with JSON containing cipherUid
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
      } catch (e) { /* skip non-accessible tabs */ }
    }
  } catch (e) { console.warn('[OU] detectUpworkUser error:', e); }
  return null;
}

// ═══════════════════════════════════════════════════════════
// IDENTIFY (first startup — knows WHO am I)
// ═══════════════════════════════════════════════════════════

async function identify() {
  const machineId = await getMachineId();
  const upworkUserId = await detectUpworkUser();

  const body = {
    machine_id: machineId,
    upwork_user_id: upworkUserId || null
  };

  try {
    const res = await fetch(`${SB_URL}/functions/v1/extension-config/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    await chrome.storage.local.set({
      cachedIdentity: data,
      cachedIdentityAt: Date.now()
    });
    console.log('[OU] Identity:', data?.member?.slug || 'unknown');
    return data;
  } catch (e) {
    console.error('[OU] Identify failed:', e);
    return null;
  }
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
    machine_id: machineId,
    version: EXT_VERSION,
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
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    console.log('[OU] Heartbeat OK');

    // Check for update
    if (data.update_info?.update_available) {
      await chrome.storage.local.set({ 
        pendingUpdate: data.update_info, 
        pausedUntilUpdate: data.force_update 
      });
      if (data.force_update) {
        console.warn('[OU] FORCE UPDATE — scraper paused');
      }
    } else {
      await chrome.storage.local.remove(['pendingUpdate', 'pausedUntilUpdate']);
    }

    return data;
  } catch (e) {
    console.error('[OU] Heartbeat failed:', e);
    await chrome.storage.local.set({ lastScraperError: String(e).substring(0, 300) });
  }
}

// ═══════════════════════════════════════════════════════════
// DAILY RESET
// ═══════════════════════════════════════════════════════════

async function dailyReset() {
  const today = new Date().toDateString();
  const { countsDate } = await chrome.storage.local.get('countsDate');
  if (countsDate !== today) {
    await chrome.storage.local.set({
      countsDate: today,
      jobsScrapedToday: 0,
      messagesCapturedToday: 0
    });
    console.log('[OU] Daily counters reset');
  }
}

// ═══════════════════════════════════════════════════════════
// MESSAGE ROUTER (from content.js)
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
  const { cachedIdentity, machineId } = await chrome.storage.local.get(['cachedIdentity', 'machineId']);
  if (!cachedIdentity?.member) return { skipped: 'no_identity' };

  const body = {
    ...payload,
    account_slug: cachedIdentity.member.slug,
    machine_id: machineId
  };

  try {
    const r = await fetch(`${SB_URL}/functions/v1/reply-generator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json();

    // Bump counter
    const today = new Date().toDateString();
    const stored = await chrome.storage.local.get(['messagesCapturedToday', 'countsDate']);
    const count = (stored.countsDate === today) ? (stored.messagesCapturedToday || 0) + 1 : 1;
    await chrome.storage.local.set({ messagesCapturedToday: count, countsDate: today });

    return { ok: true, data };
  } catch (e) {
    return { error: String(e) };
  }
}

async function handleScrapedJob(payload) {
  const { cachedIdentity, machineId } = await chrome.storage.local.get(['cachedIdentity', 'machineId']);
  if (!cachedIdentity?.member?.is_bidding_enabled) return { skipped: 'bidding_disabled' };

  const body = {
    account_slug: cachedIdentity.member.slug,
    machine_id: machineId,
    job: payload
  };

  // Fire-and-forget — leadgen-v2 is async
  fetch(`${SB_URL}/functions/v1/leadgen-v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(() => {});

  const today = new Date().toDateString();
  const stored = await chrome.storage.local.get(['jobsScrapedToday', 'countsDate']);
  const count = (stored.countsDate === today) ? (stored.jobsScrapedToday || 0) + 1 : 1;
  await chrome.storage.local.set({ jobsScrapedToday: count, countsDate: today });

  return { ok: true, queued: payload.upwork_id || payload.url };
}

// ═══════════════════════════════════════════════════════════
// ALARMS
// ═══════════════════════════════════════════════════════════

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[OU] Installed — setting up alarms');
  await chrome.alarms.clearAll();
  chrome.alarms.create('heartbeat', { periodInMinutes: 5 });
  chrome.alarms.create('daily-reset', { periodInMinutes: 60 });
  await identify();
  await dailyReset();
  await heartbeat();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[OU] Startup');
  await chrome.alarms.clearAll();
  chrome.alarms.create('heartbeat', { periodInMinutes: 5 });
  chrome.alarms.create('daily-reset', { periodInMinutes: 60 });
  await identify();
  await dailyReset();
  await heartbeat();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'heartbeat') await heartbeat();
  if (alarm.name === 'daily-reset') await dailyReset();
});

// Initial run (MV3 service worker can wake up after 'being killed')
(async () => {
  await getMachineId();
  const stored = await chrome.storage.local.get('cachedIdentityAt');
  const needsIdentify = !stored.cachedIdentityAt || (Date.now() - stored.cachedIdentityAt > 30 * 60 * 1000);
  if (needsIdentify) await identify();
  await heartbeat();
})();
