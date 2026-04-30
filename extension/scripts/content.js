
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
  // MESSAGE SELECTORS — v17.3.0 (correct DOM mapping)
  //
  // Real Upwork chat structure (verified Apr 2026):
  //   .up-d-story-item[id^="story_HASH"]
  //     ├── .story-day-header (optional, day separator only)
  //     └── [data-test="story-container"]
  //         ├── [data-test="story-header"]    ← present on FIRST msg of a batch from same author
  //         │   ├── .user-name                ← AUTHOR (same selector for both sides!)
  //         │   └── .story-timestamp[title]   ← full ISO timestamp in `title`
  //         ├── .story-message
  //         │   └── [data-test="story-message"]
  //         │       └── <p> ... <span class="end-of-message"/></p>
  //         └── .reply-wrapper (optional — quote of older msg, MUST be excluded from text)
  //
  // Continuation messages (short consecutive replies from same author) have NO
  // story-message-header — author = previous story with header.
  //
  // Direction is determined by comparing AUTHOR NAME vs known account aliases.
  // Stable id (`story_HASH`) is the dedup key — never reuses across reloads.
  // ═══════════════════════════════════════════════════════════

  // Returns clean text from a story, EXCLUDING anything inside .reply-wrapper / .quote-attachment.
  function extractStoryText(storyEl) {
    const msgEl = storyEl.querySelector('[data-test="story-message"]');
    if (!msgEl) return '';
    // Walk only direct/relevant <p> not under reply-wrapper or quote
    const paragraphs = msgEl.querySelectorAll('p');
    const parts = [];
    for (const p of paragraphs) {
      if (p.closest('.reply-wrapper') || p.closest('.quote-attachment') || p.closest('.quote-wrap')) continue;
      // Strip the <span class="end-of-message"></span> sentinel if present
      const clone = p.cloneNode(true);
      clone.querySelectorAll('.end-of-message').forEach(s => s.remove());
      const t = (clone.textContent || '').trim();
      if (t) parts.push(t);
    }
    return parts.join('\n').trim();
  }

  function extractStoryTimestamp(storyEl) {
    // Prefer full ISO from title attribute on .story-timestamp ("April 20, 2026 at 2:07 PM")
    const ts = storyEl.querySelector('[data-test="story-header"] .story-timestamp');
    const title = ts?.getAttribute('title');
    if (title) {
      // Parse "April 20, 2026 at 2:07 PM" -> ISO
      const cleaned = title.replace(' at ', ' ');
      const d = new Date(cleaned);
      if (!isNaN(d.getTime())) return d.toISOString();
    }
    // Fallback: short "9:22 PM" — won't have date, return null (server fills now())
    return null;
  }

  function extractStoryAuthor(storyEl) {
    return storyEl.querySelector('[data-test="story-header"] .user-name')?.textContent?.trim() || null;
  }

  function isStoryDeleted(storyEl) {
    return !!storyEl.querySelector('.story-message.deleted');
  }

  // MAIN extractor — replaces the strategies-based approach with a stable structural walk.
  function extractAllStories() {
    const stories = document.querySelectorAll('[id^="story_"]');
    const out = [];
    let lastAuthor = null;
    let lastTimestamp = null;

    for (const storyEl of stories) {
      try {
        if (isStoryDeleted(storyEl)) continue;

        const text = extractStoryText(storyEl);
        if (!text || text.length < 2 || text.length > 8000) continue;

        // Author: from header if present, else inherit from previous story (continuation)
        const headerAuthor = extractStoryAuthor(storyEl);
        const author = headerAuthor || lastAuthor;
        if (headerAuthor) lastAuthor = headerAuthor;

        // Timestamp: same logic — inherit if missing
        const headerTs = extractStoryTimestamp(storyEl);
        const timestamp = headerTs || lastTimestamp || new Date().toISOString();
        if (headerTs) lastTimestamp = headerTs;

        // Stable story id (Upwork's own hash) — best dedup key we can have
        const storyId = storyEl.id || null;

        out.push({
          story_id: storyId,
          author,
          text,
          timestamp,
        });
      } catch (e) {
        warn('story extract fail:', e?.message);
      }
    }
    return out;
  }

  // Direction detection: compare extracted author name with known account aliases.
  // The currently signed-in account is whoever's profile is open in this tab.
  // We get that from cachedIdentity (filled by background.js identify()).
  // Fallback: also try DOM avatar aria-label / sidebar profile name.
  function getOwnNameAliases(cachedIdentity) {
    const aliases = new Set();
    // Root-level fields (legacy path — some edge fn versions flatten these)
    if (cachedIdentity?.upwork_user_name) aliases.add(cachedIdentity.upwork_user_name.trim());
    if (cachedIdentity?.full_name) aliases.add(cachedIdentity.full_name.trim());
    if (cachedIdentity?.first_name) aliases.add(cachedIdentity.first_name.trim());
    if (Array.isArray(cachedIdentity?.aliases)) cachedIdentity.aliases.forEach(a => a && aliases.add(a.trim()));
    // v17.5.1 fix: cachedIdentity is actually { member: {...}, account: {...} }
    // The root-level fields above are always undefined — read from member/account instead.
    const m = cachedIdentity?.member;
    if (m?.slug) aliases.add(m.slug.trim());               // "david" / "davyd"
    if (m?.name) aliases.add(m.name.trim());               // display name if present
    if (m?.full_name) aliases.add(m.full_name.trim());
    if (m?.first_name) aliases.add(m.first_name.trim());
    if (m?.upwork_user_name) aliases.add(m.upwork_user_name.trim());
    if (Array.isArray(m?.aliases)) m.aliases.forEach(a => a && aliases.add(a.trim()));
    const acc = cachedIdentity?.account;
    if (acc?.name) aliases.add(acc.name.trim());           // "Давид" — works for Cyrillic too
    if (acc?.slug) aliases.add(acc.slug.trim());
    // DOM fallback: top-right avatar / side nav (messages page uses different selectors)
    const domName =
      document.querySelector('[data-test="profile-name"]')?.textContent?.trim()
      || document.querySelector('[class*="user-menu"] [class*="name"]')?.textContent?.trim()
      || document.querySelector('header [aria-label*="avatar" i]')?.getAttribute('aria-label');
    if (domName) aliases.add(domName.trim());
    return aliases;
  }

  function classifyDirection(authorName, ownAliases) {
    if (!authorName) return 'unknown';
    const name = authorName.trim();
    for (const own of ownAliases) {
      if (!own) continue;
      // Exact match OR first-name match (Dmytro / Dima / David / Davyd)
      if (name === own) return 'outbound';
      const ownFirst = own.split(/\s+/)[0].toLowerCase();
      const authorFirst = name.split(/\s+/)[0].toLowerCase();
      if (ownFirst.length >= 3 && ownFirst === authorFirst) return 'outbound';
    }
    return 'inbound';
  }

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
  //   title_call_heavy, native_required, training_role,
  //   off_niche, budget_too_low, rating_too_low, too_old
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
    if (/\b(?:content|blog|article|seo\s+content)\s+writer\b|\bcopywriter\b/.test(title)) {
      return { action: 'skip', reason: 'title_pure_content' };
    }
    if (/30[-\s]minute consultation|paid consultation|coaching session|strategy call only/.test(title + ' ' + desc)) {
      return { action: 'skip', reason: 'title_call_heavy' };
    }
    // Native language required — we don't qualify
    if (/\bnative\s+(?:english|spanish|french|german|arabic|italian|portuguese|dutch|polish|language)\b|\bnative[-\s]level\s+\w+/.test(title + ' ' + desc)) {
      return { action: 'skip', reason: 'native_required' };
    }
    // Training/coaching role — implies calls, waste of time
    if (/\btraining\b|\bcoaching\b|\bmentoring\b/.test(title)) {
      return { action: 'skip', reason: 'training_role' };
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

    // 5. Rating_too_low — режем только явно низкий (<3.0). Null rating пропускаем.
    if (typeof job.client_rating === 'number' && job.client_rating > 0 && job.client_rating < 3.0) {
      return { action: 'skip', reason: 'rating_too_low' };
    }

    // 6. Too_old — v17.2.0 FRESH FIRST: >30 min = skip, никаких исключений.
    // Старые вакансии = 50+ proposals = Top Rated уже там. Смысла нет.
    // Если >30 min висит — либо никто нормальный не идёт (мусор), либо толпа (мы не конкурент).
    if (typeof job.posted_ago_min === 'number' && job.posted_ago_min > 30) {
      return { action: 'skip', reason: 'too_old' };
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

    const stories = extractAllStories();
    if (!stories.length) {
      const sample = document.querySelector('main')?.outerHTML || document.body?.outerHTML?.substring(0, 10000);
      reportBroken('messages', sample);
      return;
    }

    // Need own identity to classify direction
    const { cachedIdentity } = await chrome.storage.local.get('cachedIdentity');
    const ownAliases = getOwnNameAliases(cachedIdentity);

    const seen = getSeenSet('messages');
    const newMessages = [];

    for (const story of stories) {
      try {
        // Skip junk
        if (story.text === 'More options' || story.text === 'Show more' || story.text.startsWith('View ')) continue;

        // Stable Upwork-provided story id is the BEST dedup key.
        // Fallback: hash by room+text if id missing for any reason.
        const dedupKey = story.story_id
          ? `sid:${story.story_id}`
          : `txt:${hash((roomId || clientName || 'x') + '|' + story.text.substring(0, 150))}`;
        if (seen.has(dedupKey)) continue;
        addSeen('messages', dedupKey);

        // Skip messages older than 30 min — historical bulk dump on first chat open
        // is what poisoned the DB before. We only forward FRESH ones.
        if (story.timestamp) {
          const age = Date.now() - new Date(story.timestamp).getTime();
          if (age > 30 * 60 * 1000) continue;
        }

        const direction = classifyDirection(story.author, ownAliases);

        newMessages.push({
          story_id: story.story_id,
          author: story.author,
          direction,             // 'outbound' | 'inbound' | 'unknown'
          text: story.text,
          timestamp: story.timestamp,
          roomId,
        });
      } catch (e) {
        warn('Msg extract error:', e?.message);
      }
    }

    if (newMessages.length > 0) {
      log(`📨 ${newMessages.length} new stories — sending with direction`);
      reportSuccess('messages', 'story-walk-v17.3', stories.length);

      for (const m of newMessages) {
        // v17.5.3: save outbound to messages_context (no reply-gen), skip nothing
        if (m.direction === 'outbound') {
          log('outbound msg — saving to context only:', m.author?.substring(0, 30));
          chrome.runtime.sendMessage({
            type: 'OUTBOUND_MESSAGE',
            payload: {
              client_name: clientName,
              text: m.text,
              story_id: m.story_id,
              message_timestamp: m.timestamp,
            }
          }).catch(() => {});
          continue;
        }
        chrome.runtime.sendMessage({
          type: 'INBOUND_MESSAGE',
          payload: {
            client_name: clientName,
            client_message: m.text,
            chat_url: location.href,
            message_timestamp: m.timestamp,
            // v17.3.0 — explicit direction + author + stable story id
            direction: m.direction,
            author_name: m.author,
            story_id: m.story_id,
            account_aliases_count: ownAliases.size,
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

