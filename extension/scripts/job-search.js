// Job Search Scraper v2 — parses Upwork search/find-work page DOM
// Works by executing script in the already-open Upwork tab
// No fetch requests = no Cloudflare challenge = no 403

import { getConfig } from './config.js';
import { getSupabase } from './supabase.js';

export async function triggerJobSearch() {
  const config = await getConfig();
  const sb = await getSupabase();
  
  const accounts = await sb.query('accounts', {
    filters: { slug: config.accountSlug },
    limit: 1
  });
  
  if (!accounts.length) {
    console.error('[SEARCH] Account not found');
    return [];
  }

  const keywords = accounts[0].keywords_rss || [];
  if (!keywords.length) {
    console.warn('[SEARCH] No keywords configured');
    return [];
  }

  // Find Upwork tab
  const tabs = await chrome.tabs.query({ url: 'https://www.upwork.com/*' });
  
  if (tabs.length === 0) {
    console.warn('[SEARCH] No Upwork tab found. Open upwork.com first.');
    return [];
  }

  let tab = tabs.find(t => t.url.includes('/search/jobs') || t.url.includes('/find-work')) || tabs[0];
  
  // If not on search page — navigate there, otherwise use existing page
  if (!tab.url.includes('/search/jobs')) {
    const q = keywords.slice(0, 4).join(' ');
    const searchUrl = `https://www.upwork.com/nx/search/jobs/?q=${encodeURIComponent(q)}&sort=recency`;
    console.log('[SEARCH] Navigating to:', searchUrl);
    await chrome.tabs.update(tab.id, { url: searchUrl });
    await new Promise(resolve => setTimeout(resolve, 6000));
  } else {
    // DON'T refresh — Cloudflare will block. Just scrape what's already loaded.
    console.log('[SEARCH] Using existing search page (no refresh to avoid Cloudflare)');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeJobsFromDOM
    });

    const jobs = results[0]?.result || [];
    console.log(`[SEARCH] Scraped ${jobs.length} jobs from DOM`);
    return jobs;
  } catch (err) {
    console.error('[SEARCH] Script execution error:', err);
    return [];
  }
}

function scrapeJobsFromDOM() {
  const jobs = [];
  const titleLinks = document.querySelectorAll('h2 a[href*="/jobs/"], h3 a[href*="/jobs/"]');
  
  for (const a of titleLinks) {
    try {
      const title = a.textContent.trim();
      if (!title || title.length < 5) continue;
      
      const href = a.href;
      const idMatch = href.match(/~(\d+)/);
      const jobId = idMatch ? `~${idMatch[1]}` : href;
      
      // Walk up to find card container
      let card = a.parentElement;
      for (let i = 0; i < 8; i++) {
        if (!card || !card.parentElement) break;
        card = card.parentElement;
        if (card.tagName === 'SECTION' || card.tagName === 'ARTICLE') break;
        const style = window.getComputedStyle(card);
        if (style.borderBottomWidth && parseInt(style.borderBottomWidth) > 0) break;
      }
      
      if (!card) continue;
      const cardText = card.textContent.replace(/\s+/g, ' ').trim();
      
      // Description
      const titleIdx = cardText.indexOf(title);
      let description = '';
      if (titleIdx >= 0) {
        const afterTitle = cardText.substring(titleIdx + title.length);
        const cutoffs = ['Payment verified', 'Proposals:', 'Less than', 'SEO Audit'];
        let descEnd = afterTitle.length;
        for (const cut of cutoffs) {
          const idx = afterTitle.indexOf(cut);
          if (idx > 100 && idx < descEnd) descEnd = idx;
        }
        description = afterTitle.substring(0, Math.min(descEnd, 1500)).trim();
      }
      
      // Skills
      const skillEls = card.querySelectorAll('span.air3-badge, a[data-test="attr-item"], [class*="badge"], [class*="skill"]');
      const skills = [...skillEls].map(s => s.textContent.trim()).filter(s => s.length > 1 && s.length < 50 && !s.startsWith('+'));

      // Metadata
      const spent = cardText.match(/\$([\d,.]+K?\+?)\s*spent/i);
      const rating = cardText.match(/(\d\.\d+)\s*Stars/i) || cardText.match(/Rating is ([\d.]+)/i);
      const country = cardText.match(/Location\s+(\w[\w\s]*?)(?:\s+Hourly|\s+Fixed|\s+Est\.)/i);
      const proposals = cardText.match(/Proposals?:\s*([^\n]+?)(?:\s{2,}|$)/i);
      const budget = cardText.match(/(?:Budget|Fixed)[:\s]*\$([\d,.]+)/i);
      const hourlyRange = cardText.match(/\$([\d.]+)\s*-\s*\$([\d.]+)\s*(?:\/hr|Hourly)/i);
      const budgetType = /Hourly/i.test(cardText) ? 'hourly' : /Fixed/i.test(cardText) ? 'fixed' : null;
      
      let budgetMin = null, budgetMax = null;
      if (hourlyRange) {
        budgetMin = parseFloat(hourlyRange[1]);
        budgetMax = parseFloat(hourlyRange[2]);
      } else if (budget) {
        budgetMin = parseFloat(budget[1].replace(',', ''));
        budgetMax = budgetMin;
      }
      
      let clientSpent = null;
      if (spent) {
        const v = spent[1].replace(',', '');
        clientSpent = v.includes('K') ? parseFloat(v) * 1000 : parseFloat(v);
      }

      jobs.push({
        upwork_job_id: jobId,
        title, 
        description: description.substring(0, 3000),
        budget_min: budgetMin, budget_max: budgetMax, budget_type: budgetType,
        client_country: country?.[1]?.trim() || '',
        client_rating: rating ? parseFloat(rating[1]) : null,
        client_hires: null,
        client_spent_total: clientSpent,
        skills, proposals_count: proposals?.[1]?.trim() || null,
        posted_at: new Date().toISOString(),
        upwork_url: href.split('?')[0]
      });
    } catch (err) {
      console.error('[SEARCH] Error parsing card:', err);
    }
  }
  return jobs;
}
