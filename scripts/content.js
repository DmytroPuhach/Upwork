
// OptimizeUp Extension v18.2.0 — Content Script
// v18.2.0: operator-gated AI — prematch-passed jobs render as LIGHT cards (search data only, no tab/Claude).
//   🔍 Analyze → ANALYZE_JOB → background opens job + enrich + score → row upgrades to scored (accounts+Cover).
//   Keyed by upwork_id. No more auto JOBS_CANDIDATES pipeline.
// v18.1.3: panel = JOB FEED (compact: score+title+👁+✕, accounts/Cover on row-expand), DRAGGABLE,
//   default bottom-right (position remembered). Statuses: pending=green, skip=struck, sent=green-struck
//   (rows persist as a decision log, not removed). Stats bar kept.
// v18.1.2: panel moved LEFT + static (always visible on search page, even empty) with stats bar.
// v18.1.1: panel persists across auto-reload (chrome.storage); two-step flow — "Просмотр" (open job)
//   then "Cover →" generates only on explicit click; Skip drops the card from storage.
// v18.1.0: STEP 2B — operator panel (floating widget). Renders PANEL_CARD from background
//   (enriched+scored job), operator ticks accounts + Approve → APPROVE_COVERS → generate_cover×N.
//   The ONLY UI surface; dormant unless background (RADAR_BUILD) pushes cards.
// v18.0.9: fixed-price budget amount from [data-test="is-fixed-price"] (job-type-label has type only
//   for fixed); combined with job-type-label so parseBudget gets the amount without raw_text pollution.
// v18.0.8: JOB_STRATEGIES collapsed to ONE strategy (data-test="JobTile") — removed dead testid +
//   noisy class-based + semantic fallbacks. Clean break > silent noise.
// v18.0.7: new Upwork (Nuxt) search UI — JOB_STRATEGIES 'data-test' tile [data-test="JobTile"];
//   card fields via data-test (job-type-label/location/token); extractCardHints rating "Rating is X out of 5"
//   + proposals "Fewer than N".
// v18.0.4: city→country normalization in prematchDecide (Lahore→Pakistan, strips "City HH:MM PM" suffix)
// v18.0.3: broadSeo regex — removed \bgoogle\b (matched "Google Ads" = PPC), tightened to google (search|analytics|search console) + organic traffic/search
// v18.0.0: Added notifications/my_stats page types; maybeTriggerProfileSync() fires
//   PROFILE_SYNC_TRIGGER to background.js when user visits these pages.
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
    if (/\/ab\/notifications/.test(p)) return 'notifications';    // v18
    if (/\/nx\/my-stats/.test(p)) return 'my_stats';              // v18
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
    // "Hourly: $10.00 - $20.00" \u2014 Upwork search card prefix format (hourly keyword BEFORE numbers)
    const hourlyPfxRange = r.match(/hourly[:\s]+\$\s*([\d.,]+)\s*[-\u2013]\s*\$?\s*([\d.,]+)/);
    if (hourlyPfxRange) return { type: 'hourly', min: parseFloat(hourlyPfxRange[1].replace(/,/g, '')), max: parseFloat(hourlyPfxRange[2].replace(/,/g, '')) };
    const hourlyPfxSingle = r.match(/hourly[:\s]+\$\s*([\d.,]+)/);
    if (hourlyPfxSingle) { const v = parseFloat(hourlyPfxSingle[1].replace(/,/g, '')); return { type: 'hourly', min: v, max: v }; }
    // "$10.00 - $20.00 /hr" \u2014 suffix format
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
      proposals_min: null,       // v18.0.1: lower bound of proposals count range shown on card
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
    if (out.client_rating == null) {
      // v18.0.7: current Nuxt UI renders rating as text "Rating is 5.0 out of 5"
      const m = rawText.match(/Rating is\s+([\d.]+)\s+out of 5/i);
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

    // v18.0.1: proposals count from search card — used by prematch to skip crowded jobs
    // Upwork shows: "Less than 5", "5 to 10", "10 to 15", "15 to 20", "20 to 50", "50+"
    out.proposals_min = null;
    const propM = rawText.match(/Proposals?:\s*(?:(?:Less|Fewer) than\s*(\d+)|(\d+)\s*(?:to\s*\d+|\+))/i);
    if (propM) {
      // "Less than 5" → min=0; "5 to 10" or "50+" → min=first number
      out.proposals_min = propM[1] ? 0 : parseInt(propM[2], 10);
    }

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
  const CITY_COUNTRY_MAP = {
    'lahore':'Pakistan','karachi':'Pakistan','islamabad':'Pakistan','rawalpindi':'Pakistan',
    'faisalabad':'Pakistan','peshawar':'Pakistan','multan':'Pakistan','quetta':'Pakistan',
    'dhaka':'Bangladesh','chittagong':'Bangladesh','sylhet':'Bangladesh',
    'manila':'Philippines','cebu':'Philippines','davao':'Philippines','quezon city':'Philippines',
    'lagos':'Nigeria','abuja':'Nigeria','kano':'Nigeria','ibadan':'Nigeria',
    'mumbai':'India','delhi':'India','bangalore':'India','hyderabad':'India',
    'chennai':'India','kolkata':'India','pune':'India','ahmedabad':'India',
    'jakarta':'Indonesia','surabaya':'Indonesia','bandung':'Indonesia',
    'cairo':'Egypt','alexandria':'Egypt',
    'casablanca':'Morocco','rabat':'Morocco',
    'nairobi':'Kenya','mombasa':'Kenya',
  };

  function resolveCountry(raw) {
    if (!raw) return '';
    // Strip trailing time like "Lahore 1:32 PM" → "Lahore"
    const noTime = raw.replace(/\s+\d{1,2}:\d{2}\s*(AM|PM)?$/i, '').trim();
    return CITY_COUNTRY_MAP[noTime.toLowerCase()] || noTime;
  }

  function prematchDecide(job, spec, blockedCountries) {
    const title = (job.title || '').toLowerCase();
    const desc = (job.description || '').toLowerCase();
    const country = resolveCountry(job.client_country || '').toLowerCase().trim();

    const matched = Number(job.matched_skills) || 0;
    const total = Number(job.total_skills) || 0;
    const broadSeo = /\bseo\b|\baudit\b|\brank(?:ing)?\b|\bserp\b|\bsearch engine\b|\blink\s+building\b|\bbacklink\b|\boutreach\b|\bcontent optimization\b|\bon[-\s]page\b|\boff[-\s]page\b|\bindex(?:ation|ing)?\b|\bkeyword research\b|\borganic search\b|\borganic traffic\b|\bgoogle (?:search|analytics|search console)\b|\btraffic growth\b/.test(title + ' ' + desc);

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

    // 4b. Hourly rate too low — Expert SEO/GEO work under $25/hr is not viable
    if (job.budget_type === 'hourly' && typeof job.budget_max === 'number' &&
        job.budget_max > 0 && job.budget_max < 25) {
      const hasHistory = typeof job.client_spent_rough === 'number' && job.client_spent_rough > 500;
      const hasMatching = matched >= 1;
      if (!hasHistory && !hasMatching) {
        return { action: 'skip', reason: 'budget_too_low' };
      }
    }

    // 5. Rating_too_low — режем только явно низкий (<3.0). Null rating пропускаем.
    if (typeof job.client_rating === 'number' && job.client_rating > 0 && job.client_rating < 3.0) {
      return { action: 'skip', reason: 'rating_too_low' };
    }

    // 6. Too_competitive — v18.0.1: proposals_min >= 20 = skip, не тратим токены.
    // "20 to 50" на карточке = минимум 20 конкурентов уже там. Claude дорого, смысла нет.
    // proposals_min=null (не извлеклось) — не режем, пусть Match Agent решает.
    if (typeof job.proposals_min === 'number' && job.proposals_min >= 20) {
      return { action: 'skip', reason: 'too_competitive' };
    }

    // 7. Too_old — v17.2.0 FRESH FIRST: >30 min = skip, никаких исключений.
    // Старые вакансии = 50+ proposals = Top Rated уже там. Смысла нет.
    // Если >30 min висит — либо никто нормальный не идёт (мусор), либо толпа (мы не конкурент).
    if (typeof job.posted_ago_min === 'number' && job.posted_ago_min > 30) {
      return { action: 'skip', reason: 'too_old' };
    }

    return { action: 'enqueue' };
  }

  const JOB_STRATEGIES = [
    {
      // v18.0.7: current Upwork (Nuxt) search UI — cards are <article data-test="JobTile">.
      // Fields moved to data-test: job-type-label (budget), location, token (skills),
      // job-tile-title-link (title). data-testid is gone.
      name: 'data-test',
      find: () => document.querySelectorAll('article[data-test="JobTile"], [data-test="JobTile"]'),
      extract: (el) => {
        const titleA = el.querySelector('a[data-test*="job-tile-title-link"], h2 a, a[href*="/jobs/"]');
        const country = el.querySelector('[data-test="location"]')?.textContent?.trim() || null;
        // budget: job-type-label carries the HOURLY range ("Hourly: $20-$30"); for FIXED it's just
        // the word "Fixed price" and the amount lives in is-fixed-price ("Est. budget: $80.00").
        // Combine the two (NOT raw_text — that would catch "$70K+ spent").
        const jobType = el.querySelector('[data-test="job-type-label"]')?.textContent?.trim() || '';
        const fixedAmt = el.querySelector('[data-test="is-fixed-price"]')?.textContent?.trim() || '';
        const budgetText = [jobType, fixedAmt].filter(Boolean).join(' ');
        const hints = extractCardHints(el);
        return {
          title: titleA?.textContent?.trim(),
          url: titleA?.href,
          description: el.querySelector('[data-test="JobDescription"], [data-test="Description"], p')?.textContent?.trim()?.substring(0, 3000),
          budget: budgetText,
          country,
          skills: Array.from(el.querySelectorAll('[data-test="token"], .air3-token')).map(s => s.textContent.trim()).filter(Boolean).slice(0, 20),
          raw_text: el.textContent?.trim()?.substring(0, 5000),
          ...hints,
        };
      }
    }
  ];
  // v18.0.7: single strategy by design. data-test="JobTile" returns exactly the real cards.
  // No testid/class-based/semantic fallbacks — they matched noise (60 = 10 cards + 50 fragments)
  // or nothing. If Upwork changes the tile, we WANT a clean reportBroken, not silent garbage.

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
            // v18.0.1: proposals count lower bound (skip if >=20)
            proposals_min: data.proposals_min ?? null,
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

      // panel stats: detected on this scan / prematch-skipped / passed to enrichment
      recordScanStats(result.elements.length, skippedByPrematch.length, newJobs.length);

      if (newJobs.length > 0) {
        log(`💼 ${newJobs.length} new jobs via ${result.strategy} (after prematch)`);
        reportSuccess('jobs_search', result.strategy, result.elements.length);
        for (const j of newJobs.slice(0, 10)) {
          chrome.runtime.sendMessage({ type: 'JOB_SCRAPED', payload: j }).catch(() => {});   // funnel ingest only
        }
        // operator-gated: render LIGHT cards from search data (no tab, no Claude).
        // AI scoring happens later, per card, when the operator clicks Analyze.
        for (const j of newJobs.slice(0, 15)) {
          renderCard({
            upwork_id: j.upwork_id,
            url: j.url,
            title: j.title,
            budget: j.budget_raw || ((j.budget_type ? j.budget_type + ' ' : '') + (j.budget_max ? '$' + j.budget_max : '')).trim(),
            client_country: j.client_country,
            client_rating: j.client_rating,
            client_spent_rough: j.client_spent_rough,
            proposals_min: j.proposals_min,
            skills: j.skills,
            matched_skills: j.matched_skills,
            total_skills: j.total_skills,
            posted_ago_min: j.posted_ago_min,
            status: 'pending',
          });
        }
      }
    } finally {
      jobsInFlight = false;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // OBSERVERS — 3s debounce in v17.0.4 (was 1.5s)
  // ═══════════════════════════════════════════════════════════

  // v18: fire profile-sync inject for pages that carry account health data.
  // background.js injects profile-sync.js into this tab immediately — no background tab needed.
  const PROFILE_SYNC_PAGES = new Set(['notifications', 'proposal_list', 'my_stats']);
  const profileSyncTriggeredUrls = new Set();

  function maybeTriggerProfileSync() {
    const pt = getPageType();
    if (!PROFILE_SYNC_PAGES.has(pt)) return;
    const key = location.pathname.replace(/\/$/, '');
    if (profileSyncTriggeredUrls.has(key)) return;
    profileSyncTriggeredUrls.add(key);
    log(`📊 triggering profile-sync on ${pt}`);
    chrome.runtime.sendMessage({ type: 'PROFILE_SYNC_TRIGGER', payload: { page_type: pt } }).catch(() => {});
  }

  let debounceTimer = null;
  function debouncedRun() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const pt = getPageType();
      if (pt === 'messages') handleMessages();
      else if (pt === 'jobs_search') handleJobCards();
      else maybeTriggerProfileSync();
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

  // ═══════════════════════════════════════════════════════════
  // OPERATOR PANEL (2B) — radar-only floating widget.
  // Renders a card per enriched+scored job (PANEL_CARD from background).
  // Operator ticks accounts + Approve → background runs generate_cover per account.
  // This is the ONLY UI surface in the system. Dormant unless background pushes cards
  // (background only does so on RADAR_BUILD), so it never activates on teammate machines.
  // ═══════════════════════════════════════════════════════════
  const PANEL_ID = 'ou-operator-panel';

  function panelEl(tag, style, text) {
    const el = document.createElement(tag);
    if (style) el.style.cssText = style;
    if (text != null) el.textContent = text;
    return el;
  }

  // drag the panel by its header; remember position in (page) localStorage
  function makeDraggable(panel, handle) {
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const rect = panel.getBoundingClientRect();
      const offX = e.clientX - rect.left, offY = e.clientY - rect.top;
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      const move = (ev) => { panel.style.left = Math.max(0, ev.clientX - offX) + 'px'; panel.style.top = Math.max(0, ev.clientY - offY) + 'px'; };
      const up = () => {
        document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
        try { localStorage.setItem('ou_panel_pos', JSON.stringify({ left: parseInt(panel.style.left), top: parseInt(panel.style.top) })); } catch {}
      };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      e.preventDefault();
    });
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;
    // Movable feed widget — default bottom-right.
    panel = panelEl('div', `position:fixed;width:320px;max-height:78vh;z-index:2147483647;
      background:#fff;border:1px solid #d5d5d5;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.18);
      font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#001e00;display:flex;flex-direction:column;overflow:hidden;`);
    panel.id = PANEL_ID;
    panel.style.right = '16px'; panel.style.bottom = '16px';
    try { const pos = JSON.parse(localStorage.getItem('ou_panel_pos') || 'null'); if (pos && pos.left != null) { panel.style.left = pos.left + 'px'; panel.style.top = pos.top + 'px'; panel.style.right = 'auto'; panel.style.bottom = 'auto'; } } catch {}

    const header = panelEl('div', `display:flex;align-items:center;justify-content:space-between;padding:8px 11px;
      background:#14a800;color:#fff;font-weight:600;cursor:move;user-select:none;`);
    const title = panelEl('span', '', '⠿ Radar — fit feed');
    const count = panelEl('span', 'font:11px/1 monospace;opacity:.9;', '0');
    count.id = PANEL_ID + '-count';
    const left = panelEl('div', 'display:flex;gap:8px;align-items:center;');
    left.append(title, count);
    const clear = panelEl('button', `background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.5);color:#fff;border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer;`, 'Clear');
    clear.onclick = () => { const b = document.getElementById(PANEL_ID + '-body'); if (b) b.innerHTML = ''; try { chrome.storage.local.set({ [PANEL_STORE_KEY]: [] }); } catch {} updatePanelCount(); };
    header.append(left, clear);

    const stats = panelEl('div', 'padding:5px 11px;background:#f5f8f5;border-bottom:1px solid #e8eee8;font:11px/1.4 monospace;color:#3c4a3c;');
    stats.id = PANEL_ID + '-stats';
    stats.textContent = 'found 0 · skipped 0 · passed 0';

    const body = panelEl('div', 'overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:5px;flex:1;');
    body.id = PANEL_ID + '-body';
    const empty = panelEl('div', 'padding:14px 12px;color:#9aa0a6;font-size:12px;text-align:center;', 'Ждём подходящие вакансии…');
    empty.id = PANEL_ID + '-empty';
    body.append(empty);

    panel.append(header, stats, body);
    document.body.appendChild(panel);
    makeDraggable(panel, header);
    return panel;
  }

  async function updatePanelStats() {
    const el = document.getElementById(PANEL_ID + '-stats');
    if (!el) return;
    const r = await chrome.storage.local.get('ou_scan_stats');
    const s = r.ou_scan_stats || {};
    el.textContent = `found ${s.detected || 0} · skipped ${s.skipped || 0} · passed ${s.passed || 0}  (today)`;
  }

  async function recordScanStats(detected, skipped, passed) {
    const today = new Date().toDateString();
    const r = await chrome.storage.local.get('ou_scan_stats');
    let s = r.ou_scan_stats || {};
    if (s.date !== today) s = { date: today, detected: 0, skipped: 0, passed: 0 };
    s.detected += detected; s.skipped += skipped; s.passed += passed;
    await chrome.storage.local.set({ ou_scan_stats: s });
    updatePanelStats();
  }

  function updatePanelCount() {
    const body = document.getElementById(PANEL_ID + '-body');
    const count = document.getElementById(PANEL_ID + '-count');
    const empty = document.getElementById(PANEL_ID + '-empty');
    if (body && empty) empty.style.display = body.querySelectorAll('[data-ou-card]').length > 0 ? 'none' : 'block';
    if (body && count) count.textContent = String(body.querySelectorAll('[data-ou-card]').length);
  }

  // Persistence — feed survives the radar's auto-reload. Keyed by upwork_id (present light AND scored).
  const PANEL_STORE_KEY = 'ou_panel_cards';
  const cardKey = (c) => c.upwork_id || c.job_id;
  async function loadCards() {
    try { const r = await chrome.storage.local.get(PANEL_STORE_KEY); return Array.isArray(r[PANEL_STORE_KEY]) ? r[PANEL_STORE_KEY] : []; }
    catch { return []; }
  }
  async function upsertCard(card) {
    const key = cardKey(card);
    const cards = await loadCards();
    const i = cards.findIndex(c => cardKey(c) === key);
    if (i >= 0) cards[i] = { ...cards[i], ...card };
    else cards.unshift(card);
    try { await chrome.storage.local.set({ [PANEL_STORE_KEY]: cards.slice(0, 40) }); } catch {}
    return cards[i >= 0 ? i : 0];
  }
  async function patchCard(key, patch) {
    const cards = await loadCards();
    const i = cards.findIndex(c => cardKey(c) === key);
    if (i >= 0) { cards[i] = { ...cards[i], ...patch }; try { await chrome.storage.local.set({ [PANEL_STORE_KEY]: cards }); } catch {} }
  }

  // Feed row. LIGHT (no score yet): "— title 🔍 ✕", 🔍 = Analyze (opens job + AI on demand).
  // SCORED (after Analyze): "score title 👁 ✕", expand → accounts + Cover.
  // Status: pending green · skipped struck · sent (cover) green-struck. Rows persist as a decision log.
  function renderPanelCard(card, persist = true) {
    ensurePanel();
    const body = document.getElementById(PANEL_ID + '-body');
    if (!body) return;
    const key = cardKey(card);
    if (persist) upsertCard(card);
    if (body.querySelector(`[data-ou-card="${key}"]`)) return;   // already on screen

    const analyzed = card.match_score != null;
    const wrap = panelEl('div', 'border:1px solid #e4e4e4;border-left:3px solid #14a800;border-radius:6px;overflow:hidden;');
    wrap.setAttribute('data-ou-card', key);

    // ── collapsed row ──
    const head = panelEl('div', 'display:flex;align-items:center;gap:6px;padding:6px 8px;cursor:pointer;');
    const scColor = !analyzed ? '#9aa0a6' : (card.match_score >= 70 ? '#14a800' : card.match_score >= 50 ? '#b35900' : '#9aa0a6');
    const scoreBadge = panelEl('span', `font-weight:700;font-size:13px;color:${scColor};min-width:24px;text-align:center;`, analyzed ? String(card.match_score) : '—');
    const titleEl = panelEl('span', 'flex:1;font-weight:600;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', card.title || '(untitled)');
    const eye = panelEl('button', 'background:none;border:0;cursor:pointer;font-size:14px;padding:1px 3px;', '👁');
    eye.title = 'Открыть вакансию';
    eye.onclick = (e) => { e.stopPropagation(); window.open(card.url || '#', '_blank', 'noopener'); };
    const skipBtn = panelEl('button', 'background:none;border:0;cursor:pointer;font-size:13px;padding:1px 3px;color:#b0b0b0;', '✕');
    skipBtn.title = 'Отклонить';
    head.append(scoreBadge, titleEl, eye, skipBtn);

    const detail = panelEl('div', 'display:none;padding:2px 9px 9px;border-top:1px solid #f0f0f0;');
    const st = panelEl('div', 'font-size:11px;color:#5e6d55;margin:4px 0;min-height:13px;');
    if (card.coverStatus) st.textContent = card.coverStatus;

    const applyStatus = (s) => {
      if (s === 'skipped') { wrap.style.borderLeftColor = '#b0b0b0'; wrap.style.opacity = '.6'; titleEl.style.textDecoration = 'line-through'; titleEl.style.color = '#888'; }
      else if (s === 'sent') { wrap.style.borderLeftColor = '#14a800'; wrap.style.opacity = '1'; titleEl.style.textDecoration = 'line-through'; titleEl.style.color = '#14a800'; }
      else { wrap.style.borderLeftColor = '#14a800'; wrap.style.opacity = '1'; titleEl.style.textDecoration = 'none'; titleEl.style.color = '#001e00'; }
    };

    if (!analyzed) {
      // LIGHT — search-card facts + Analyze (the only thing that opens the job + spends Claude)
      const facts = [
        card.budget,
        card.client_country,
        card.client_rating != null ? `★${card.client_rating}` : null,
        card.client_spent_rough != null ? `$${card.client_spent_rough} spent` : null,
        card.proposals_min != null ? `${card.proposals_min}+ proposals` : null,
        (card.matched_skills != null && card.total_skills) ? `skills ${card.matched_skills}/${card.total_skills}` : null,
      ].filter(Boolean).join(' · ');
      if (facts) detail.append(panelEl('div', 'font:10.5px/1.4 monospace;color:#5e6d55;margin:6px 0;', facts));
      const analyzeBtn = panelEl('button', 'width:100%;background:#3c8dbc;color:#fff;border:0;border-radius:6px;padding:7px;font-weight:600;cursor:pointer;', '🔍 Analyze (open + AI)');
      analyzeBtn.onclick = async (e) => {
        e.stopPropagation();
        analyzeBtn.disabled = true; analyzeBtn.style.opacity = '.6'; analyzeBtn.textContent = 'Анализирую (открываю + AI)…';
        try {
          const r = await chrome.runtime.sendMessage({ type: 'ANALYZE_JOB', payload: {
            upwork_id: card.upwork_id, url: card.url, title: card.title,
            matched_skills: card.matched_skills, total_skills: card.total_skills,
            posted_ago_min: card.posted_ago_min, client_country: card.client_country,
          }});
          if (!r?.ok) { analyzeBtn.disabled = false; analyzeBtn.style.opacity = '1'; analyzeBtn.textContent = '🔍 Analyze (retry)'; st.textContent = '❌ ' + (r?.error || 'fail'); }
          // on success background pushes PANEL_CARD (scored) → row re-renders with score+accounts
        } catch (e2) { analyzeBtn.disabled = false; analyzeBtn.style.opacity = '1'; st.textContent = '❌ ' + (e2?.message || e2); }
      };
      detail.append(analyzeBtn, st);
    } else {
      // SCORED — breakdown + account_fit + Cover
      const b = card.breakdown || {};
      const bits = ['niche', 'stack', 'client', 'pain', 'dach', 'market'].filter(k => b[k] != null).map(k => `${k}:${b[k]}`).join(' ');
      if (bits) detail.append(panelEl('div', 'font:10px/1.3 monospace;color:#5e6d55;margin:6px 0;', bits));
      const fit = Array.isArray(card.account_fit) ? card.account_fit : [];
      const checks = [];
      if (fit.length === 0) {
        detail.append(panelEl('div', 'font-size:11px;color:#9aa0a6;font-style:italic;margin:4px 0;', 'Нет подходящих аккаунтов.'));
      } else {
        const list = panelEl('div', 'display:flex;flex-direction:column;gap:4px;margin:4px 0 8px;');
        for (const f of fit) {
          const r = panelEl('label', 'display:flex;gap:6px;align-items:flex-start;cursor:pointer;');
          const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = f.account_slug;
          cb.style.cssText = 'margin-top:2px;'; cb.checked = (card.decision && card.decision !== 'skip');
          checks.push(cb);
          const m = panelEl('div', 'flex:1;');
          m.append(panelEl('div', 'font-weight:600;font-size:12px;', `${f.account_slug} · ${f.fit_score != null ? f.fit_score : '?'}`));
          if (f.why_account) m.append(panelEl('div', 'font-size:10.5px;color:#5e6d55;', f.why_account));
          if (f.risks) m.append(panelEl('div', 'font-size:10px;color:#b35900;', '⚠ ' + f.risks));
          r.append(cb, m); list.append(r);
        }
        detail.append(list);
      }
      const coverBtn = panelEl('button', `width:100%;background:#14a800;color:#fff;border:0;border-radius:6px;padding:7px;font-weight:600;cursor:pointer;${fit.length ? '' : 'opacity:.4;pointer-events:none;'}`, 'Cover →');
      coverBtn.onclick = async () => {
        const accounts = checks.filter(c => c.checked).map(c => c.value);
        if (accounts.length === 0) { st.textContent = 'Отметь аккаунт(ы).'; return; }
        coverBtn.disabled = true; coverBtn.style.opacity = '.5'; st.textContent = `Генерю ${accounts.length}…`;
        try {
          const resp = await chrome.runtime.sendMessage({ type: 'APPROVE_COVERS', payload: { job_id: card.job_id, full_text: card.full_text, accounts } });
          const results = resp?.results || [];
          const line = results.map(r => `${r.account_slug}: ${r.tg_sent ? '✅' : (r.ok ? '⚠' : '❌')}`).join(' · ');
          st.textContent = line; coverBtn.textContent = 'Отправлено';
          applyStatus('sent'); patchCard(key, { coverStatus: line, status: 'sent' });
        } catch (e) { st.textContent = '❌ ' + (e?.message || e); coverBtn.disabled = false; coverBtn.style.opacity = '1'; }
      };
      detail.append(st, coverBtn);
    }

    skipBtn.onclick = (e) => { e.stopPropagation(); applyStatus('skipped'); patchCard(key, { status: 'skipped' }); };
    head.onclick = () => { detail.style.display = detail.style.display === 'none' ? 'block' : 'none'; };

    wrap.append(head, detail);
    applyStatus(card.status || 'pending');
    body.prepend(wrap);
    updatePanelCount();
  }

  // Background pushes a SCORED card (after Analyze) → merge onto the existing light row and re-render.
  async function upsertScored(scored) {
    const key = scored.upwork_id || scored.job_id;
    const merged = await upsertCard({
      upwork_id: key, job_id: scored.job_id, title: scored.title, url: scored.url,
      match_score: scored.match_score, decision: scored.decision, breakdown: scored.breakdown,
      detected_tech_stack: scored.detected_tech_stack, account_fit: scored.account_fit, full_text: scored.full_text,
    });
    const body = document.getElementById(PANEL_ID + '-body');
    const old = body && body.querySelector(`[data-ou-card="${key}"]`);
    if (old) old.remove();
    renderPanelCard(merged, false);
  }

  async function restorePanel() {
    if (getPageType() !== 'jobs_search') return;
    ensurePanel();
    updatePanelStats();
    const cards = await loadCards();
    [...cards].reverse().forEach(c => renderPanelCard(c, false));   // oldest first → newest ends on top
    updatePanelCount();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'PANEL_CARD' && msg.payload) {
      try { upsertScored(msg.payload); } catch (e) { warn('panel update fail:', e?.message); }
    }
  });

  // Re-render persisted cards after the auto-reload wipes the page DOM.
  setTimeout(() => { restorePanel().catch(() => {}); }, 1500);

  log('✅ Content script loaded v' + EXT_VERSION);
})();

