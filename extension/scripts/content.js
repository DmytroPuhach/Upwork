
// OptimizeUp Extension v17.1.3 — Content Script
// v17.1.3: no functional change here — background.js now applies a search-page
// prematch against blocked_countries (using client_country we already send)
// and attaches prematch_reason to the ingest_only call. enrich.js now also
// sends title so dashboard rows stop showing "unknown".
// v17.1.0: emits JOBS_CANDIDATES so background.js can pre-rank + enqueue top-N
// for background-tab enrichment (full description / client stats). The legacy
// JOB_SCRAPED path stays for DB-ingest (funnel tracking), but scoring is now
// deferred until enrichment completes server-side.

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
    if (/\/nx\/find-work/.test(p)) return 'jobs_search';
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
    // v17.1.0 Fix C: Cloudflare challenge pages trigger a false 'broken' event
    // for ~15-40 seconds. If we had a selector_success on this page_type in
    // the last 5 minutes, suppress the broken alert entirely.
    try {
      const key = `ou_last_success_${pageType}`;
      const last = parseInt(sessionStorage.getItem(key) || '0');
      if (last && Date.now() - last < 5 * 60 * 1000) {
        log(`⏭️ skip selector_broken alert (success ${Math.round((Date.now()-last)/1000)}s ago — likely Cloudflare)`);
        return;
      }
    } catch {}
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
  // BUDGET PARSING (new in v17.0.4)
  // ═══════════════════════════════════════════════════════════

  function parseBudget(raw) {
    if (!raw) return { type: null, min: null, max: null };
    const r = raw.toLowerCase();
    const hourlyRange = r.match(/\$\s*([\d.,]+)\s*[-\u2013]\s*\$?\s*([\d.,]+)\s*(?:\/\s*h|hr|hour|hourly)/);
    if (hourlyRange) return { type: 'hourly', min: parseFloat(hourlyRange[1].replace(/,/g, '')), max: parseFloat(hourlyRange[2].replace(/,/g, '')) };
    const hourlySingle = r.match(/\$\s*([\d.,]+)\s*(?:\/\s*h|hr|hour|hourly)/);
    if (hourlySingle) { const v = parseFloat(hourlySingle[1].replace(/,/g, '')); return { type: 'hourly', min: v, max: v }; }
    const fixedRange = r.match(/\$\s*([\d.,]+)\s*[-\u2013]\s*\$?\s*([\d.,]+)/);
    if (fixedRange) return { type: 'fixed', min: parseFloat(fixedRange[1].replace(/,/g, '')), max: parseFloat(fixedRange[2].replace(/,/g, '')) };
    const fixedSingle = r.match(/\$\s*([\d.,]+)/);
    if (fixedSingle) { const v = parseFloat(fixedSingle[1].replace(/,/g, '')); return { type: 'fixed', min: v, max: v }; }
    return { type: null, min: null, max: null };
  }

  // ═══════════════════════════════════════════════════════════
  // MESSAGE SELECTORS
  // ═══════════════════════════════════════════════════════════

  const MESSAGE_STRATEGIES = [
    {
      name: 'v1-proven',
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
      name: 'air3',
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

  // ═══════════════════════════════════════════════════════════
  // v17.1.5 — EXTENDED CARD EXTRACTION
  // На search card Upwork показывает не только title/country/budget,
  // но и client rating, spent-to-date, payment verified, posted-time.
  // Достаём всё доступное — это сырьё для client-side prematch.
  // ═══════════════════════════════════════════════════════════

  function extractCardHints(el) {
    const rawText = (el.textContent || '').replace(/\s+/g, ' ').trim();
    const out = {
      client_rating: null,
      client_spent_rough: null,
      payment_verified: null,
      posted_ago_min: null,
      // v17.1.6: matched_skills / total_skills из .air3-token
      matched_skills: 0,
      total_skills: 0,
      matched_skill_names: [],
    };

    // v17.1.6: Skills overlap — Upwork помечает matched skills CSS классом
    // `.highlight-color` на span внутри `.air3-token`. Считаем matched vs total.
    try {
      const tokens = el.querySelectorAll('.air3-token');
      for (const tok of tokens) {
        const spans = tok.querySelectorAll('span');
        if (spans.length === 0) continue;
        const skillName = (spans[0].textContent || '').trim();
        if (!skillName || skillName.length > 80) continue;
        out.total_skills += 1;
        const hasHighlight = tok.querySelector('.highlight-color') !== null;
        if (hasHighlight) {
          out.matched_skills += 1;
          if (out.matched_skill_names.length < 10) {
            out.matched_skill_names.push(skillName);
          }
        }
      }
    } catch (e) { warn('skill overlap extract fail:', e?.message); }

    // Rating — 2 стратегии (v17.1.6: убран raw-text regex fallback — давал FP)
    const ratingEl = el.querySelector('[class*="RatingStars"] .air3-rating-value, .air3-rating-value');
    if (ratingEl) {
      const n = parseFloat((ratingEl.textContent || '').trim());
      if (!isNaN(n) && n >= 1 && n <= 5) out.client_rating = n;
    }
    if (out.client_rating == null) {
      const aria = el.querySelector('[aria-label*="Rating is"]')?.getAttribute('aria-label') || '';
      const m = aria.match(/([\d.]+)\s*out of 5/i);
      if (m) {
        const n = parseFloat(m[1]);
        if (n >= 1 && n <= 5) out.client_rating = n;
      }
    }

    // Total spent
    const spentM = rawText.match(/\$([\d,.]+)\s*([KkMm])?\+?\s*(?:total\s+)?spent/i);
    if (spentM) {
      const n = parseFloat(spentM[1].replace(/,/g, ''));
      if (!isNaN(n)) {
        const mult = spentM[2]?.toLowerCase() === 'k' ? 1000 : spentM[2]?.toLowerCase() === 'm' ? 1000000 : 1;
        out.client_spent_rough = n * mult;
      }
    }

    if (/Payment method verified|Payment\s+verified/i.test(rawText)) out.payment_verified = true;
    else if (/Payment (method )?not verified|Payment unverified/i.test(rawText)) out.payment_verified = false;

    const postedM = rawText.match(/Posted\s+(\d+)\s+(minute|hour|day|week)s?\s+ago/i);
    if (postedM) {
      const n = parseInt(postedM[1]);
      const unit = postedM[2].toLowerCase();
      out.posted_ago_min =
        unit === 'minute' ? n :
        unit === 'hour' ? n * 60 :
        unit === 'day' ? n * 1440 : n * 10080;
    } else if (/Posted\s+yesterday/i.test(rawText)) {
      out.posted_ago_min = 1440;
    } else if (/Posted\s+just now|Posted\s+a\s+(minute|few minutes)\s+ago/i.test(rawText)) {
      out.posted_ago_min = 1;
    }

    return out;
  }

  // ═══════════════════════════════════════════════════════════
  // v17.1.5 — CLIENT-SIDE PREMATCH
  // Rule-based, no AI. Цель: не тратить enrichment слот (rate cap 5/hr)
  // на jobs которые всё равно отвалятся на полном match. Решения:
  //   { action: 'enqueue' }              — отправить в enrichment queue
  //   { action: 'skip', reason: '...' }  — ingest_only + match_scores skip row
  //
  // Причины (все попадают в dashboard как "skip: <reason>"):
  //   country, title_employment, title_agency, title_pure_content,
  //   title_call_heavy, off_niche, budget_too_low, rating_too_low, too_old
  // ═══════════════════════════════════════════════════════════

  // v17.1.7 philosophy: SPEED > PRECISION. Первый подавшийся на job получает
  // ~80% успеха — по бизнес-данным Димы. Prematch режет ТОЛЬКО абсолютные
  // no-go (country, employment, agency, pure content). Всё сомнительное
  // (низкий budget + matching, off-niche без skills, etc) → идёт в Match Agent
  // который читает full description и решает обоснованно.
  //
  // Изменения от v17.1.6:
  //   - budget_too_low РЕЖЕМ только если matched=0 AND нет broadSeo keyword
  //   - off_niche: если total=0 AND matched=0 (chips не извлечены) → НЕ режем
  //   - off_niche fallback по title tokens — сохраняем, но только если total=0
  //     AND нет broadSeo AND niche вообще не пересекается со spec
  function prematchDecide(job, spec, blockedCountries) {
    const title = (job.title || '').toLowerCase();
    const desc = (job.description || '').toLowerCase();
    const country = (job.client_country || '').toLowerCase().trim();

    const matched = Number(job.matched_skills) || 0;
    const total = Number(job.total_skills) || 0;
    const broadSeo = /\bseo\b|\baudit\b|\brank\b|\bgoogle\b|\btraffic\b|\bkeyword\b|\bserp\b|\bsearch engine\b|\blink\s+building\b|\bbacklink\b|\boutreach\b|\bcontent optimization\b|\bon[-\s]page\b|\boff[-\s]page\b|\bindex/.test(title + ' ' + desc);

    // 1. Country blocked — hard no-go
    if (country && Array.isArray(blockedCountries) && blockedCountries.length > 0) {
      const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
      const cn = norm(country);
      if (cn.length >= 2) {
        for (const bc of blockedCountries) {
          const bcn = norm(bc);
          if (!bcn || bcn.length < 2) continue;
          if (cn === bcn || (cn.length >= 3 && bcn.length >= 3 && (cn.includes(bcn) || bcn.includes(cn)))) {
            return { action: 'skip', reason: 'country' };
          }
        }
      }
    }

    // 2. Title stopwords — hard no-go (employment / agency / pure_content / call_heavy)
    if (/\bjunior\s+seo|\bentry[-\s]level|full[-\s]time\s+seo|seo\s+assistant|seo\s+administrator/.test(title)) {
      return { action: 'skip', reason: 'title_employment' };
    }
    if (/white[-\s]label|freelancers?\s+to\s+join|contractor\s+pool|for\s+our\s+agency|join\s+our\s+agency/.test(title + ' ' + desc)) {
      return { action: 'skip', reason: 'title_agency' };
    }
    if (/^(blog writer|article writer|content writer|copywriter)\b/.test(title) &&
        !/\bseo\b|\baudit\b|\bkeyword\b|\brank\b/.test(title + ' ' + desc)) {
      return { action: 'skip', reason: 'title_pure_content' };
    }
    if (/30[-\s]minute consultation|paid consultation|coaching session|strategy call only/.test(title + ' ' + desc)) {
      return { action: 'skip', reason: 'title_call_heavy' };
    }

    // 3. Off_niche — режем ТОЛЬКО если skills извлечены AND matched=0 AND title без broadSeo
    // Если chips не извлеклись (total=0) — НЕ режем, пусть Match Agent решает с full desc.
    if (total > 0 && matched === 0 && !broadSeo) {
      return { action: 'skip', reason: 'off_niche' };
    }

    // 4. Budget_too_low — режем только если НЕТ matching signals AND budget мусорный
    // v17.1.7: свежак с matched_skills>=2 может быть "пробный туз" клиента с низким
    // budget — ты первый, offer roadmap для большого проекта, входишь в контракт.
    // Не режем если есть ЛЮБОЙ positive signal.
    if (job.budget_type === 'fixed' && typeof job.budget_max === 'number' &&
        job.budget_max > 0 && job.budget_max < 30) {
      const hasHistory = typeof job.client_spent_rough === 'number' && job.client_spent_rough > 500;
      const hasMatching = matched >= 1;  // Upwork сам отметил skill overlap
      const hasBroadSeo = broadSeo;      // title/desc упоминает SEO
      if (!hasHistory && !hasMatching && !hasBroadSeo) {
        return { action: 'skip', reason: 'budget_too_low' };
      }
    }

    // 5. Rating_too_low — режем только явно низкий (<3.5). Null rating пропускаем.
    if (typeof job.client_rating === 'number' && job.client_rating > 0 && job.client_rating < 3.5) {
      return { action: 'skip', reason: 'rating_too_low' };
    }

    // 6. Too_old — режем только если >60 мин AND нет жирного клиента AND нет matching
    if (typeof job.posted_ago_min === 'number' && job.posted_ago_min > 60) {
      const hasFatClient = typeof job.client_spent_rough === 'number' && job.client_spent_rough >= 5000;
      const hasMatching = matched >= 2;  // сильный signal переопределяет age
      if (!hasFatClient && !hasMatching) {
        return { action: 'skip', reason: 'too_old' };
      }
    }

    return { action: 'enqueue' };
  }

  const JOB_STRATEGIES = [
    {
      name: 'testid',
      find: () => document.querySelectorAll('[data-testid*="job-tile"], article[data-ev-sublocation-str*="job"]'),
      extract: (el) => {
        const titleA = el.querySelector('h2 a, h3 a, a[href*="/jobs/"]');
        // v17.1.5: country fallback chain — 4 стратегии
        let country = el.querySelector('[data-test*="country"], [data-testid*="location"], [data-test*="location"]')?.textContent?.trim()
                   || el.querySelector('[aria-label*="Location"]')?.getAttribute('aria-label')?.replace(/^Location[:\s]+/i, '').trim()
                   || null;
        if (!country) {
          // Regex fallback — countries обычно в конце карточки после client stats
          const m = (el.textContent || '').match(/(United States|United Kingdom|USA|UK|Canada|Australia|Germany|France|Switzerland|Netherlands|Spain|Italy|Sweden|Norway|Denmark|Finland|Belgium|Austria|Ireland|New Zealand|Singapore|Japan|United Arab Emirates|UAE|Israel|India|Pakistan|Bangladesh|Philippines|Vietnam|Indonesia|Nigeria|Kenya|Egypt|Morocco|Turkey|Brazil|Mexico|Argentina)\b/);
          if (m) country = m[1];
        }
        const hints = extractCardHints(el);
        return {
          title: titleA?.textContent?.trim(),
          url: titleA?.href,
          description: el.querySelector('[data-test*="description"], p')?.textContent?.trim()?.substring(0, 3000),
          budget: el.querySelector('[data-test*="budget"], [data-testid*="budget"]')?.textContent?.trim(),
          country,
          skills: Array.from(el.querySelectorAll('[data-test*="skill"], .air3-token')).map(s => s.textContent.trim()).filter(Boolean).slice(0, 20),
          raw_text: el.textContent?.trim()?.substring(0, 5000),
          ...hints,
        };
      }
    },
    {
      name: 'class-based',
      find: () => document.querySelectorAll('.job-tile, [class*="JobTile"], [class*="job-tile"]'),
      extract: (el) => {
        const titleA = el.querySelector('a[href*="/jobs/"]');
        let country = el.querySelector('[class*="country"], [class*="Location"]')?.textContent?.trim() || null;
        if (!country) {
          const m = (el.textContent || '').match(/(United States|United Kingdom|USA|UK|Canada|Australia|Germany|France|Switzerland|Netherlands|India|Pakistan|Bangladesh|Philippines)\b/);
          if (m) country = m[1];
        }
        const hints = extractCardHints(el);
        return {
          title: titleA?.textContent?.trim() || el.querySelector('h2, h3, h4')?.textContent?.trim(),
          url: titleA?.href,
          description: el.querySelector('[class*="description"], p')?.textContent?.trim()?.substring(0, 3000),
          budget: el.querySelector('[class*="budget"], [class*="Budget"]')?.textContent?.trim(),
          country,
          skills: Array.from(el.querySelectorAll('[class*="token"], [class*="Skill"]')).map(s => s.textContent.trim()).filter(Boolean).slice(0, 20),
          raw_text: el.textContent?.trim()?.substring(0, 5000),
          ...hints,
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
        const hints = extractCardHints(el);
        return {
          title: a?.textContent?.trim(), url: a?.href,
          description: el.textContent?.trim().substring(0, 1000),
          budget: null, country: null, skills: [],
          raw_text: el.textContent?.trim()?.substring(0, 5000),
          ...hints,
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

  // NEW v17.0.4: Extract stable Upwork job ID from URL
  function extractJobId(url) {
    if (!url) return null;
    const m = url.match(/~[\w]{15,25}/);
    return m ? m[0] : null;
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
        if (data.text === 'More options' || data.text === 'Show more' || data.text.startsWith('View ')) continue;

        const fingerprint = hash((roomId || clientName || 'x') + '|' + data.text.substring(0, 150));
        if (seen.has(fingerprint)) continue;

        if (data.timestamp) {
          const age = Date.now() - new Date(data.timestamp).getTime();
          if (age > 30 * 60 * 1000) { addSeen('messages', fingerprint); continue; }
        }

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
  // JOB CARDS HANDLER — v17.0.4 enhanced dedup + mutex
  // ═══════════════════════════════════════════════════════════

  let jobsInFlight = false;

  async function handleJobCards() {
    if (jobsInFlight) return;
    if (!/\/nx\/(search\/jobs|find-work)/.test(location.pathname)) return;

    const { cachedIdentity } = await chrome.storage.local.get('cachedIdentity');
    if (!cachedIdentity?.member?.is_bidding_enabled) return;

    jobsInFlight = true;
    try {
      const result = tryStrategies(JOB_STRATEGIES, 3);
      if (!result) {
        const sample = document.querySelector('main')?.outerHTML || document.body?.outerHTML?.substring(0, 10000);
        reportBroken('jobs_search', sample);
        return;
      }

      const seen = getSeenSet('jobs');
      const newJobs = [];
      const skippedByPrematch = [];  // v17.1.5: для логирования в dashboard

      // v17.1.5: достаём spec + blocked_countries один раз, переиспользуем в цикле
      const { cachedIdentity: identity } = await chrome.storage.local.get('cachedIdentity');
      const accountSpec = identity?.account?.specialization || identity?.member?.specialization || [];
      const blockedCountries = identity?.account?.blocked_countries || identity?.member?.blocked_countries || [];

      for (const el of result.elements) {
        try {
          const data = result.extract(el);
          if (!data.title || !data.url) continue;

          const upworkId = extractJobId(data.url);
          const fingerprint = upworkId || hash((data.title || '').substring(0, 100) + '|' + (data.url || '').substring(0, 200));
          if (seen.has(fingerprint)) continue;

          addSeen('jobs', fingerprint);

          const budget = parseBudget(data.budget || data.raw_text || '');

          const jobPayload = {
            upwork_id: upworkId || fingerprint,
            title: data.title.substring(0, 500),
            url: data.url,
            description: (data.description || data.raw_text || '').substring(0, 5000),
            budget_raw: data.budget,
            budget_type: budget.type,
            budget_min: budget.min,
            budget_max: budget.max,
            client_country: data.country,
            // v17.1.5: new hints from search card — used by prematch & dashboard
            client_rating: data.client_rating ?? null,
            client_spent_rough: data.client_spent_rough ?? null,
            payment_verified: data.payment_verified ?? null,
            posted_ago_min: data.posted_ago_min ?? null,
            // v17.1.6: Upwork matched skills (.highlight-color)
            matched_skills: data.matched_skills ?? 0,
            total_skills: data.total_skills ?? 0,
            matched_skill_names: data.matched_skill_names || [],
            skills: data.skills || []
          };

          // v17.1.5: client-side prematch. Skip = не тратим enrichment слот.
          const verdict = prematchDecide(jobPayload, accountSpec, blockedCountries);
          if (verdict.action === 'skip') {
            skippedByPrematch.push({ job: jobPayload, reason: verdict.reason });
          } else {
            newJobs.push(jobPayload);
          }
        } catch (e) { warn('Job extract error:', e); }
      }

      // v17.1.5: отправляем skipped jobs как ingest_only с prematch_reason.
      // Эти сразу попадают в match_scores как 'skip' с detected_stop_reason,
      // и видны в дашборде с понятной причиной вместо молчаливого 'pending'.
      for (const s of skippedByPrematch) {
        chrome.runtime.sendMessage({
          type: 'JOB_SCRAPED_SKIP',
          payload: { ...s.job, prematch_reason: s.reason, prematch_score: 0 }
        }).catch(() => {});
      }
      if (skippedByPrematch.length > 0) {
        log(`🚫 ${skippedByPrematch.length} jobs skipped by prematch:`,
          skippedByPrematch.map(s => s.reason).join(', '));
      }

      if (newJobs.length > 0) {
        log(`💼 ${newJobs.length} new jobs via ${result.strategy} (after prematch)`);
        reportSuccess('jobs_search', result.strategy, result.elements.length);
        for (const j of newJobs.slice(0, 10)) {
          chrome.runtime.sendMessage({ type: 'JOB_SCRAPED', payload: j }).catch(() => {});
        }
        // v17.1.0: hand off candidates to background.js for enrichment pre-rank.
        // v17.1.5: pass posted_ago_min + client_spent_rough so background can
        // prioritize queue by freshness + fat clients instead of pure FIFO.
        chrome.runtime.sendMessage({
          type: 'JOBS_CANDIDATES',
          payload: {
            jobs: newJobs.map(j => ({
              upwork_id: j.upwork_id,
              url: j.url,
              title: j.title,
              skills: j.skills,
              client_country: j.client_country,
              posted_ago_min: j.posted_ago_min,
              client_spent_rough: j.client_spent_rough,
              matched_skills: j.matched_skills,
              total_skills: j.total_skills,
            })),
            source_url: location.href.substring(0, 300),
          }
        }).catch(() => {});
      }
    } finally {
      jobsInFlight = false;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // OBSERVERS — 3s debounce in v17.0.4 (was 1.5s)
  // ═══════════════════════════════════════════════════════════

  let debounceTimer = null;
  function debouncedRun() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const pt = getPageType();
      if (pt === 'messages') handleMessages();
      else if (pt === 'jobs_search') handleJobCards();
    }, 3000);
  }

  // v17.1.0: no observers on single-job pages (enrich.js runs there) or on
  // irrelevant pages. Saves CPU and avoids stray JOB_SCRAPED emissions.
  function shouldObserve() {
    const pt = getPageType();
    return pt === 'messages' || pt === 'jobs_search';
  }

  const observer = new MutationObserver((mutations) => {
    const hasStructural = mutations.some(m => m.type === 'childList' && (m.addedNodes.length > 0 || m.removedNodes.length > 0));
    if (hasStructural) debouncedRun();
  });

  function startObserving() {
    if (!shouldObserve()) {
      log('⏭️ not observing this page type');
      return;
    }
    try {
      const target = document.querySelector('main') || document.body;
      if (target) {
        observer.observe(target, { childList: true, subtree: true });
        log('👁️ MutationObserver on', target.tagName);
      }
    } catch (e) { warn('Observer start failed:', e); }
  }

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; debouncedRun(); }
  }, 1000);

  setInterval(() => debouncedRun(), 30000);

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(() => { startObserving(); debouncedRun(); }, 2000);
  } else {
    window.addEventListener('DOMContentLoaded', () => setTimeout(() => { startObserving(); debouncedRun(); }, 2000));
  }

  log('✅ Content script loaded v' + EXT_VERSION);
})();
