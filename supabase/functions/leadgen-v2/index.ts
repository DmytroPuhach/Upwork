// leadgen-v2 v44 — cover_voice log now distinguishes own_winners (PROVEN) / descriptive_only /
//   dima_style_fallback / none, with has_winners flag — so you always see who runs on proven material.
// leadgen-v2 v43 — per-account VOICE corpus. generate_cover loads {slug}_winner_proposals/
//   _winning_cover_letters/_communication_style/_sales_patterns/_proven_techniques from opus_knowledge.
//   Own winners → real voice; zero account (no winners) → Dima winners as STYLE TEMPLATE only (no
//   Dima stats/badge); nothing → block skipped + logged (dbg 'cover_voice' mode own|dima_style_fallback|none).
// leadgen-v2 v42 — screening answers: tightened COVER_SCHEMA extra_qa to human, 1-2 sentence, Q/A
//   form (not essay). Pairs with cover_generator_prompt_v3 §5b + content.js extractScreeningFromPage.
// leadgen-v2 v41 — FIX: sibling-cover block split a surrogate pair (Unicode bold) → Anthropic 400
//   "no low surrogate" → dima/vika covers failed. Now code-point-safe truncate (safeSlice) + lone-
//   surrogate scrub (scrubSurr), applied to sibling block AND all TG text cuts.
// leadgen-v2 v40 — anti multi-accounting: generate_cover now loads sibling covers already written
//   for the SAME job by other team accounts and feeds them to Claude with "diverge hard" so the 3
//   covers (Dima/David/Vika) don't look templated. Pairs with cover_generator_prompt_v3 (DB) edit:
//   fake "attack angles" removed → differentiation by real standing (Top Rated / dropped-JSS / zero).
// leadgen-v2 v39 — account_fit now returns EVERY enabled account (weak fits get a low score + risk,
//   never omitted) so the operator always sees dima/david/vika and decides. Was: only-fits.
// leadgen-v2 v38 — + mode:"cancel_cover" {job_id, account_slug?} → mark proposal(s) status='cancelled'
//   (operator "Отмена" in the radar panel after a cover was sent).
// leadgen-v2 v37 — SPLIT score/route from cover generation (human-in-the-loop).
//   Single Deno.serve, routed by body.mode:
//     mode:"score_route"   → ONE Claude call (bid_decision_prompt_v3 + knowledge_base_v3, NO cover).
//                            Scores job, routes to accounts, writes match_scores. Returns account_fit
//                            to the operator panel. NO Telegram, NO proposals, NO covers.
//     mode:"generate_cover"→ ONE Claude call (cover_generator_prompt_v3 + knowledge_base_v3) on FULL
//                            job text for ONE approved account. Writes proposal + proposal_audit, then
//                            sends Telegram (job URL + cover) to that account's owner.
//     ingest_only          → unchanged (funnel ingest, no AI).
//   v37 cleanup: removed jsonSchemaFirst/Last override hack; account_slug everywhere (no name/slug dual);
//     mergeEnrichedFromDb now carries proposals_count + client_member_since; removed dead TG fields
//     penalties/detected_client_site; auditProposal writes REAL has_unicode_bold.
// --- history ---
// v36 — STEP 0: secrets to Deno.env; bidding source-of-truth = team_members.is_bidding_enabled
// v35 — city→country normalization in isCountryBlocked
// v34 — extra_qa field-name fix; v33 — match_score fallback; v23 — v3 multi-account routing

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
// Code-point-safe truncate (never splits a surrogate pair → no "no low surrogate" JSON 400).
const safeSlice = (t, max) => Array.from(String(t || '')).slice(0, max).join('');
// Drop any lone surrogates (defensive — astral chars like Unicode bold survive, orphans don't).
const scrubSurr = (s) => String(s || '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
const json = (obj: any, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

// Clean output schemas — one per endpoint, account_slug only (no name, no dual slug/name instruction).
const SCORE_SCHEMA = `## OUTPUT — JSON ONLY
Respond with ONE raw JSON object and nothing else (no markdown, no prose, no code fences).
Ignore any "Telegram informing"/text-format instructions in the knowledge base — this endpoint scores only.
Schema:
{
  "decision": "bid_high" | "bid_medium" | "bid_low" | "skip",
  "match_score": <integer 0-100>,
  "reasoning": "<1-2 sentences>",
  "stop_reason": "<string if decision=skip, else null>",
  "breakdown": { "niche": <int>, "stack": <int>, "client": <int>, "pain": <int>, "dach": <int>, "market": <int> },
  "detected_tech_stack": ["<lowercase tech>", ...],
  "account_fit": [ { "account_slug": "<slug from Active Accounts>", "fit_score": <integer 0-100>, "why_account": "<1 sentence>", "risks": "<short string>" } ]
}
Rules:
- Use account_slug values EXACTLY as given in Active Accounts. Never invent slugs.
- account_fit: include EVERY account listed in Active Accounts — NEVER omit one. A weak fit still appears with a LOW fit_score (e.g. 20-45) and a risks note explaining the mismatch; a strong fit gets a high score. Sort by fit_score DESC. The operator decides who actually bids. EXCEPTION: decision=skip → account_fit=[].
- match_score = overall job quality (0-100); fit_score = per-account suitability.
- Start with { and end with } — raw JSON only.`;

const COVER_SCHEMA = `## OUTPUT — JSON ONLY
Respond with ONE raw JSON object and nothing else (no markdown, no prose, no code fences).
Schema:
{
  "cover": "<complete proposal, 80-150 words, ready to submit — never null/empty/placeholder>",
  "extra_qa": "<answer EACH screening question in 1-2 plain first-person sentences as typed into the form (NOT an essay/cover letter); per question: a 'Q: ...' line then an 'A: ...' line, blank line between pairs; empty string if no questions>",
  "risks": "<1-2 short risks for this specific bid, or empty string>"
}
Start with { and end with } — raw JSON only.`;

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
    'hours_per_week, project_length, experience_level, proposals_count, client_member_since'
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
  // v37: these two were dropped before — they materially affect scoring (competition + client tenure)
  if (merged.proposals_count == null && row.proposals_count != null) merged.proposals_count = row.proposals_count;
  if (!merged.client_member_since && row.client_member_since) merged.client_member_since = row.client_member_since;
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

// One Anthropic call, returns parsed JSON object or { error }.
async function callClaude(system: string, userMsg: string, sb: any, tag: string, maxTokens = 3500) {
  await dbg(sb, `${tag}_call_start`, { system_chars: system.length, user_chars: userMsg.length });
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': AK, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: userMsg }],
      }),
      signal: AbortSignal.timeout(85000),
    });
    const bodyText = await res.text();
    await dbg(sb, `${tag}_call_resp`, { status: res.status, body_chars: bodyText.length, body: res.ok ? undefined : bodyText.substring(0, 500) });
    if (!res.ok) return { error: `Claude HTTP ${res.status}` };
    let data;
    try { data = JSON.parse(bodyText); } catch { return { error: 'JSON parse fail on Claude response' }; }
    const rawText = data.content?.[0]?.text || '';
    const m = rawText.match(/\{[\s\S]*\}/);
    if (!m) return { error: 'No JSON block in Claude output' };
    const cleaned = m[0].replace(/:\s*\+(\d)/g, ': $1');
    try { return JSON.parse(cleaned); } catch { return { error: 'JSON parse fail on extracted block' }; }
  } catch (e) {
    await dbg(sb, `${tag}_exception`, { err: String(e?.message || e) });
    return { error: String(e?.message || e) };
  }
}

// ENDPOINT A helper: score + route (NO cover). system = bid_decision_prompt_v3 + knowledge_base_v3.
async function scoreRouteClaude(job, enabledAccounts, sb) {
  const { data: rows } = await sb.from('opus_knowledge').select('key, content')
    .in('key', ['bid_decision_prompt_v3', 'knowledge_base_v3']);
  const decisionPrompt = rows?.find(r => r.key === 'bid_decision_prompt_v3')?.content;
  const knowledgeBase = rows?.find(r => r.key === 'knowledge_base_v3')?.content;
  if (!decisionPrompt) return { error: 'bid_decision_prompt_v3 not found' };

  const system = decisionPrompt
    + (knowledgeBase ? `\n\n---\n\n## AGENCY KNOWLEDGE BASE\n${knowledgeBase.substring(0, 7000)}` : '')
    + `\n\n---\n\n${SCORE_SCHEMA}`;

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

  // account_slug only — no name field anywhere.
  const accountProfiles = enabledAccounts.map(a => ({
    account_slug: a.slug,
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

## Active Accounts (route only to these account_slug values)
${JSON.stringify(accountProfiles, null, 2)}`;

  return await callClaude(system, userMsg, sb, 'score', 2500);
}

// Per-account VOICE corpus from opus_knowledge.
//  - own winners present  → load the account's real voice ({slug}_winner_proposals / _winning_cover_letters
//    / _communication_style / _sales_patterns / _proven_techniques; only the keys that exist).
//  - no winners (zero account) → Dima's winning examples as a STYLE TEMPLATE ONLY (mirror structure/tone,
//    NEVER cite Dima's stats/badge — this account has no track record).
//  - nothing at all → skip the block (never inject empty silently) and log it.
const VOICE_TYPES = [
  { t: 'winner_proposals', label: 'Выигравшие proposals (примеры)', cap: 2600, winner: true },
  { t: 'winning_cover_letters', label: 'Выигравшие каверы (примеры)', cap: 2400, winner: true },
  { t: 'communication_style', label: 'Стиль коммуникации', cap: 1400 },
  { t: 'sales_patterns', label: 'Sales-паттерны', cap: 1600 },
  { t: 'proven_techniques', label: 'Проверенные приёмы', cap: 1200 },
];
async function buildVoiceBlock(sb, slug) {
  const want = VOICE_TYPES.map((x) => `${slug}_${x.t}`);
  const { data } = await sb.from('opus_knowledge').select('key, content').in('key', want);
  const map = {};
  (data || []).forEach((r) => { if (r.content && r.content.trim().length > 40) map[r.key] = r.content; });
  const present = VOICE_TYPES.filter((x) => map[`${slug}_${x.t}`]);

  if (present.length > 0) {
    const hasWinners = present.some((x) => x.winner);
    const parts = present.map((x) => `### ${x.label}\n${scrubSurr(safeSlice(map[`${slug}_${x.t}`], x.cap))}`);
    return {
      // own_winners = running on PROVEN material; descriptive_only = has voice description but NO winners.
      mode: hasWinners ? 'own_winners' : 'descriptive_only',
      loaded: present.map((x) => x.t),
      has_winners: hasWinners,
      block: `\n\n---\n\n## ГОЛОС АККАУНТА «${slug}» — РЕАЛЬНЫЕ МАТЕРИАЛЫ ЭТОГО АККАУНТА\nПиши кавер В ЭТОМ голосе/стиле — это собственные материалы аккаунта.\n${parts.join('\n\n')}`,
    };
  }

  // Zero account → Dima STYLE template only.
  const { data: dd } = await sb.from('opus_knowledge').select('key, content')
    .in('key', ['dima_winning_cover_letters', 'dima_winner_proposals']);
  const dmap = {};
  (dd || []).forEach((r) => { if (r.content && r.content.trim().length > 40) dmap[r.key] = r.content; });
  const src = dmap['dima_winning_cover_letters'] || dmap['dima_winner_proposals'];
  if (src) {
    return {
      mode: 'dima_style_fallback',
      has_winners: false,
      loaded: [dmap['dima_winning_cover_letters'] ? 'dima_winning_cover_letters' : 'dima_winner_proposals'],
      block: `\n\n---\n\n## STYLE TEMPLATE (структура и тон) — это каверы DIMA, НЕ этого аккаунта\nУ «${slug}» нет своих выигравших материалов. Отрази СТРУКТУРУ и ТОН примеров ниже, но НЕ используй статистику, бейдж Top Rated Plus или личные цифры Dima — у этого аккаунта НЕТ трек-рекорда, который можно цитировать. Метрики/кейсы — только агентские из knowledge_base, без личной статистики аккаунта.\n${scrubSurr(safeSlice(src, 3000))}`,
    };
  }
  return { mode: 'none', has_winners: false, loaded: [], block: '' };
}

// ENDPOINT B helper: generate ONE cover on full job text. system = cover_generator_prompt_v3 + knowledge_base_v3.
async function generateCoverClaude(fullText, account, job, sb, siblingCovers: any[] = []) {
  const { data: rows } = await sb.from('opus_knowledge').select('key, content')
    .in('key', ['cover_generator_prompt_v3', 'knowledge_base_v3']);
  const coverPrompt = rows?.find(r => r.key === 'cover_generator_prompt_v3')?.content;
  const knowledgeBase = rows?.find(r => r.key === 'knowledge_base_v3')?.content;
  if (!coverPrompt) return { error: 'cover_generator_prompt_v3 not found' };

  const baseSystem = coverPrompt
    + (knowledgeBase ? `\n\n---\n\n## AGENCY KNOWLEDGE BASE\n${knowledgeBase.substring(0, 7000)}` : '')
    + `\n\n---\n\n${COVER_SCHEMA}`;

  // Per-account voice: own corpus, or Dima STYLE fallback, or nothing (logged, never empty-injected).
  const voice = await buildVoiceBlock(sb, account.slug);
  await dbg(sb, 'cover_voice', { account: account.slug, mode: voice.mode, has_winners: voice.has_winners, loaded: voice.loaded });
  const system = baseSystem + voice.block;

  const profile = {
    account_slug: account.slug,
    specialization: (account.specialization || []).slice(0, 10),
    hourly_rate: account.hourly_rate,
    jss: account.jss_current,
    proposal_style: account.proposal_style,
    bio: (account.bio || '').substring(0, 600),
    cases: (account.cases || []).slice(0, 4),
    cv: (account.cv_text || '').substring(0, 1500),
  };

  // Anti multi-accounting: show what sibling team accounts already wrote for THIS job → diverge hard.
  const siblingBlock = (Array.isArray(siblingCovers) && siblingCovers.length)
    ? `\n\n## Каверы соседних аккаунтов на ЭТУ ЖЕ вакансию (уже написаны нашими другими аккаунтами)
Твой кавер ОБЯЗАН быть ЯВНО другим: другой первый заход (первая строка), другой кейс из базы, другая структура и другие формулировки. НИКАКИХ совпадающих предложений или фраз. Одинаковые письма с родственных аккаунтов = палево мульти-аккаунтинга — это недопустимо.
${siblingCovers.map(s => `--- ${s.member_slug} ---\n${scrubSurr(safeSlice(s.proposal_text, 600))}`).join('\n\n')}`
    : '';

  const userMsg = `## Job (full text)
${(fullText || '').substring(0, 6000)}

## Screening Questions
${JSON.stringify(job.screening_questions || [])}

## Write the proposal AS this account
${JSON.stringify(profile, null, 2)}${siblingBlock}`;

  return await callClaude(system, userMsg, sb, 'cover', 2000);
}

// ENDPOINT B: Telegram to the owner of account_slug — clean (job URL + cover). No penalties/detected_client_site.
async function sendCoverTg(account, job, cover, extraQa, proposalId) {
  // bot: account override → team_members mapping (dima → brain) → agents default
  const botToken = account.telegram_bot_token || (account.slug === 'dima' ? TG_BRAIN : TG_AGENTS);
  const chatId = account.telegram_chat_id || CHAT;
  const accName = account.name || account.slug;
  const jobUrl = job.upwork_url || job.url || '';

  let msg = `🔥 <b>Upwork Lead</b> — <b>${esc(accName)}</b>\n\n`;
  msg += `<b>${esc(job.title || '')}</b>\n`;
  if (jobUrl) msg += `${esc(jobUrl)}\n`;
  msg += `\n<b>Cover:</b>\n<pre>${esc(scrubSurr(safeSlice(cover, 2800)))}</pre>`;
  if (extraQa && String(extraQa).trim()) {
    msg += `\n\n❓ <b>Screening:</b>\n${esc(scrubSurr(safeSlice(extraQa, 800)))}`;
  }

  const buttons: any[] = [];
  if (proposalId) {
    buttons.push([
      { text: '✅ Approve', callback_data: `bid_approve:${proposalId}` },
      { text: '❌ Decline', callback_data: `bid_decline:${proposalId}` },
    ]);
    buttons.push([{ text: '📋 Submitted', callback_data: `bid_submitted:${proposalId}` }]);
  }
  if (jobUrl) buttons.push([{ text: '🔗 Open job', url: jobUrl }]);

  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: scrubSurr(safeSlice(msg, 4000)),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: buttons.length > 0 ? { inline_keyboard: buttons } : undefined,
      }),
    });
    return r.ok;
  } catch (e) {
    console.error('[leadgen-v2] TG send failed:', e);
    return false;
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

// ENDPOINT A — score + route. NO covers, NO Telegram, NO proposals.
// Returns { ok, job_id, decision, match_score, breakdown, account_fit } for the operator panel.
async function runScoreRoute(job, watchAccount, opts: any = {}) {
  const sb = db();
  const runId = crypto.randomUUID();
  try {
    await dbg(sb, 'score_route_start', { run_id: runId, title: job.title, watch_account: watchAccount.slug });

    // PRE-CLAUDE (in order): correctBudget, upsertJob, mergeEnrichedFromDb, cleanDescription
    job = correctBudgetIfMisclassified(job);
    const jobId = await upsertJob(sb, job, watchAccount);
    job = await mergeEnrichedFromDb(sb, job, jobId);
    job._matched_skills = Number(opts.matched_skills) || 0;
    job._total_skills = Number(opts.total_skills) || 0;
    const { cleaned } = cleanDescription(job.description || '');
    job._cleaned_description = cleaned;
    const ageMin = computeJobAgeMin(job);

    const skipResult = (stop_reason: string) => ({
      ok: true, job_id: jobId, decision: 'skip', match_score: 0,
      breakdown: null, account_fit: [], stop_reason,
    });

    // Agency skip
    if (isAgencyJob(job)) {
      if (jobId) await sb.from('match_scores').insert({
        job_id: jobId, account_slug: watchAccount.slug, total_score: 0,
        decision: 'skip', detected_stop_reason: 'agency', should_bid: false,
        reasoning: 'Agency/white-label job detected',
      });
      await dbg(sb, 'score_route_skip', { run_id: runId, reason: 'agency' });
      return skipResult('agency');
    }

    // Active accounts: team_members.is_bidding_enabled (single source of truth) → accounts → country filter
    const { data: biddingMembers } = await sb.from('team_members')
      .select('account_id').eq('is_bidding_enabled', true).eq('is_active', true);
    const biddingAccountIds = (biddingMembers || []).map(m => m.account_id).filter(Boolean);
    if (biddingAccountIds.length === 0) {
      await dbg(sb, 'no_bidding_accounts', { run_id: runId });
      return skipResult('no_bidding_accounts');
    }
    const { data: allAccounts } = await sb.from('accounts')
      .select('id, slug, name, bio, cases, cv_text, specialization, hourly_rate, jss_current, telegram_bot_token, telegram_chat_id, blocked_countries, status')
      .in('id', biddingAccountIds).eq('status', 'active');
    const enabledAccounts = (allAccounts || []).filter(a => !isCountryBlocked(job.client_country, a.blocked_countries));
    if (enabledAccounts.length === 0) {
      await dbg(sb, 'all_accounts_blocked', { run_id: runId, country: job.client_country });
      return skipResult('all_accounts_blocked');
    }

    // Dedup: already scored?
    if (jobId) {
      const { data: alreadyScored } = await sb.from('match_scores').select('id').eq('job_id', jobId).limit(1).maybeSingle();
      if (alreadyScored) {
        await dbg(sb, 'dedup_skip', { run_id: runId, job_id: jobId });
        return skipResult('already_scored');
      }
    }

    // Server pre-filter: proposals ≥ 10 AND age > 30 min
    if (job.proposals_count != null && job.proposals_count >= 10 && ageMin != null && ageMin > 30) {
      await dbg(sb, 'server_prefilter', { run_id: runId, proposals: job.proposals_count, age_min: ageMin });
      return skipResult('too_competitive_old');
    }

    // CLAUDE — score + route only
    const result = await scoreRouteClaude(job, enabledAccounts, sb);
    if (result.error) {
      await dbg(sb, 'score_route_claude_error', { run_id: runId, err: result.error });
      return { ok: false, job_id: jobId, error: result.error };
    }
    const decision = (result.decision || '').toLowerCase().replace(/[\s-]+/g, '_');
    const matchScore = result.match_score ?? null;
    const breakdown = result.breakdown || {};
    const reasoning = result.reasoning || null;
    const accountFitRaw = Array.isArray(result.account_fit) ? result.account_fit : [];
    await dbg(sb, 'score_route_decision', { run_id: runId, decision, match_score: matchScore, fit: accountFitRaw.map(a => a.account_slug) });

    // WRITES — match_scores per account
    const isBid = BID_DECISIONS.includes(decision);
    const validFit: any[] = [];
    if (!jobId) {
      // can't persist without a job row; still return decision to panel
    } else if (!isBid || accountFitRaw.length === 0) {
      // skip — one skip row per enabled account
      for (const acc of enabledAccounts) {
        const { data: ex } = await sb.from('match_scores').select('id').eq('job_id', jobId).eq('account_slug', acc.slug).maybeSingle();
        if (!ex) await sb.from('match_scores').insert({
          job_id: jobId, account_slug: acc.slug, total_score: matchScore ?? 0,
          decision: 'skip', should_bid: false, reasoning,
          detected_stop_reason: result.stop_reason || 'no_fit',
        });
      }
    } else {
      for (const fit of accountFitRaw) {
        const slug = (fit.account_slug || '').toLowerCase().trim();
        const acc = enabledAccounts.find(a => a.slug === slug);
        if (!acc) { await dbg(sb, 'score_route_acct_not_found', { run_id: runId, slug: fit.account_slug }); continue; }
        const payload = {
          job_id: jobId, account_slug: acc.slug,
          total_score: fit.fit_score ?? matchScore ?? 0,
          niche_fit: breakdown.niche ?? null,
          stack_fit: breakdown.stack ?? null,
          client_tier: breakdown.client ?? null,
          brief_quality: breakdown.pain ?? null,
          bonus_signals: ((breakdown.dach ?? 0) + (breakdown.market ?? 0)) || null,
          reasoning: fit.why_account ? `${reasoning || ''} | ${fit.why_account}`.trim() : reasoning,
          decision, should_bid: true,
          matched_skills: job._matched_skills || null,
          total_skills: job._total_skills || null,
        };
        const { data: ex } = await sb.from('match_scores').select('id').eq('job_id', jobId).eq('account_slug', acc.slug).maybeSingle();
        if (ex) await sb.from('match_scores').update(payload).eq('id', ex.id);
        else await sb.from('match_scores').insert(payload);
        validFit.push({ account_slug: acc.slug, fit_score: fit.fit_score ?? null, why_account: fit.why_account || '', risks: fit.risks || '' });
      }
    }

    await dbg(sb, 'score_route_end', { run_id: runId, decision, fit_count: validFit.length });
    return {
      ok: true, job_id: jobId, decision, match_score: matchScore,
      breakdown, detected_tech_stack: result.detected_tech_stack || [],
      account_fit: isBid ? validFit : [],
    };
  } catch (err) {
    await dbg(sb, 'score_route_error', { run_id: runId, err: String(err?.message || err) });
    return { ok: false, error: String(err?.message || err) };
  }
}

// ENDPOINT B — generate ONE cover for an approved account on the FULL job text, then Telegram the owner.
// Returns { ok, proposal_id, tg_sent }.
async function runGenerateCover(jobId, accountSlug, fullText) {
  const sb = db();
  const runId = crypto.randomUUID();
  try {
    if (!jobId || !accountSlug) return { ok: false, error: 'need job_id + account_slug' };
    const { data: job } = await sb.from('jobs').select('*').eq('id', jobId).maybeSingle();
    if (!job) return { ok: false, error: 'job not found', job_id: jobId };
    const account = await resolveAccount(sb, accountSlug);
    if (!account) return { ok: false, error: 'account not found', account_slug: accountSlug };

    await dbg(sb, 'cover_start', { run_id: runId, job_id: jobId, account: account.slug });

    // sibling covers already written for this job by OTHER team accounts → force divergence (anti multi-acct)
    const { data: siblings } = await sb.from('proposals')
      .select('member_slug, proposal_text')
      .eq('job_id', jobId).neq('member_slug', account.slug)
      .in('status', ['generated', 'sent', 'submitted']);
    const siblingCovers = (siblings || []).filter(s => String(s.proposal_text || '').trim().length > 30);

    const text = (fullText && fullText.length > 50) ? fullText : (job.description || '');
    const result = await generateCoverClaude(text, account, job, sb, siblingCovers);
    if (result.error) {
      await dbg(sb, 'cover_claude_error', { run_id: runId, err: result.error, account: account.slug });
      return { ok: false, error: result.error };
    }
    const cover = (result.cover || '').trim();
    if (cover.length < 50) return { ok: false, error: 'cover too short / empty' };

    const audit = auditProposal(cover);
    const hasUnicodeBold = /[\u{1D400}-\u{1D7FF}]/u.test(cover); // REAL detection, not hardcoded

    // match_score from match_scores (written in score_route)
    let matchScore: any = null;
    const { data: ms } = await sb.from('match_scores').select('total_score').eq('job_id', jobId).eq('account_slug', account.slug).maybeSingle();
    if (ms) matchScore = ms.total_score;

    // proposal row (reuse if exists for this job+account)
    let proposalId: string | null = null;
    const toolsUsed = { extra_qa: result.extra_qa || '', risks: result.risks || '', generator: 'v37' };
    const { data: exP } = await sb.from('proposals').select('id').eq('job_id', jobId).eq('member_slug', account.slug).maybeSingle();
    if (exP) {
      await sb.from('proposals').update({
        proposal_text: cover, match_score: matchScore, status: 'generated',
        generator_version: 'v37', tools_used: toolsUsed,
      }).eq('id', exP.id);
      proposalId = exP.id;
    } else {
      const { data: saved } = await sb.from('proposals').insert({
        job_id: jobId, account_id: account.id, member_slug: account.slug,
        proposal_text: cover, match_score: matchScore, status: 'generated',
        generator_version: 'v37', language: 'EN', tools_used: toolsUsed,
      }).select('id').maybeSingle();
      proposalId = saved?.id || null;
    }

    // proposal_audit with REAL has_unicode_bold
    if (proposalId) {
      try {
        await sb.from('proposal_audit').insert({
          proposal_id: proposalId,
          has_unicode_bold: hasUnicodeBold,
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

    // Telegram to the owner of this account
    const tgSent = await sendCoverTg(account, job, cover, result.extra_qa, proposalId);
    await dbg(sb, 'cover_done', { run_id: runId, account: account.slug, proposal_id: proposalId, quality: audit.quality_score, tg_sent: tgSent });
    return { ok: true, proposal_id: proposalId, tg_sent: tgSent };
  } catch (err) {
    await dbg(sb, 'cover_error', { run_id: runId, err: String(err?.message || err) });
    return { ok: false, error: String(err?.message || err) };
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const sb = db();
  try {
    const body = await req.json();
    const mode = body.mode;

    // ingest_only — unchanged funnel ingest (no AI). Kept as-is.
    if (body.ingest_only) {
      if (!body.job || !body.account_slug) return json({ error: 'need job + account_slug' }, 400);
      const account = await resolveAccount(sb, body.account_slug);
      if (!account) {
        await dbg(sb, 'account_resolve_fail', { account_slug: body.account_slug });
        return json({ error: 'account not found', tried: body.account_slug }, 404);
      }
      const r = await runIngestOnly(body.job, account, {
        prematch_reason: body.prematch_reason, prematch_score: body.prematch_score,
        matched_skills: body.matched_skills, total_skills: body.total_skills,
      });
      return json({ ...r, resolved_account: account.slug }, r.ok ? 200 : 500);
    }

    // ENDPOINT A: score + route
    if (mode === 'score_route') {
      if (!body.job) return json({ error: 'need job' }, 400);
      const watchSlug = body.watch_account_slug || body.account_slug;
      if (!watchSlug) return json({ error: 'need watch_account_slug' }, 400);
      const watchAccount = await resolveAccount(sb, watchSlug);
      if (!watchAccount) {
        await dbg(sb, 'account_resolve_fail', { account_slug: watchSlug });
        return json({ error: 'watch account not found', tried: watchSlug }, 404);
      }
      const r = await runScoreRoute(body.job, watchAccount, { matched_skills: body.matched_skills, total_skills: body.total_skills });
      return json(r, r.ok ? 200 : 500);
    }

    // ENDPOINT B: generate cover for one approved account
    if (mode === 'generate_cover') {
      if (!body.job_id || !body.account_slug) return json({ error: 'need job_id + account_slug' }, 400);
      const r = await runGenerateCover(body.job_id, body.account_slug, body.full_text || '');
      return json(r, r.ok ? 200 : 500);
    }

    // Operator pressed "Отмена" in the panel after a cover was generated → mark proposal(s) cancelled.
    // (TG message already delivered; this flags the DB so the owner/dashboard knows not to submit.)
    if (mode === 'cancel_cover') {
      if (!body.job_id) return json({ error: 'need job_id' }, 400);
      let q = sb.from('proposals').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('job_id', body.job_id);
      if (body.account_slug) q = q.eq('member_slug', body.account_slug);
      const { error } = await q;
      if (error) return json({ error: error.message }, 500);
      await dbg(sb, 'cover_cancelled', { job_id: body.job_id, account_slug: body.account_slug || 'all' });
      return json({ ok: true });
    }

    return json({ error: 'unknown mode', expected: ['score_route', 'generate_cover', 'cancel_cover'], note: 'funnel ingest via ingest_only:true' }, 400);
  } catch (err) {
    return json({ error: String(err?.message || err) }, 500);
  }
});
