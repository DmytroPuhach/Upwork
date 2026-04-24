// OptimizeUp Extension v17.1.0 — Job Enrichment Injectable
// Runs once in a background tab that opened a single-job page.
// Extracts full description + budget + client stats + screening Qs,
// then self-terminates. NEVER exposes action-triggering code paths.
//
// Contract: returns ONE plain object via chrome.runtime.sendMessage
// to background.js: { type: 'ENRICH_RESULT', payload: {...} }

(function () {
  'use strict';

  const START_TS = Date.now();
  const HARD_TIMEOUT_MS = 25000;   // absolute ceiling — background also has 60s cap
  const POLL_INTERVAL_MS = 400;
  const MIN_DESC_CHARS = 200;

  // Mark this tab so background.js knows enrich ran (belt + suspenders)
  try { sessionStorage.setItem('ou_enrich_active', '1'); } catch {}

  function log(...a) { console.log('[OU enrich]', ...a); }
  function warn(...a) { console.warn('[OU enrich]', ...a); }

  // ═══════════════════════════════════════════════════════════
  // LOGIN / CHALLENGE DETECTION — stop the whole enrichment chain
  // ═══════════════════════════════════════════════════════════

  function detectAuthFailure() {
    const href = location.href;
    if (/\/ab\/account-security\/login/i.test(href)) return 'login_redirect';
    if (/\/nx\/signup/i.test(href)) return 'signup_redirect';
    if (/\/ab\/(?:verify|challenge|captcha)/i.test(href)) return 'challenge';
    // Upwork sometimes serves a bot-check page at same URL
    const body = document.body?.textContent || '';
    if (/access denied|unusual activity|please verify you are human/i.test(body.substring(0, 2000))) {
      return 'bot_check';
    }
    // If the URL no longer contains a job id — redirect happened
    if (!/~[\w]{15,25}/.test(href)) return 'navigated_away';
    return null;
  }

  // ═══════════════════════════════════════════════════════════
  // TEXT EXTRACTION — multi-strategy
  // ═══════════════════════════════════════════════════════════

  function qsText(sel, root) {
    try {
      const el = (root || document).querySelector(sel);
      return el ? (el.textContent || '').trim() : '';
    } catch { return ''; }
  }

  function qsAllText(sel, root) {
    try {
      return Array.from((root || document).querySelectorAll(sel))
        .map(e => (e.textContent || '').trim())
        .filter(Boolean);
    } catch { return []; }
  }

  function extractDescription() {
    // Strategy 1: data-test attribute (most stable across Upwork redesigns)
    const s1 = qsText('[data-test="Description"], [data-test="job-description-text"], [data-test="description-text"]');
    if (s1 && s1.length >= MIN_DESC_CHARS) return { text: s1, strategy: 'data-test' };

    // Strategy 2: ARIA-labelled section
    const s2 = qsText('section[aria-labelledby*="description" i], section[aria-label*="description" i]');
    if (s2 && s2.length >= MIN_DESC_CHARS) return { text: s2, strategy: 'aria' };

    // Strategy 3: semantic header + next sibling
    const headers = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5'));
    for (const h of headers) {
      if (/^\s*(Job description|Description|About the (job|project|role))\s*$/i.test(h.textContent || '')) {
        let sib = h.nextElementSibling;
        for (let i = 0; i < 3 && sib; i++, sib = sib.nextElementSibling) {
          const t = (sib.textContent || '').trim();
          if (t.length >= MIN_DESC_CHARS) return { text: t, strategy: 'header-sibling' };
        }
      }
    }

    // Strategy 4: biggest <p> cluster
    const paragraphs = Array.from(document.querySelectorAll('p'))
      .map(p => ({ p, text: (p.textContent || '').trim() }))
      .filter(x => x.text.length > 100);
    if (paragraphs.length > 0) {
      paragraphs.sort((a, b) => b.text.length - a.text.length);
      const top = paragraphs[0];
      if (top.text.length >= MIN_DESC_CHARS) return { text: top.text, strategy: 'biggest-p' };
    }

    return { text: '', strategy: 'none' };
  }

  // v17.1.3: extract job title from single-job page. Previously title was lost
  // during enrichment → rows got title="unknown" if ingest_only arrived after
  // enrichment (race). Now we always send title in the enrichment payload.
  function extractTitle() {
    // Strategy 1: data-test attributes on the H1 or its wrapper
    const s1 = qsText('h1[data-test="job-title"], h1[data-test="JobTitle"], [data-test="job-title"] h1, [data-test="JobTitle"] h1');
    if (s1) return s1.substring(0, 500);

    // Strategy 2: H1 inside the job header section
    const s2 = qsText('section[data-test="JobDetails"] h1, header h1, main h1');
    if (s2) return s2.substring(0, 500);

    // Strategy 3: any first H1 with reasonable length
    const h1 = document.querySelector('h1');
    if (h1) {
      const t = (h1.textContent || '').trim();
      if (t.length >= 5 && t.length <= 500) return t;
    }

    // Strategy 4: document.title, strip Upwork suffix
    const dt = (document.title || '')
      .replace(/\s*[-\u2013|]\s*Upwork.*$/i, '')
      .replace(/\s*\|\s*Upwork.*$/i, '')
      .trim();
    if (dt && dt.length >= 5 && !/^Upwork/i.test(dt)) return dt.substring(0, 500);

    return null;
  }

  function extractBudget() {
    // Try both hourly and fixed markers. Upwork single-job page shows budget in a
    // highlighted stats strip, usually with data-test or class markers.
    const candidates = [
      '[data-test="BudgetAmount"]',
      '[data-test="is-fixed-price"] strong',
      '[data-test="budget"]',
      'section[data-test="features"] li',
      'section[aria-labelledby*="budget" i]',
    ];
    for (const sel of candidates) {
      const t = qsText(sel);
      if (t && /[\$\d]/.test(t)) return t;
    }
    // Fallback: scan for an $X or $X-$Y pattern near 'Budget' or 'Hourly'
    const body = (document.body?.textContent || '').substring(0, 50000);
    const m = body.match(/(?:Fixed[-\s]?price|Hourly|Budget)\s*[:\-]?\s*\$[\d.,]+(?:\s*[-\u2013]\s*\$?[\d.,]+)?(?:\s*(?:\/\s*hr|\/\s*h|hour|hr))?/i);
    return m ? m[0] : '';
  }

  function extractClientStats() {
    const stats = {
      country: null,
      city: null,
      rating: null,
      reviews: null,
      total_spent: null,
      hires: null,
      posted_jobs: null,
      hire_rate: null,
      total_hours: null,
      avg_hourly_paid: null,
      member_since: null,
      payment_verified: null,
    };

    // Country — usually in a 'client info' sidebar
    const countryEl = document.querySelector('[data-qa="client-location"] strong, [data-test="LocationLabel"], [data-test="client-country"]');
    if (countryEl) stats.country = (countryEl.textContent || '').trim() || null;

    // City
    const cityEl = document.querySelector('[data-qa="client-location"] span:not(strong), [data-test="client-city"]');
    if (cityEl) {
      const c = (cityEl.textContent || '').trim();
      if (c && c !== stats.country) stats.city = c;
    }

    // Rating
    const ratingEl = document.querySelector('[data-test="rating"] .air3-rating-value, [class*="RatingStars"] .air3-rating-value, [data-qa="feedback"] .air3-rating-value');
    if (ratingEl) {
      const n = parseFloat((ratingEl.textContent || '').trim());
      if (!isNaN(n)) stats.rating = n;
    }

    // Helper — extract $amount spent + nearby labels
    const allText = document.body?.textContent || '';
    const spent = allText.match(/\$([\d,]+(?:\.\d+)?[KkMm]?)\+?\s*total\s*spent/i);
    if (spent) stats.total_spent = parseMoney(spent[1]);

    const hires = allText.match(/(\d[\d,]*)\s*(?:hires?|jobs posted)/i);
    if (hires) stats.hires = parseInt(hires[1].replace(/,/g, '')) || null;

    const hireRate = allText.match(/(\d{1,3})%\s*(?:hire|job fill)\s*rate/i);
    if (hireRate) stats.hire_rate = parseInt(hireRate[1]) / 100;

    const hours = allText.match(/(\d[\d,]*)\s*hours?\s*(?:billed|worked)/i);
    if (hours) stats.total_hours = parseInt(hours[1].replace(/,/g, '')) || null;

    const avgHr = allText.match(/\$([\d.]+)\s*\/\s*(?:hr|hour)\s*avg/i);
    if (avgHr) stats.avg_hourly_paid = parseFloat(avgHr[1]);

    const memberSince = allText.match(/Member since\s+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i);
    if (memberSince) stats.member_since = memberSince[1];

    if (/Payment method verified/i.test(allText)) stats.payment_verified = true;
    else if (/Payment method not verified/i.test(allText)) stats.payment_verified = false;

    const reviews = allText.match(/\(\s*(\d+)\s*reviews?\s*\)/i);
    if (reviews) stats.reviews = parseInt(reviews[1]) || null;

    return stats;
  }

  function parseMoney(s) {
    if (!s) return null;
    const clean = String(s).replace(/,/g, '').trim();
    const m = clean.match(/^([\d.]+)\s*([KkMm])?$/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    if (isNaN(n)) return null;
    const mult = m[2]?.toLowerCase() === 'k' ? 1000 : m[2]?.toLowerCase() === 'm' ? 1000000 : 1;
    return n * mult;
  }

  function extractSkills() {
    // Skills appear as chips / tokens on the job page
    const selectors = [
      '[data-test="Skill"] a',
      '[data-test="skills"] a',
      '[class*="air3-token"]',
      'section[aria-labelledby*="skills" i] a',
    ];
    const out = new Set();
    for (const sel of selectors) {
      qsAllText(sel).forEach(t => {
        if (t && t.length > 1 && t.length < 60) out.add(t);
      });
      if (out.size >= 5) break;
    }
    return Array.from(out).slice(0, 20);
  }

  function extractScreeningQuestions() {
    // Strategy 1: legacy data-test selectors (kept for backward compat if Upwork reverts)
    const legacySelectors = [
      '[data-test="ScreeningQuestions"] li',
      '[data-test="screening-questions"] li',
      'section[aria-labelledby*="screening" i] li',
    ];
    for (const sel of legacySelectors) {
      const items = qsAllText(sel);
      if (items.length > 0) {
        return { questions: items.slice(0, 10), strategy: 'legacy:' + sel };
      }
    }

    // Strategy 2 (v17.1.8): text-anchor — find element containing the anchor phrase,
    // walk up to nearest ancestor containing <li>, collect them.
    // Anchor phrases observed on Upwork job detail pages:
    //   "You will be asked to answer the following questions when submitting a proposal:"
    //   "Answer the following questions when submitting a proposal"
    //   "Screening questions"
    const anchorRegex = /asked to answer the following questions|answer the following questions when submitting|screening questions/i;
    const candidates = document.querySelectorAll('strong, b, h1, h2, h3, h4, h5, h6, label, p, span, div');
    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      if (text.length > 200) continue; // headers are short
      if (!anchorRegex.test(text)) continue;
      // Walk up up to 6 levels to find an ancestor holding <li> items
      let parent = el.parentElement;
      for (let depth = 0; depth < 6 && parent; depth++, parent = parent.parentElement) {
        const lis = parent.querySelectorAll('li');
        if (lis.length > 0 && lis.length <= 15) {
          const items = Array.from(lis)
            .map(li => (li.textContent || '').trim())
            .filter(t => t.length >= 10 && t.length <= 500);
          if (items.length > 0) {
            return { questions: items.slice(0, 10), strategy: 'text-anchor:depth' + depth + ':' + el.tagName.toLowerCase() };
          }
        }
      }
    }

    return { questions: [], strategy: 'none' };
  }

  function extractMeta() {
    const body = document.body?.textContent || '';
    const posted = body.match(/Posted\s+([^\n]{3,40}?\bago|\d{1,2}\s+\w+\s+\d{4})/i);
    const projectLen = body.match(/Project length[:\s]+([^\n]{3,60})/i);
    const experience = body.match(/Experience level[:\s]+(Entry level|Intermediate|Expert)/i);
    const hoursPerWeek = body.match(/(Less than 30 hrs\/week|More than 30 hrs\/week|\d+\+?\s*hrs\/week)/i);

    return {
      posted_raw: posted ? posted[1].trim() : null,
      project_length: projectLen ? projectLen[1].trim() : null,
      experience_level: experience ? experience[1].trim() : null,
      hours_per_week: hoursPerWeek ? hoursPerWeek[1].trim() : null,
    };
  }

  function extractUpworkJobId() {
    const m = location.pathname.match(/~[\w]{15,25}/);
    return m ? m[0] : null;
  }

  // ═══════════════════════════════════════════════════════════
  // MAIN
  // ═══════════════════════════════════════════════════════════

  async function waitForDescription() {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const auth = detectAuthFailure();
        if (auth) return resolve({ auth_failure: auth });

        const { text, strategy } = extractDescription();
        if (text && text.length >= MIN_DESC_CHARS) {
          return resolve({ text, strategy });
        }
        if (Date.now() - started > HARD_TIMEOUT_MS) {
          // Last-ditch: take the biggest <p> even if short
          const last = extractDescription();
          return resolve(last.text ? last : { timeout: true });
        }
        setTimeout(tick, POLL_INTERVAL_MS);
      };
      // First check synchronously; doc may already be idle
      const auth = detectAuthFailure();
      if (auth) return resolve({ auth_failure: auth });
      tick();
    });
  }

  // v17.1.2: simulate human scroll before reading. window.scrollTo with
  // smooth behavior generates native scroll events (not isTrusted=false
  // synthetic ones), so Upwork sees "user scrolled through brief".
  async function simulateReadScroll() {
    try {
      // First scroll: quick glance at middle
      const mid = 300 + Math.floor(Math.random() * 300);  // 300-600px
      window.scrollTo({ top: mid, behavior: 'smooth' });
      await new Promise(r => setTimeout(r, 1200 + Math.floor(Math.random() * 800)));  // 1.2-2s

      // Second scroll: further down to see client sidebar / details
      const deep = 800 + Math.floor(Math.random() * 600);  // 800-1400px
      window.scrollTo({ top: deep, behavior: 'smooth' });
      await new Promise(r => setTimeout(r, 1500 + Math.floor(Math.random() * 1000)));  // 1.5-2.5s

      // 60% chance to scroll back up (checking something) — human pattern
      if (Math.random() < 0.6) {
        const back = 100 + Math.floor(Math.random() * 300);  // 100-400px
        window.scrollTo({ top: back, behavior: 'smooth' });
        await new Promise(r => setTimeout(r, 800 + Math.floor(Math.random() * 800)));
      }
    } catch {}
  }

  async function run() {
    log('started on', location.href.substring(0, 120));

    // Check auth failure upfront — before investing scroll time
    const earlyAuth = detectAuthFailure();
    if (earlyAuth) {
      try {
        await chrome.runtime.sendMessage({
          type: 'ENRICH_RESULT',
          payload: {
            ok: false,
            upwork_job_id: extractUpworkJobId(),
            url: location.href,
            error_type: earlyAuth,
            error_detail: `Auth/challenge at ${location.href.substring(0, 200)}`,
            duration_ms: Date.now() - START_TS,
          },
        });
      } catch {}
      return;
    }

    // Human-like scroll pattern while waiting for SPA to hydrate
    await simulateReadScroll();

    const descResult = await waitForDescription();

    if (descResult.auth_failure) {
      const payload = {
        ok: false,
        upwork_job_id: extractUpworkJobId(),
        url: location.href,
        error_type: descResult.auth_failure,
        error_detail: `Auth/challenge at ${location.href.substring(0, 200)}`,
        duration_ms: Date.now() - START_TS,
      };
      try {
        await chrome.runtime.sendMessage({ type: 'ENRICH_RESULT', payload });
      } catch {}
      return;
    }

    if (descResult.timeout && !descResult.text) {
      try {
        await chrome.runtime.sendMessage({
          type: 'ENRICH_RESULT',
          payload: {
            ok: false,
            upwork_job_id: extractUpworkJobId(),
            url: location.href,
            error_type: 'desc_timeout',
            error_detail: 'Description element never appeared',
            duration_ms: Date.now() - START_TS,
          },
        });
      } catch {}
      return;
    }

    const budgetRaw = extractBudget();
    const clientStats = extractClientStats();
    const skills = extractSkills();
    const screeningResult = extractScreeningQuestions();
    const meta = extractMeta();
    const title = extractTitle();

    const payload = {
      ok: true,
      upwork_job_id: extractUpworkJobId(),
      url: location.href,
      title,
      description: descResult.text,
      description_strategy: descResult.strategy,
      budget_raw: budgetRaw,
      skills,
      screening_questions: screeningResult.questions,
      screening_strategy: screeningResult.strategy,
      client: clientStats,
      meta,
      duration_ms: Date.now() - START_TS,
    };

    log('extracted:', {
      title: title?.substring(0, 40),
      desc_chars: payload.description.length,
      strategy: payload.description_strategy,
      country: clientStats.country,
      budget_raw: budgetRaw?.substring(0, 40),
      skills_n: skills.length,
      screening_n: screeningResult.questions.length,
      screening_strategy: screeningResult.strategy,
    });

    try {
      await chrome.runtime.sendMessage({ type: 'ENRICH_RESULT', payload });
    } catch (e) {
      warn('sendMessage failed', e);
    }
  }

  run().catch((e) => {
    warn('run threw', e);
    try {
      chrome.runtime.sendMessage({
        type: 'ENRICH_RESULT',
        payload: {
          ok: false,
          upwork_job_id: extractUpworkJobId(),
          url: location.href,
          error_type: 'exception',
          error_detail: String(e?.message || e).substring(0, 300),
          duration_ms: Date.now() - START_TS,
        },
      }).catch(() => {});
    } catch {}
  });

})();
