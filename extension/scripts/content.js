
// OptimizeUp Extension v17.0.1 — Content Script
// Real scraping with proven Upwork selectors + multi-strategy fallback.
// Selectors combined from v1.0.0 (tested) + modern fallbacks.

(function () {
  'use strict';

  const SB_URL = 'https://nsmcaexdqbipusjuzfht.supabase.co';
  const EXT_VERSION = chrome.runtime.getManifest().version;

  function log(...a) { console.log('[OU scraper]', ...a); }
  function warn(...a) { console.warn('[OU scraper]', ...a); }

  function hash(str) {
    let h = 0; for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
    return Math.abs(h).toString(36);
  }

  function getSeenSet(key) {
    try { const raw = sessionStorage.getItem(`ou_seen_${key}`); return new Set(raw ? JSON.parse(raw) : []); }
    catch { return new Set(); }
  }
  function addSeen(key, id) {
    try {
      const set = getSeenSet(key); set.add(id);
      const arr = Array.from(set).slice(-500);
      sessionStorage.setItem(`ou_seen_${key}`, JSON.stringify(arr));
    } catch {}
  }

  function extractRoomId(url) {
    const m = (url || location.href).match(/room_([a-f0-9]+)/);
    return m ? m[1] : null;
  }

  function getPageType() {
    const p = location.pathname;
    if (/\/messages\/rooms?\/room_/.test(p)) return 'messages';
    if (/\/messages/.test(p)) return 'messages';
    if (/\/nx\/search\/jobs/.test(p)) return 'jobs_search';
    if (/\/jobs\/[\w~]+/.test(p)) return 'job_detail';
    if (/\/nx\/proposals/.test(p)) return 'proposal_list';
    return 'other';
  }

  // ═══════════════════════════════════════════════════════════
  // TELEMETRY
  // ═══════════════════════════════════════════════════════════

  async function sendTelemetry(eventType, payload) {
    try {
      const identity = await chrome.storage.local.get(['machineId', 'cachedIdentity']);
      const body = {
        machine_id: identity.machineId,
        account_slug: identity.cachedIdentity?.member?.slug,
        event_type: eventType,
        page_type: getPageType(),
        page_url: location.href.substring(0, 500),
        extension_version: EXT_VERSION,
        user_agent: navigator.userAgent.substring(0, 200),
        ...payload
      };
      fetch(`${SB_URL}/functions/v1/extension-telemetry`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).catch(() => {});
    } catch {}
  }

  async function reportBroken(pageType, domSample) {
    await sendTelemetry('selector_broken', {
      selector_strategy: 'all_failed', detected_count: 0,
      dom_sample: domSample?.substring(0, 10000)
    });
  }

  async function reportSuccess(pageType, strategy, count) {
    const key = `ou_last_success_${pageType}`;
    const last = parseInt(sessionStorage.getItem(key) || '0');
    if (Date.now() - last < 10 * 60 * 1000) return;
    sessionStorage.setItem(key, String(Date.now()));
    await sendTelemetry('selector_success', { selector_strategy: strategy, detected_count: count });
  }

  // ═══════════════════════════════════════════════════════════
  // MESSAGE SELECTORS (combined from v1.0.0 tested + modern)
  // ═══════════════════════════════════════════════════════════

  const MESSAGE_STRATEGIES = [
    {
      name: 'v1-proven',  // Known-working from legacy v1.0.0
      find: () => document.querySelectorAll(
        'p[class*="break-word"], [class*="message-body"] p, [data-test*="message"] p'
      ),
      extract: (el) => {
        const text = el.textContent?.trim();
        const container = el.closest('[class*="message"]') || el.closest('[class*="msg"]') || el.parentElement?.parentElement;
        const isOwn = container?.querySelector?.('[class*="visitor"]')
                   || container?.classList?.contains('is-own')
                   || container?.querySelector?.('[class*="self"]');
        return { text, is_own: !!isOwn, timestamp: container?.querySelector('time')?.getAttribute('datetime') };
      }
    },
    {
      name: 'testid-modern',
      find: () => document.querySelectorAll('[data-testid*="message"] p, [data-test*="message"] [class*="body"]'),
      extract: (el) => ({
        text: el.textContent?.trim(),
        is_own: null,
        timestamp: el.closest('[data-testid*="message"]')?.querySelector('time')?.getAttribute('datetime')
      })
    },
    {
      name: 'air3',  // Upwork's design system
      find: () => document.querySelectorAll('.air3-msg-body, .air3-msg-item [class*="body"]'),
      extract: (el) => ({
        text: el.textContent?.trim(),
        is_own: null,
        timestamp: el.closest('.air3-msg-item')?.querySelector('time')?.getAttribute('datetime')
      })
    }
  ];

  function getClientName() {
    return document.querySelector('[class*="room-header"] [class*="name"]')?.textContent?.trim()
        || document.querySelector('[class*="thread-header"] [class*="name"]')?.textContent?.trim()
        || document.querySelector('h2[class*="name"], h3[class*="name"]')?.textContent?.trim()
        || document.title?.replace(' | Upwork', '').replace('Messages - ', '').trim()
        || null;
  }

  // ═══════════════════════════════════════════════════════════
  // JOB CARD SELECTORS
  // ═══════════════════════════════════════════════════════════

  const JOB_STRATEGIES = [
    {
      name: 'testid',
      find: () => document.querySelectorAll('[data-testid*="job-tile"], article[data-ev-sublocation-str*="job"]'),
      extract: (el) => {
        const titleA = el.querySelector('h2 a, h3 a, a[href*="/jobs/"]');
        return {
          title: titleA?.textContent?.trim(),
          url: titleA?.href,
          description: el.querySelector('[data-test*="description"], p')?.textContent?.trim()?.substring(0, 3000),
          budget: el.querySelector('[data-test*="budget"], [data-testid*="budget"]')?.textContent?.trim(),
          country: el.querySelector('[data-test*="country"], [data-testid*="location"]')?.textContent?.trim(),
          skills: Array.from(el.querySelectorAll('[data-test*="skill"], .air3-token')).map(s => s.textContent.trim()).filter(Boolean).slice(0, 20)
        };
      }
    },
    {
      name: 'class-based',
      find: () => document.querySelectorAll('.job-tile, [class*="JobTile"], [class*="job-tile"]'),
      extract: (el) => {
        const titleA = el.querySelector('a[href*="/jobs/"]');
        return {
          title: titleA?.textContent?.trim() || el.querySelector('h2, h3, h4')?.textContent?.trim(),
          url: titleA?.href,
          description: el.querySelector('[class*="description"], p')?.textContent?.trim()?.substring(0, 3000),
          budget: el.querySelector('[class*="budget"], [class*="Budget"]')?.textContent?.trim(),
          country: el.querySelector('[class*="country"], [class*="Location"]')?.textContent?.trim(),
          skills: Array.from(el.querySelectorAll('[class*="token"], [class*="Skill"]')).map(s => s.textContent.trim()).filter(Boolean).slice(0, 20)
        };
      }
    },
    {
      name: 'semantic',
      find: () => {
        const arr = document.querySelectorAll('article, section, li');
        return Array.from(arr).filter(el => el.querySelector('a[href*="/jobs/"]') && el.textContent.trim().length > 100);
      },
      extract: (el) => {
        const a = el.querySelector('a[href*="/jobs/"]');
        return {
          title: a?.textContent?.trim(), url: a?.href,
          description: el.textContent?.trim().substring(0, 1000),
          budget: null, country: null, skills: []
        };
      }
    }
  ];

  function tryStrategies(strategies, minCount = 1) {
    for (const s of strategies) {
      try {
        const arr = Array.from(s.find());
        if (arr.length >= minCount) return { strategy: s.name, elements: arr, extract: s.extract };
      } catch (e) { warn(`Strategy ${s.name} threw:`, e.message); }
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  // MESSAGES HANDLER
  // ═══════════════════════════════════════════════════════════

  async function handleMessages() {
    const roomId = extractRoomId();
    const clientName = getClientName();

    const result = tryStrategies(MESSAGE_STRATEGIES, 1);
    if (!result) {
      const sample = document.querySelector('main')?.outerHTML || document.body?.outerHTML?.substring(0, 10000);
      reportBroken('messages', sample);
      return;
    }

    const seen = getSeenSet('messages');
    const newOnes = [];

    for (const el of result.elements) {
      try {
        const data = result.extract(el);
        if (!data.text || data.text.length < 3 || data.text.length > 5000) continue;
        // Skip UI trash
        if (data.text === 'More options' || data.text === 'Show more' || data.text.startsWith('View ')) continue;

        const fingerprint = hash((roomId || clientName || 'x') + '|' + data.text.substring(0, 150));
        if (seen.has(fingerprint)) continue;

        // Skip old messages on page load (>30min)
        if (data.timestamp) {
          const age = Date.now() - new Date(data.timestamp).getTime();
          if (age > 30 * 60 * 1000) { addSeen('messages', fingerprint); continue; }
        }

        // Skip own messages (outbound)
        if (data.is_own) { addSeen('messages', fingerprint); continue; }

        addSeen('messages', fingerprint);
        newOnes.push({ text: data.text, timestamp: data.timestamp, roomId });
      } catch (e) { warn('Msg extract error:', e); }
    }

    if (newOnes.length > 0) {
      log(`📨 ${newOnes.length} new messages via ${result.strategy}`);
      reportSuccess('messages', result.strategy, result.elements.length);

      for (const m of newOnes) {
        chrome.runtime.sendMessage({
          type: 'INBOUND_MESSAGE',
          payload: {
            client_name: clientName,
            client_message: m.text,
            chat_url: location.href,
            message_timestamp: m.timestamp || new Date().toISOString()
          }
        }).catch(() => {});
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // JOB CARDS HANDLER
  // ═══════════════════════════════════════════════════════════

  async function handleJobCards() {
    if (!/\/nx\/search\/jobs/.test(location.pathname)) return;

    const { cachedIdentity } = await chrome.storage.local.get('cachedIdentity');
    if (!cachedIdentity?.member?.is_bidding_enabled) return;  // Dima=lead skips

    const result = tryStrategies(JOB_STRATEGIES, 3);
    if (!result) {
      const sample = document.querySelector('main')?.outerHTML || document.body?.outerHTML?.substring(0, 10000);
      reportBroken('jobs_search', sample);
      return;
    }

    const seen = getSeenSet('jobs');
    const newJobs = [];

    for (const el of result.elements) {
      try {
        const data = result.extract(el);
        if (!data.title || !data.url) continue;
        const jobId = data.url.match(/~[\w]+/)?.[0] || hash(data.url);
        if (seen.has(jobId)) continue;

        addSeen('jobs', jobId);
        newJobs.push({
          upwork_id: jobId, title: data.title.substring(0, 500), url: data.url,
          description: (data.description || '').substring(0, 5000),
          budget_raw: data.budget, client_country: data.country,
          skills: data.skills || []
        });
      } catch (e) { warn('Job extract error:', e); }
    }

    if (newJobs.length > 0) {
      log(`💼 ${newJobs.length} new jobs via ${result.strategy}`);
      reportSuccess('jobs_search', result.strategy, result.elements.length);
      for (const j of newJobs.slice(0, 5)) {
        chrome.runtime.sendMessage({ type: 'JOB_SCRAPED', payload: j }).catch(() => {});
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // OBSERVERS & SPA NAVIGATION
  // ═══════════════════════════════════════════════════════════

  let debounceTimer = null;
  function debouncedRun() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const pt = getPageType();
      if (pt === 'messages') handleMessages();
      else if (pt === 'jobs_search') handleJobCards();
    }, 1500);
  }

  const observer = new MutationObserver((mutations) => {
    const hasStructural = mutations.some(m => m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0));
    if (hasStructural) debouncedRun();
  });

  function startObserving() {
    try {
      const target = document.querySelector('main') || document.body;
      if (target) {
        observer.observe(target, { childList: true, subtree: true });
        log('👁️ MutationObserver on', target.tagName);
      }
    } catch (e) { warn('Observer start failed:', e); }
  }

  // SPA navigation watcher
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; debouncedRun(); }
  }, 1000);

  // Periodic safety re-check
  setInterval(() => debouncedRun(), 30000);

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(() => { startObserving(); debouncedRun(); }, 2000);
  } else {
    window.addEventListener('DOMContentLoaded', () => setTimeout(() => { startObserving(); debouncedRun(); }, 2000));
  }

  log('✅ Content script loaded v' + EXT_VERSION);
})();
