// Upwork RSS Feed parser
// RSS URL format: https://www.upwork.com/ab/feed/jobs/rss?q=KEYWORD&sort=recency

export function buildRssUrl(keywords) {
  // Encode keywords for RSS URL
  const q = encodeURIComponent(keywords.join(' OR '));
  return `https://www.upwork.com/ab/feed/jobs/rss?q=${q}&sort=recency`;
}

export async function fetchRssJobs(rssUrl) {
  try {
    const res = await fetch(rssUrl);
    if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
    
    const text = await res.text();
    return parseRssXml(text);
  } catch (err) {
    console.error('[RSS] Fetch error:', err);
    return [];
  }
}

function parseRssXml(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  const items = doc.querySelectorAll('item');
  const jobs = [];

  for (const item of items) {
    const title = item.querySelector('title')?.textContent || '';
    const link = item.querySelector('link')?.textContent || '';
    const description = item.querySelector('description')?.textContent || '';
    const pubDate = item.querySelector('pubDate')?.textContent || '';

    // Extract Upwork job ID from link
    // Format: https://www.upwork.com/jobs/~XXXXXXXXX
    const jobIdMatch = link.match(/~(\w+)/);
    const upworkJobId = jobIdMatch ? jobIdMatch[0] : link;

    // Parse description HTML for budget, country, skills
    const parsed = parseJobDescription(description);

    jobs.push({
      upwork_job_id: upworkJobId,
      title: cleanText(title),
      description: cleanText(parsed.description),
      budget_min: parsed.budgetMin,
      budget_max: parsed.budgetMax,
      budget_type: parsed.budgetType,
      client_country: parsed.country,
      client_rating: parsed.clientRating,
      client_hires: parsed.clientHires,
      client_spent_total: parsed.clientSpent,
      skills: parsed.skills,
      proposals_count: parsed.proposalsCount,
      posted_at: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
      upwork_url: link
    });
  }

  return jobs;
}

function parseJobDescription(html) {
  // RSS description contains HTML with job details
  const result = {
    description: '',
    budgetMin: null,
    budgetMax: null,
    budgetType: null,
    country: null,
    clientRating: null,
    clientHires: null,
    clientSpent: null,
    skills: [],
    proposalsCount: null
  };

  // Strip HTML tags for clean description
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  result.description = text;

  // Try to extract budget
  const budgetMatch = text.match(/Budget:\s*\$?([\d,.]+)\s*(?:-\s*\$?([\d,.]+))?/i);
  if (budgetMatch) {
    result.budgetMin = parseFloat(budgetMatch[1].replace(',', ''));
    result.budgetMax = budgetMatch[2] ? parseFloat(budgetMatch[2].replace(',', '')) : result.budgetMin;
  }

  // Hourly vs fixed
  if (/hourly/i.test(text)) result.budgetType = 'hourly';
  else if (/fixed/i.test(text)) result.budgetType = 'fixed';

  // Country
  const countryMatch = text.match(/Country:\s*([^\n|]+)/i);
  if (countryMatch) result.country = countryMatch[1].trim();

  // Skills from RSS (usually in <b> tags in original HTML)
  const skillsMatch = html.match(/<b>Skills<\/b>:?\s*([^<]+)/i);
  if (skillsMatch) {
    result.skills = skillsMatch[1].split(',').map(s => s.trim()).filter(Boolean);
  }

  return result;
}

function cleanText(text) {
  if (!text) return '';
  return text
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
