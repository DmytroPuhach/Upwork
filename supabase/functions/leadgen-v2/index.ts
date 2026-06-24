// leadgen-v2 v36 — STEP 0: secrets moved to Deno.env (SB_SERVICE_ROLE, ANTHROPIC_API_KEY, TG_*),
//                  bidding source-of-truth = team_members.is_bidding_enabled (not accounts.bidding_enabled)
// leadgen-v2 v35 — city→country normalization in isCountryBlocked (Lahore→Pakistan etc + strip time suffix)
// leadgen-v2 v34 — fix extra_qa: q.question/q.answer field names + filter empty items
// leadgen-v2 v33 — match_score fallback fix (score ?? match_score), cover prompt fix
// v23: v3 multi-account routing
// v21: TG format — removed Почему подходит + Риски (dashboard-only fields).
//      Cleaner layout: header line + client line + cover only.
// Input: same as v19 { job, account_slug, matched_skills, total_skills, ingest_only, prematch_reason, sync }
// Changes vs v19:
//   - matchScoreAndCoversV3() replaces matchScore() + generateCover()
//   - Single Claude call → tg_blocks[] (one cover per selected account)
//   - Uses bid_decision_prompt_v3 + knowledge_base_v3 from opus_knowledge
//   - Multi-account: one job → Dima + David + Vika covers in one request
//   - New TG format: Freelancer, Priority, Score, Client, Why, Risks, Cover
//   - TG bot: tg_brain for Dima, tg_agents for David/Vika/Vasya

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Secrets are read from Deno env (set via Supabase secrets). No secrets in source.
const reqEnv = (name: string): string => {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
};

const SB_URL = 'https://nsmcaexdqbipusjuzfht.supabase.co';
const SB_KEY = reqEnv('SB_SERVICE_ROLE');
const AK = reqEnv('ANTHROPIC_API_KEY');
const TG_BRAIN = reqEnv('TG_BRAIN_TOKEN');   // Dima account
const TG_AGENTS = reqEnv('TG_AGENTS_TOKEN');  // David/Vika/Vasya
const CHAT = reqEnv('TG_CHAT_ID');
const BID_DECISIONS = ['bid_high', 'bid_medium', 'bid_low'];

const db = () => createClient(SB_URL, SB_KEY, { db: { schema: 'upwork' } });
const esc = (t) => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function dbg(sb, stage, payload) {
  try { await sb.from('leadgen_debug').insert({ stage, payload }); } catch {}
}

async function resolveAccount(sb, slug) {
  if (!slug) return null;
  const lower = String(slug).toLowerCase();
  const { data: direct } = await sb.from('accounts').select('*').eq('slug', lower).maybeSingle();
  if (direct) return direct;
  const { data: tm } = await sb.from('team_members').select('id, slug, account_id, aliases').contains('aliases', [lower]).maybeSingle();
  if (tm?.account_id) {
    const { data: acc } = await sb.from('accounts').select('*').eq('id', tm.account_id).maybeSingle();
    if (acc) return acc;
  }
  const { data: bySlug } = await sb.from('team_members').select('account_id').eq('slug', lower).maybeSingle();
  if (bySlug?.account_id) {
    const { data: acc } = await sb.from('accounts').select('*').eq('id', bySlug.account_id).maybeSingle();
    if (acc) return acc;
  }
  return null;
}

async function upsertJob(sb, job, account) {
  const upworkId = job.upwork_id || job.upwork_job_id;
  if (!upworkId || !job.title) return null;
  const payload = {
    upwork_job_id: upworkId,
    title: (job.title || '').substring(0, 500),
    description: (job.description || '').substring(0, 10000),
    budget_type: job.budget_type || null,
    budget_min: job.budget_min || null,
    budget_max: job.budget_max || null,
    client_country: job.client_country || null,
    client_rating: job.client_rating || null,
    client_hires: job.client_hires || null,
    client_spent_total: job.client_spent_total || null,
    skills: Array.isArray(job.skills) ? job.skills.slice(0, 30) : null,
    upwork_url: (job.url || job.upwork_url || '').substring(0, 500),
    matched_account_id: account.id
  };
  const { data: ins, error: insErr } = await sb
    .from('jobs')
    .upsert(payload, { onConflict: 'upwork_job_id', ignoreDuplicates: true })
    .select('id')
    .maybeSingle();
  if (insErr) {
    await dbg(sb, 'upsert_job_error', { err: insErr.message, upwork_id: upworkId });
    return null;
  }
  if (ins?.id) return ins.id;
  const { data: existing } = await sb.from('jobs').select('id').eq('upwork_job_id', upworkId).maybeSingle();
  return existing?.id || null;
}

function correctBudgetIfMisclassified(job) {
  if (job.budget_type === 'fixed' && job.hours_per_week) {
    const origMin = job.budget_min;
    const origMax = job.budget_max;
    job.budget_type = 'hourly';
    job._budget_corrected = true;
    job._budget_corrected_from = `fixed $${origMin ?? '?'}-${origMax ?? '?'} + hours_per_week='${job.hours_per_week}'`;
  }
  return job;
}

async function mergeEnrichedFromDb(sb, job, jobId) {
  if (!jobId) return correctBudgetIfMisclassified(job);
  const { data: row } = await sb.from('jobs').select(
    'description, budget_type, budget_min, budget_max, client_country, client_rating, ' +
    'client_hires, client_spent_total, client_total_hours, client_hire_rate, ' +
    'client_avg_hourly_paid, skills, screening_questions, is_enriched, enriched_at, posted_at, ' +
    'hours_per_week, project_length, experience_level'
  ).eq('id', jobId).maybeSingle();
  if (!row) return correctBudgetIfMisclassified(job);
  const merged = { ...job };
  const incoming = (job.description || '').length;
  const dbLen = (row.description || '').length;
  if (dbLen > incoming) merged.description = row.description;
  if (!merged.budget_type && row.budget_type) merged.budget_type = row.budget_type;
  if (merged.budget_min == null && row.budget_min != null) merged.budget_min = row.budget_min;
  if (merged.budget_max == null && row.budget_max != null) merged.budget_max = row.budget_max;
  if (!merged.client_country && row.client_country) merged.client_country = row.client_country;
  if (merged.client_rating == null && row.client_rating != null) merged.client_rating = row.client_rating;
  if (merged.client_hires == null && row.client_hires != null) merged.client_hires = row.client_hires;
  if (merged.client_spent_total == null && row.client_spent_total != null) merged.client_spent_total = row.client_spent_total;
  if (merged.client_total_hours == null && row.client_total_hours != null) merged.client_total_hours = row.client_total_hours;
  if (merged.client_hire_rate == null && row.client_hire_rate != null) merged.client_hire_rate = row.client_hire_rate;
  if (merged.client_avg_hourly_paid == null && row.client_avg_hourly_paid != null) merged.client_avg_hourly_paid = row.client_avg_hourly_paid;
  if ((!merged.skills || merged.skills.length === 0) && Array.isArray(row.skills)) merged.skills = row.skills;
  if ((!merged.screening_questions || merged.screening_questions.length === 0) && Array.isArray(row.screening_questions)) merged.screening_questions = row.screening_questions;
  if (!merged.hours_per_week && row.hours_per_week) merged.hours_per_week = row.hours_per_week;
  if (!merged.project_length && row.project_length) merged.project_length = row.project_length;
  if (!merged.experience_level && row.experience_level) merged.experience_level = row.experience_level;
  merged._is_enriched = !!row.is_enriched;
  merged._posted_at = row.posted_at || null;
  return correctBudgetIfMisclassified(merged);
}

function cleanDescription(raw) {
  if (!raw) return { cleaned: '', had_ui_overlay: false };
  const hasOverlay = /Job Feedback Just not interested/i.test(raw);
  let cleaned = raw;
  const budgetMarker = cleaned.match(/Est\.\s*budget:?\s*\$[\d,\.]+(?:\.\d+)?/i);
  if (budgetMarker && budgetMarker.index !== undefined) {
    cleaned = cleaned.substring(budgetMarker.index + budgetMarker[0].length).trim();
  } else {
    const saveJobMarker = cleaned.indexOf('Save Job');
    if (saveJobMarker > -1) {
      const afterSave = cleaned.substring(saveJobMarker);
      const briefStart = afterSave.search(/\n\s*[A-Z][a-z]+\s+[a-z]|Hi\s|Hello|Looking for|We are |We're |I am |I'm |Our |\bCompany:|Please /);
      if (briefStart > 50) cleaned = afterSave.substring(briefStart).trim();
    }
  }
  cleaned = cleaned.replace(/Payment (verified|unverified)[\s\S]{0,120}?(spent|hires|No feedback yet|No reviews yet)/gi, '').trim();
  cleaned = cleaned.replace(/Rating is \d(\.\d+)? out of 5[\s\S]{0,80}?\d+\s/gi, '').trim();
  if (cleaned.length < 80) return { cleaned: raw, had_ui_overlay: hasOverlay };
  return { cleaned, had_ui_overlay: hasOverlay };
}

const CITY_TO_COUNTRY: Record<string, string> = {
  // Pakistan
  'lahore': 'Pakistan', 'karachi': 'Pakistan', 'islamabad': 'Pakistan', 'rawalpindi': 'Pakistan',
  'faisalabad': 'Pakistan', 'peshawar': 'Pakistan', 'multan': 'Pakistan', 'quetta': 'Pakistan',
  // Bangladesh
  'dhaka': 'Bangladesh', 'chittagong': 'Bangladesh', 'sylhet': 'Bangladesh',
  // Philippines
  'manila': 'Philippines', 'cebu': 'Philippines', 'davao': 'Philippines', 'quezon': 'Philippines',
  // Nigeria
  'lagos': 'Nigeria', 'abuja': 'Nigeria', 'kano': 'Nigeria', 'ibadan': 'Nigeria',
  // India
  'mumbai': 'India', 'delhi': 'India', 'bangalore': 'India', 'hyderabad': 'India',
  'chennai': 'India', 'kolkata': 'India', 'pune': 'India', 'ahmedabad': 'India',
  // Indonesia
  'jakarta': 'Indonesia', 'surabaya': 'Indonesia', 'bandung': 'Indonesia',
  // Vietnam
  'hanoi': 'Vietnam', 'ho chi minh': 'Vietnam', 'saigon': 'Vietnam',
  // Egypt
  'cairo': 'Egypt', 'alexandria': 'Egypt',
  // Morocco
  'casablanca': 'Morocco', 'rabat': 'Morocco',
  // Kenya
  'nairobi': 'Kenya', 'mombasa': 'Kenya',
};

function normalizeCountry(raw: string): string {
  const lower = raw.toLowerCase().trim();
  // Strip local time suffix like "Lahore 1:32 PM" → "lahore"
  const noTime = lower.replace(/\s+\d{1,2}:\d{2}\s*(am|pm)?$/i, '').trim();
  return CITY_TO_COUNTRY[noTime] || raw;
}

function isCountryBlocked(country: string | null, blockedCountries: string[]) {
  if (!country || !blockedCountries?.length) return false;
  const resolved = normalizeCountry(country);
  const cl = resolved.toLowerCase().trim();
  for (const bc of blockedCountries) {
    if (!bc) continue;
    const bcl = bc.toLowerCase().trim();
    if (bcl.length < 2) continue;
    if (cl === bcl || cl.includes(bcl) || bcl.includes(cl)) return true;
  }
  return false;
}

function isAgencyJob(job) {
  const desc = (job._cleaned_description || job.description || '').toLowerCase();
  const title = (job.title || '').toLowerCase();
  return /white[-\s]label|agency (looking|needs|seeking) (for|to hire)|freelancers? to join our (team|agency)|contractor (pool|roster)|retainer (freelancer|roster)|for our agency/.test(desc)
    || /white[-\s]label/.test(title);
}

function computeJobAgeMin(job) {
  const postedAt = job._posted_at;
  if (!postedAt) return null;
  try {
    const t = new Date(postedAt).getTime();
    if (!isFinite(t) || t <= 0) return null;
    const min = Math.round((Date.now() - t) / 60000);
    if (min < 0 || min > 100000) return null;
    return min;
  } catch { return null; }
}

function auditProposal(text) {
  const issues = [];
  const hasUnicodeBold = /[\u{1D400}-\u{1D7FF}]/u.test(text);
  if (hasUnicodeBold) issues.push('Unicode bold detected');
  const hasPreamble = /^(Looking at this|I'll (craft|position|write)|Here's my|Here is)/i.test(text.trim());
  if (hasPreamble) issues.push('Preamble leaked');
  const hasOverusedHook = /^Quick question:/i.test(text.trim().substring(0, 50));
  if (hasOverusedHook) issues.push('Overused Quick question hook');
  const hasFakeStats = /(\€|\$)?\d+M\+ revenue|\+?200%\+? organic growth/i.test(text);
  if (hasFakeStats) issues.push('Fake stats');
  const hasCheckmarkBullets = (text.match(/✔️/g) || []).length > 1;
  if (hasCheckmarkBullets) issues.push('Checkmark bullets');
  const hasCliche = /I fix what others break|who speaks (Liquid|PHP|JSON-LD)/i.test(text);
  if (hasCliche) issues.push('Cliche phrases');
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words > 450) issues.push(`Too long: ${words} words`);
  if (words < 80 && words > 0) issues.push(`Too short: ${words} words`);
  if (words === 0) issues.push('EMPTY proposal');
  const qualityScore = Math.max(0, 100 - (issues.length * 15));
  return { quality_score: qualityScore, issues, should_regenerate: qualityScore < 60 || words === 0 };
}

// V3: Single Claude call scores job + routes accounts + generates covers for all
async function matchScoreAndCoversV3(job, enabledAccounts, sb) {
  const { data: rows } = await sb.from('opus_knowledge').select('key, content')
    .in('key', ['bid_decision_prompt_v3', 'knowledge_base_v3', 'cover_generator_prompt_v3']);
  const decisionPrompt = rows?.find(r => r.key === 'bid_decision_prompt_v3')?.content;
  const coverPrompt = rows?.find(r => r.key === 'cover_generator_prompt_v3')?.content;
  const knowledgeBase = rows?.find(r => r.key === 'knowledge_base_v3')?.content;
  if (!decisionPrompt) return { error: 'bid_decision_prompt_v3 not found' };
  // v23: JSON schema FIRST in system prompt so Claude sees format requirement before old logic.
  // The old bid_decision_prompt_v3 has a "Telegram informing" section describing a text format —
  // explicitly override it at the top and bottom so Claude uses JSON output.
  const jsonSchemaFirst = `## CRITICAL: JSON-ONLY OUTPUT — READ THIS BEFORE ANYTHING ELSE
You are a JSON-only response generator for this request.
Output ONLY a raw JSON object. No markdown. No code blocks. No text before { or after }.

The prompt below may describe a "Telegram informing" text format — this is DEPRECATED and OBSOLETE.
COMPLETELY IGNORE the Telegram text format. You MUST output JSON only.

## REQUIRED JSON SCHEMA:
{
  "decision": "bid_high" | "bid_medium" | "bid_low" | "skip",
  "match_score": <integer 0-100, REQUIRED — never null>,
  "reasoning": "<1-2 sentences explaining the score>",
  "stop_reason": "<reason if skip, else null>",
  "breakdown": {
    "niche": <integer, points for niche fit>,
    "stack": <integer, points for tech stack>,
    "client": <integer, points for client quality>,
    "pain": <integer, points for clear pain>,
    "dach": <integer, DACH market bonus>,
    "market": <integer, other market bonus>
  },
  "detected_tech_stack": ["shopify", "ga4", ...],
  "tg_blocks": [
    {
      "account": "<slug from Active Accounts list — use the slug field, not name>",
      "priority": "BID HIGH" | "BID MEDIUM" | "BID LOW",
      "why_account": "<1 sentence: why this specific account fits>",
      "cover": "<COMPLETE PROPOSAL TEXT — 80 to 150 words, ready to submit to client. MANDATORY. Must not be null, empty, or a placeholder>",
      "risks": ["<risk 1>", "<risk 2>"],
      "extra_qa": [{"question": "<screening question text>", "answer": "<ready answer>"}]
    }
  ]
}

MANDATORY RULES:
- Start your response with { — nothing before it
- End your response with } — nothing after it
- "match_score" must be an integer (0-100), never null
- decision=skip → tg_blocks=[] (still include match_score and reasoning)
- Each bidding account gets its own tg_block with a UNIQUE cover letter
- "cover" MUST be a complete, personalized proposal (80-150 words). NOT null. NOT "". NOT a placeholder.

---

`;

  const jsonSchemaLast = `

---

## FINAL REMINDER: Output format
- Start with { end with } — raw JSON only, no markdown
- Every tg_block "cover" field MUST contain a complete proposal (80-150 words)
- "match_score" must be an integer, never null`;

  const systemPrompt = jsonSchemaFirst
    + decisionPrompt
    + (coverPrompt ? `\n\n---\n\n## COVER LETTER WRITING RULES (apply when writing each "cover" field in tg_blocks):\n\n${coverPrompt}` : '')
    + jsonSchemaLast;

  const desc = (job._cleaned_description || job.description || '').substring(0, 3500);
  const matchedSk = Number(job._matched_skills) || 0;
  const totalSk = Number(job._total_skills) || 0;
  const skillHint = totalSk > 0 ? `\nupwork_matched_skills: ${matchedSk}/${totalSk}` : '';
  const budgetLine = job._budget_corrected
    ? `budget: hourly $${job.budget_min || '?'}-${job.budget_max || '?'}/h (auto-corrected)`
    : `budget: ${job.budget_type || '?'} $${job.budget_min || '?'}-${job.budget_max || '?'}`;
  const avgHourly = job.client_avg_hourly_paid != null ? `$${job.client_avg_hourly_paid}/h` : 'unknown';
  const hireRate = job.client_hire_rate != null ? `${Math.round(Number(job.client_hire_rate) * 100)}%` : 'unknown';
  const ageMin = computeJobAgeMin(job);

  const accountProfiles = enabledAccounts.map(a => ({
    slug: a.slug,
    name: a.name,
    specialization: (a.specialization || []).slice(0, 8),
    hourly_rate: a.hourly_rate,
    jss: a.jss_current,
    bio: (a.bio || '').substring(0, 300),
    cases: (a.cases || []).slice(0, 2),
  }));

  const userMsg = `## Job
title: ${job.title}
url: ${job.upwork_url || job.url || 'N/A'}
${budgetLine}
skills: ${(job.skills || []).slice(0, 12).join(', ')}
experience: ${job.experience_level || 'N/A'}
project_length: ${job.project_length || 'N/A'}
hours_per_week: ${job.hours_per_week || 'N/A'}
proposals_count: ${job.proposals_count ?? 'unknown'}
posted: ${ageMin != null ? `${ageMin} min ago` : 'unknown'}${skillHint}

## Client
country: ${job.client_country || 'unknown'}
rating: ${job.client_rating || 'unknown'}
hires: ${job.client_hires || 0}
spent: $${job.client_spent_total || 0}
avg_hourly_paid: ${avgHourly}
hire_rate: ${hireRate}
member_since: ${job.client_member_since || 'unknown'}

## Description
${desc}

## Screening Questions
${JSON.stringify(job.screening_questions || [])}

## Active Accounts (route only to these)
${JSON.stringify(accountProfiles, null, 2)}

${knowledgeBase ? `## Agency Knowledge Base\n${knowledgeBase.substring(0, 7000)}` : ''}

## REQUIRED JSON OUTPUT FORMAT
Return ONLY a raw JSON object (no markdown, no code blocks). Exact schema:
{
  "decision": "bid_high" | "bid_medium" | "bid_low" | "skip",
  "match_score": <integer 0-100>,
  "reasoning": "<1-2 sentence explanation>",
  "stop_reason": "<reason if skip, else null>",
  "breakdown": {
    "niche": <0 or positive integer, points for niche fit>,
    "stack": <0 or positive integer, points for tech stack>,
    "client": <0 or positive integer, points for client quality>,
    "pain": <0 or positive integer, points for clear pain/problem>,
    "dach": <0 or positive integer, DACH market bonus>,
    "market": <0 or positive integer, other strong market bonus>
  },
  "detected_tech_stack": ["shopify", "ga4", ...],
  "tg_blocks": [
    {
      "account": "<name field from Active Accounts — use name, not slug>",
      "priority": "BID HIGH" | "BID MEDIUM" | "BID LOW",
      "why_account": "<1 sentence: why this specific account>",
      "cover": "<full proposal text, 80-150 words, unique per account>",
      "risks": ["<risk 1>", "<risk 2>"],
      "extra_qa": [{"question": "<screening Q>", "answer": "<ready answer>"}]
    }
  ]
}
Rules: decision=skip → tg_blocks=[]. Each bidding account gets its own tg_block with unique cover. Cover must be a complete proposal ready to send.`;

  await dbg(sb, 'v3_call_start', { system_chars: systemPrompt.length, user_chars: userMsg.length, accounts: enabledAccounts.map(a => a.slug) });

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': AK, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }]
      }),
      signal: AbortSignal.timeout(85000)
    });
    const bodyText = await res.text();
    await dbg(sb, 'v3_call_resp', { status: res.status, body_chars: bodyText.length });
    if (!res.ok) return { error: `Claude HTTP ${res.status}` };
    let data;
    try { data = JSON.parse(bodyText); } catch { return { error: 'JSON parse fail on Claude response' }; }
    const rawText = data.content?.[0]?.text || '';
    await dbg(sb, 'v3_extracted', { preview: rawText.substring(0, 300) });
    const m = rawText.match(/\{[\s\S]*\}/);
    if (!m) return { error: 'No JSON block in Claude output' };
    const cleaned = m[0].replace(/:\s*\+(\d)/g, ': $1');
    return JSON.parse(cleaned);
  } catch (e) {
    await dbg(sb, 'v3_exception', { err: String(e?.message || e) });
    return { error: String(e?.message || e) };
  }
}

async function sendTgV3(account, block, job, decision, ageMin, proposalId) {
  const botToken = account.telegram_bot_token || (account.slug === 'dima' ? TG_BRAIN : TG_AGENTS);
  const chatId = account.telegram_chat_id || CHAT;
  const accName = account.name || account.slug;

  const br = decision.breakdown || {};
  const brkStr = `niche:${br.niche ?? 0} stack:${br.stack ?? 0} dach:${br.dach ?? 0} pain:${br.pain ?? 0} penalties:${br.penalties ?? 0}`;

  const ageStr = ageMin != null
    ? (ageMin <= 15 ? `⚡ ${ageMin} min ago` : ageMin <= 30 ? `⏳ ${ageMin} min ago` : `🔴 ${ageMin} min ago`)
    : 'unknown';

  const siteStr = decision.detected_client_site ? ` | <code>${esc(decision.detected_client_site)}</code>` : '';
  const techStr = decision.detected_tech_stack?.length ? ` | ${esc(decision.detected_tech_stack.slice(0, 3).join(', '))}` : '';

  const validQa = (block.extra_qa || []).filter(q => (q.question || q.q) && (q.answer || q.a));
  const qaBlock = validQa.length > 0
    ? '\n\n❓ <b>Доп. вопросы:</b>\n' + validQa.map(q => `<b>Q:</b> ${esc(q.question || q.q)}\n<i>A:</i> ${esc(q.answer || q.a)}`).join('\n\n')
    : '';

  // v21: compact layout — why_fits + risks moved to dashboard only
  let msg = `🔥 <b>Upwork Lead</b>\n\n`;
  msg += `<b>${esc(accName)}</b> | ${esc(block.priority)} | ${decision.match_score ?? decision.score ?? '?'}/100\n`;
  msg += `<i>${brkStr}</i>\n\n`;
  msg += `<b>${esc(job.title)}</b>\n`;
  msg += `<i>${esc(block.why_account)}</i>\n\n`;
  msg += `${esc(job.client_country || 'unknown')}${siteStr}${techStr} | `;
  msg += `$${job.client_spent_total || 0} spent | ${ageStr}\n\n`;
  msg += `<b>Письмо:</b>\n<pre>${esc((block.cover || '').substring(0, 2800))}</pre>`;
  msg += qaBlock;

  const buttons = [];
  if (proposalId) {
    buttons.push([
      { text: '✅ Approve', callback_data: `bid_approve:${proposalId}` },
      { text: '❌ Decline', callback_data: `bid_decline:${proposalId}` }
    ]);
    buttons.push([
      { text: '💬 Comment', callback_data: `bid_comment:${proposalId}` },
      { text: '📋 Submitted', callback_data: `bid_submitted:${proposalId}` }
    ]);
  }
  const jobUrl = job.upwork_url || job.url;
  if (jobUrl) buttons.push([{ text: '🔗 Open job', url: jobUrl }]);

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: msg.substring(0, 4000),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: buttons.length > 0 ? { inline_keyboard: buttons } : undefined
      })
    });
  } catch (e) {
    console.error('[leadgen-v2] TG send failed:', e);
  }
}

async function runIngestOnly(job, account, opts: any = {}) {
  const sb = db();
  try {
    const jobId = await upsertJob(sb, job, account);
    await dbg(sb, 'ingest_only', {
      job_id: jobId,
      upwork_job_id: job.upwork_id || job.upwork_job_id,
      title: job.title,
      prematch_reason: opts.prematch_reason || null,
      prematch_score: opts.prematch_score ?? null,
      matched_skills: opts.matched_skills ?? null,
      total_skills: opts.total_skills ?? null,
    });
    if (jobId && opts.prematch_reason) {
      await sb.from('match_scores').insert({
        job_id: jobId,
        account_slug: account.slug,
        total_score: opts.prematch_score ?? 0,
        decision: 'skip',
        detected_stop_reason: `prematch_${opts.prematch_reason}`,
        should_bid: false,
        reasoning: `Pre-match skip: ${opts.prematch_reason}`,
        matched_skills: Number(opts.matched_skills) || null,
        total_skills: Number(opts.total_skills) || null,
      });
    }
    return { ok: true, job_id: jobId, mode: 'ingest_only' };
  } catch (e) {
    await dbg(sb, 'ingest_only_error', { err: String(e?.message || e) });
    return { ok: false, error: String(e?.message || e) };
  }
}

async function runPipelineV3(job, primaryAccount, test_mode, opts: any = {}): Promise<string[]> {
  const sb = db();
  const runId = crypto.randomUUID();
  try {
    await dbg(sb, 'pipeline_start_v3', { run_id: runId, title: job.title, primary_account: primaryAccount.slug });

    // 1. Upsert job using primary account (machine that scraped it)
    const jobId = await upsertJob(sb, job, primaryAccount);
    if (jobId) {
      job.id = jobId;
      job = await mergeEnrichedFromDb(sb, job, jobId);
    } else {
      job = await mergeEnrichedFromDb(sb, job, null);
    }
    job._matched_skills = Number(opts.matched_skills) || 0;
    job._total_skills = Number(opts.total_skills) || 0;

    const { cleaned } = cleanDescription(job.description || '');
    job._cleaned_description = cleaned;
    const ageMin = computeJobAgeMin(job);

    // 2. Agency check (global skip — no point bidding for any account)
    if (isAgencyJob(job)) {
      await dbg(sb, 'early_stop_agency', { run_id: runId });
      if (jobId) {
        await sb.from('match_scores').insert({
          job_id: jobId, account_slug: primaryAccount.slug,
          total_score: 0, decision: 'skip', detected_stop_reason: 'agency',
          should_bid: false, reasoning: 'Agency/white-label job detected',
        });
      }
      return [];
    }

    // 3. Load accounts whose team_member has bidding enabled (single source of truth:
    //    team_members.is_bidding_enabled), then filter by country.
    const { data: biddingMembers } = await sb.from('team_members')
      .select('account_id')
      .eq('is_bidding_enabled', true)
      .eq('is_active', true);
    const biddingAccountIds = (biddingMembers || [])
      .map(m => m.account_id)
      .filter(Boolean);

    if (biddingAccountIds.length === 0) {
      await dbg(sb, 'no_bidding_accounts', { run_id: runId });
      return [];
    }

    const { data: allAccounts } = await sb.from('accounts')
      .select('id, slug, name, bio, cases, cv_text, specialization, hourly_rate, jss_current, telegram_bot_token, telegram_chat_id, blocked_countries, status')
      .in('id', biddingAccountIds)
      .eq('status', 'active');

    const enabledAccounts = (allAccounts || []).filter(a =>
      !isCountryBlocked(job.client_country, a.blocked_countries)
    );

    if (enabledAccounts.length === 0) {
      await dbg(sb, 'all_accounts_blocked', { run_id: runId, country: job.client_country });
      return [];
    }

    // 4. Dedup: if another machine already scored this job, skip
    if (jobId) {
      const { data: alreadyScored } = await sb.from('match_scores').select('id').eq('job_id', jobId).limit(1).maybeSingle();
      if (alreadyScored) {
        await dbg(sb, 'dedup_skip', { run_id: runId, job_id: jobId });
        return [];
      }
    }

    // 5. Server pre-filter: proposals ≥ 10 AND age > 30 min
    if (job.proposals_count != null && job.proposals_count >= 10 && ageMin != null && ageMin > 30) {
      await dbg(sb, 'server_prefilter', { run_id: runId, proposals: job.proposals_count, age_min: ageMin });
      return [];
    }

    // 5. Single v3 Claude call — score + route + generate covers for all accounts
    const decision = await matchScoreAndCoversV3(job, enabledAccounts, sb);
    const matchScore = decision.match_score ?? decision.score ?? null;
    const reasoning = decision.reasoning ?? decision.reason ?? null;
    await dbg(sb, 'v3_decision', { run_id: runId, decision: decision.decision, score: matchScore, accounts: decision.accounts, error: decision.error });

    if (decision.error) {
      console.error('[leadgen-v2 v3] Claude error:', decision.error);
      return [];
    }

    // 6. Handle skip/stop globally
    const normalizedDecision = (decision.decision || '').toLowerCase().replace(/[\s-]+/g, '_');
    decision.decision = normalizedDecision;
    if (!BID_DECISIONS.includes(normalizedDecision)) {
      if (jobId) {
        for (const acc of enabledAccounts) {
          const { data: ex } = await sb.from('match_scores').select('id').eq('job_id', jobId).eq('account_slug', acc.slug).maybeSingle();
          if (!ex) {
            await sb.from('match_scores').insert({
              job_id: jobId, account_slug: acc.slug,
              total_score: matchScore ?? 0,
              decision: 'skip', should_bid: false,
              reasoning: reasoning,
              detected_stop_reason: decision.stop_reason || decision.decision,
            });
          }
        }
      }
      return [];
    }

    // 7. Process each tg_block
    for (const block of (decision.tg_blocks || [])) {
      const blockAccNorm = (block.account || '').toLowerCase().trim();
      const acc = enabledAccounts.find(a =>
        a.slug === blockAccNorm ||
        (a.name || '').toLowerCase() === blockAccNorm
      );
      if (!acc) {
        await dbg(sb, 'v3_account_not_found', { run_id: runId, slug: block.account, normalized: blockAccNorm });
        continue;
      }

      // Save match_score
      let scoreId = null;
      if (jobId) {
        const { data: ex } = await sb.from('match_scores').select('id').eq('job_id', jobId).eq('account_slug', acc.slug).maybeSingle();
        const br = decision.breakdown || {};
        const scorePayload = {
          job_id: jobId, account_slug: acc.slug,
          total_score: matchScore,
          niche_fit: br.niche ?? null,
          stack_fit: br.stack ?? null,
          client_tier: br.client ?? null,
          brief_quality: br.pain ?? null,
          red_flags: block.risks?.length ? block.risks.length * -5 : 0,
          bonus_signals: br.dach ?? br.market ?? null,
          reasoning: reasoning,
          decision: decision.decision,
          should_bid: true,
          matched_skills: job._matched_skills || null,
          total_skills: job._total_skills || null,
        };
        if (ex) {
          await sb.from('match_scores').update(scorePayload).eq('id', ex.id);
          scoreId = ex.id;
        } else {
          const { data: ins } = await sb.from('match_scores').insert(scorePayload).select('id').maybeSingle();
          scoreId = ins?.id || null;
        }
      }

      // Audit cover
      const audit = auditProposal(block.cover || '');

      // Save proposal
      let proposalId = null;
      if (jobId && block.cover && block.cover.length > 50) {
        const { data: exP } = await sb.from('proposals').select('id').eq('job_id', jobId).eq('member_slug', acc.slug).maybeSingle();
        if (!exP) {
          const propPayload = {
            job_id: jobId,
            account_id: acc.id,
            member_slug: acc.slug,
            proposal_text: block.cover,
            match_score: matchScore,
            status: 'generated',
            generator_version: 'v3',
            language: 'EN',
            tools_used: {
              v3: true,
              accounts_evaluated: enabledAccounts.map(a => a.slug),
              tech_stack: decision.detected_tech_stack || [],
              screening_qa: block.extra_qa || [],
            },
          };
          const { data: saved } = await sb.from('proposals').insert(propPayload).select('id').maybeSingle();
          proposalId = saved?.id || null;

          if (proposalId) {
            try {
              await sb.from('proposal_audit').insert({
                proposal_id: proposalId,
                has_unicode_bold: false,
                has_preamble: audit.issues.includes('Preamble leaked'),
                has_overused_hook: audit.issues.includes('Overused Quick question hook'),
                has_fake_stats: audit.issues.includes('Fake stats'),
                has_irrelevant_case: false,
                quality_score: audit.quality_score,
                issues: audit.issues,
                should_regenerate: audit.should_regenerate,
              });
            } catch {}
          }
        }
      }

      // Send TG
      await sendTgV3(acc, block, job, decision, ageMin, proposalId);
      await dbg(sb, 'v3_block_done', { run_id: runId, account: acc.slug, proposal_id: proposalId, quality: audit.quality_score });
    }

    const accountsProcessed = (decision.tg_blocks || []).map(b => {
      const norm = (b.account || '').toLowerCase().trim();
      const matched = enabledAccounts.find(a => a.slug === norm || (a.name || '').toLowerCase() === norm);
      return matched ? matched.slug : null;
    }).filter(Boolean) as string[];
    await dbg(sb, 'pipeline_end_v3', { run_id: runId, accounts_processed: accountsProcessed });
    return accountsProcessed;
  } catch (err) {
    await dbg(sb, 'pipeline_error_v3', { run_id: runId, err: String(err?.message || err) });
    return [];
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const sb = db();
  try {
    const body = await req.json();
    const { job, account_slug, test_mode, sync, ingest_only, prematch_reason, prematch_score, matched_skills, total_skills } = body;
    if (!job || !account_slug) return new Response(JSON.stringify({ error: 'need job + account_slug' }), { status: 400 });
    const account = await resolveAccount(sb, account_slug);
    if (!account) {
      await dbg(sb, 'account_resolve_fail', { account_slug });
      return new Response(JSON.stringify({ error: 'account not found', tried: account_slug }), { status: 404 });
    }
    if (ingest_only) {
      const r = await runIngestOnly(job, account, { prematch_reason, prematch_score, matched_skills, total_skills });
      return new Response(JSON.stringify({ ...r, resolved_account: account.slug }), { status: r.ok ? 200 : 500 });
    }
    if (sync) {
      const accountsProcessed = await runPipelineV3(job, account, !!test_mode, { matched_skills, total_skills });
      return new Response(JSON.stringify({ ok: true, mode: 'sync', resolved_account: account.slug, accounts_processed: accountsProcessed }));
    }
    EdgeRuntime.waitUntil(runPipelineV3(job, account, !!test_mode, { matched_skills, total_skills }));
    return new Response(JSON.stringify({ ok: true, mode: 'async', status: 'queued', title: job.title, resolved_account: account.slug }));
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err?.message || err) }), { status: 500 });
  }
});
