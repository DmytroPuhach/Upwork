// extension-job-enrich v9 — returns full score_route result as `score` (drives radar operator panel).
// extension-job-enrich v8 — calls leadgen-v2 mode:"score_route" (was sync full pipeline);
//     covers are now generated later via mode:"generate_cover" after human approval.
// extension-job-enrich v7 — SECURITY: /outbound now authenticates caller via machine_id in
//     extension_status (anon key is public); account taken from machine, body.account_slug ignored for auth.
// extension-job-enrich v6 — STEP 0: secrets to Deno.env; + /outbound route (extension no longer holds service_role).
// extension-job-enrich v5 — добавлено к v4:
//   - принимает enrichment.screening_strategy (телеметрия какой selector сработал)
//     пишет в enrichment_log.error_detail (там чистая строка) в формате 'sq=N:strategy'
//     чтобы в 1 запросе SELECT видеть как часто text-anchor vs legacy vs none
//
// v3: matched_skills / total_skills.
// v2: heal title on UPDATE.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const reqEnv = (name: string): string => {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
};

const SB_URL = 'https://nsmcaexdqbipusjuzfht.supabase.co';
const SB_KEY = reqEnv('SB_SERVICE_ROLE');
const TG_BOT = reqEnv('TG_AGENTS_TOKEN');
const TG_CHAT = reqEnv('TG_CHAT_ID');

const db = () => createClient(SB_URL, SB_KEY, { db: { schema: 'upwork' } });

function parseBudget(raw: string | null | undefined) {
  if (!raw) return { type: null as string | null, min: null as number | null, max: null as number | null };
  const r = String(raw).toLowerCase();
  const hourlyRange = r.match(/\$\s*([\d.,]+)\s*[-–]\s*\$?\s*([\d.,]+)\s*(?:\/\s*h|hr|hour|hourly)/);
  if (hourlyRange) return { type: 'hourly', min: parseFloat(hourlyRange[1].replace(/,/g, '')), max: parseFloat(hourlyRange[2].replace(/,/g, '')) };
  const hourlySingle = r.match(/\$\s*([\d.,]+)\s*(?:\/\s*h|hr|hour|hourly)/);
  if (hourlySingle) { const v = parseFloat(hourlySingle[1].replace(/,/g, '')); return { type: 'hourly', min: v, max: v }; }
  if (/fixed[-\s]?price/.test(r)) {
    const fr = r.match(/\$\s*([\d.,]+)\s*[-–]\s*\$?\s*([\d.,]+)/);
    if (fr) return { type: 'fixed', min: parseFloat(fr[1].replace(/,/g, '')), max: parseFloat(fr[2].replace(/,/g, '')) };
    const fs = r.match(/\$\s*([\d.,]+)/);
    if (fs) { const v = parseFloat(fs[1].replace(/,/g, '')); return { type: 'fixed', min: v, max: v }; }
  }
  const fixedRange = r.match(/\$\s*([\d.,]+)\s*[-–]\s*\$?\s*([\d.,]+)/);
  if (fixedRange) return { type: 'fixed', min: parseFloat(fixedRange[1].replace(/,/g, '')), max: parseFloat(fixedRange[2].replace(/,/g, '')) };
  const fixedSingle = r.match(/\$\s*([\d.,]+)/);
  if (fixedSingle) { const v = parseFloat(fixedSingle[1].replace(/,/g, '')); return { type: 'fixed', min: v, max: v }; }
  return { type: null, min: null, max: null };
}

function parseMemberSince(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().substring(0, 10);
}

function parsePostedAt(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const r = raw.trim().toLowerCase();
  const rel = r.match(/(\d+)\s*(minute|hour|day|week)s?\s*ago/);
  if (rel) {
    const n = parseInt(rel[1]);
    const unit = rel[2];
    const ms = unit === 'minute' ? n * 60000 : unit === 'hour' ? n * 3600000 : unit === 'day' ? n * 86400000 : n * 7 * 86400000;
    return new Date(Date.now() - ms).toISOString();
  }
  const abs = new Date(raw);
  if (!isNaN(abs.getTime())) return abs.toISOString();
  return null;
}

function isBadTitle(t: string | null | undefined): boolean {
  if (!t) return true;
  const s = String(t).trim().toLowerCase();
  return s === '' || s === 'unknown' || s === 'null' || s === 'n/a';
}

async function handleEnrich(req: Request): Promise<Response> {
  const sb = db();
  const started = Date.now();
  let body: any;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: 'bad JSON' }), { status: 400 }); }
  const { machine_id, account_slug, enrichment, matched_skills, total_skills, search_title } = body;
  if (!enrichment?.upwork_job_id && !enrichment?.upwork_id) return new Response(JSON.stringify({ error: 'missing upwork_job_id' }), { status: 400 });
  const upworkId = enrichment.upwork_job_id || enrichment.upwork_id;
  // Best available title: enrich.js extraction > search card title > 'unknown'
  const bestTitle = (enrichment.title && !isBadTitle(enrichment.title))
    ? enrichment.title
    : (search_title && !isBadTitle(search_title) ? search_title : null);
  const description = String(enrichment.description || '').substring(0, 10000);
  if (description.length < 200) return new Response(JSON.stringify({ error: 'description too short' }), { status: 400 });

  let jobRow: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data } = await sb.from('jobs').select('id, title, matched_account_id, is_enriched, enrichment_attempts').eq('upwork_job_id', upworkId).maybeSingle();
    if (data) { jobRow = data; break; }
    if (attempt < 2) await new Promise(r => setTimeout(r, 400));
  }

  if (!jobRow) {
    const { data: acc } = await sb.from('accounts').select('id').eq('slug', account_slug || '').maybeSingle();
    const { data: inserted, error: insErr } = await sb.from('jobs').insert({
      upwork_job_id: upworkId,
      title: (bestTitle || 'unknown').substring(0, 500),
      description: '',
      upwork_url: (enrichment.url || '').substring(0, 500),
      matched_account_id: acc?.id || null,
    }).select('id, title, matched_account_id, is_enriched, enrichment_attempts').single();
    if (insErr || !inserted) return new Response(JSON.stringify({ error: 'could not create job row', detail: insErr?.message }), { status: 500 });
    jobRow = inserted;
  }

  const c = enrichment.client || {};
  const m = enrichment.meta || {};
  const budgetParsed = parseBudget(enrichment.budget_raw);

  const updatePayload: Record<string, any> = {
    description, raw_description: description,
    is_enriched: true, enriched_at: new Date().toISOString(),
    enrichment_attempts: (jobRow.enrichment_attempts || 0) + 1, enrichment_error: null,
  };

  if (isBadTitle(jobRow.title) && bestTitle) {
    updatePayload.title = String(bestTitle).substring(0, 500);
  }

  if (budgetParsed.type) updatePayload.budget_type = budgetParsed.type;
  if (budgetParsed.min !== null) updatePayload.budget_min = budgetParsed.min;
  if (budgetParsed.max !== null) updatePayload.budget_max = budgetParsed.max;
  if (c.country) updatePayload.client_country = c.country;
  if (typeof c.rating === 'number') updatePayload.client_rating = c.rating;
  if (typeof c.hires === 'number') updatePayload.client_hires = c.hires;
  if (typeof c.total_spent === 'number') updatePayload.client_spent_total = c.total_spent;
  if (typeof c.total_hours === 'number') updatePayload.client_total_hours = c.total_hours;
  if (typeof c.hire_rate === 'number') updatePayload.client_hire_rate = c.hire_rate;
  if (typeof c.avg_hourly_paid === 'number') updatePayload.client_avg_hourly_paid = c.avg_hourly_paid;
  const memberSince = parseMemberSince(c.member_since);
  if (memberSince) updatePayload.client_member_since = memberSince;
  if (Array.isArray(enrichment.skills) && enrichment.skills.length > 0) updatePayload.skills = enrichment.skills.slice(0, 30);
  if (Array.isArray(enrichment.screening_questions) && enrichment.screening_questions.length > 0) updatePayload.screening_questions = enrichment.screening_questions.slice(0, 20);
  if (m.project_length) updatePayload.project_length = m.project_length;
  if (m.experience_level) updatePayload.experience_level = m.experience_level;
  if (m.hours_per_week) updatePayload.hours_per_week = m.hours_per_week;
  const postedAt = parsePostedAt(m.posted_raw);
  if (postedAt) updatePayload.posted_at = postedAt;

  const { error: updErr } = await sb.from('jobs').update(updatePayload).eq('id', jobRow.id);
  if (updErr) return new Response(JSON.stringify({ error: 'update failed', detail: updErr.message }), { status: 500 });

  // v4: screening telemetry — логируем сколько и какой strategy нашла questions
  const sqCount = Array.isArray(enrichment.screening_questions) ? enrichment.screening_questions.length : 0;
  const sqStrategy = String(enrichment.screening_strategy || 'unknown').substring(0, 80);
  const stFlag = search_title ? `ok(${String(search_title).substring(0, 20)})` : 'null';
  const sqTelemetry = `sq=${sqCount}:${sqStrategy}:st=${stFlag}`;

  await sb.from('enrichment_log').insert({
    machine_id: machine_id || null, account_slug: account_slug || null,
    job_id: jobRow.id, upwork_job_id: upworkId,
    status: 'success', description_chars: description.length, duration_ms: Date.now() - started,
    error_detail: sqTelemetry,
  });

  if (jobRow.is_enriched) return new Response(JSON.stringify({ ok: true, re_enriched: true, job_id: jobRow.id, sq_telemetry: sqTelemetry }), { status: 200 });

  const effectiveTitle = updatePayload.title || jobRow.title;

  const pipelineJob = {
    upwork_id: upworkId, upwork_job_id: upworkId, title: effectiveTitle, description,
    budget_type: updatePayload.budget_type, budget_min: updatePayload.budget_min, budget_max: updatePayload.budget_max,
    client_country: updatePayload.client_country, client_rating: updatePayload.client_rating,
    client_hires: updatePayload.client_hires, client_spent_total: updatePayload.client_spent_total,
    skills: updatePayload.skills, url: enrichment.url, upwork_url: enrichment.url,
    screening_questions: updatePayload.screening_questions || [],
  };

  // v37: score+route only (covers are generated later, after a human approves in the panel).
  // We still call synchronously so the extension learns which accounts fit (tab management).
  let biddingAccounts: string[] = [];
  let scoreResult: any = null;  // full score_route response → drives the radar operator panel
  try {
    const lgResp = await fetch(`${SB_URL}/functions/v1/leadgen-v2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SB_KEY}` },
      body: JSON.stringify({
        mode: 'score_route',
        watch_account_slug: account_slug,
        job: pipelineJob,
        matched_skills: Number(matched_skills) || 0,
        total_skills: Number(total_skills) || 0,
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (lgResp.ok) {
      scoreResult = await lgResp.json().catch(() => null);
      biddingAccounts = Array.isArray(scoreResult?.account_fit) ? scoreResult.account_fit.map((f: any) => f.account_slug).filter(Boolean) : [];
    }
  } catch (_e) {
    // timeout or network — extension keeps tab open (safe default)
  }

  return new Response(JSON.stringify({
    ok: true, job_id: jobRow.id, pipeline_triggered: true,
    title_healed: !!updatePayload.title,
    passed_matched_skills: Number(matched_skills) || 0,
    sq_telemetry: sqTelemetry,
    bidding_accounts: biddingAccounts,
    score: scoreResult,   // full score_route output for the radar operator panel
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function handleLog(req: Request): Promise<Response> {
  const sb = db();
  let body: any;
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
  const { machine_id, account_slug, status, upwork_job_id, description_chars, duration_ms, error_type, error_detail } = body;
  await sb.from('enrichment_log').insert({
    machine_id: machine_id || null, account_slug: account_slug || null,
    upwork_job_id: upwork_job_id || null, status: status || 'unknown',
    description_chars: description_chars || null, duration_ms: duration_ms || null,
    error_type: error_type || null, error_detail: (error_detail || '').substring(0, 500),
  });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

async function handleHaltAlert(req: Request): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
  const { machine_id, account_slug, reason, halted_minutes } = body;
  const msg = `🛑 <b>Enrichment HALTED</b>\n\nAccount: <code>${account_slug || '?'}</code>\nMachine: <code>${(machine_id || '?').substring(0, 8)}</code>\nReason: <b>${reason || 'unknown'}</b>\nHalted for: ${halted_minutes || '?'} min\n\n⚠️ Likely Upwork logout/challenge. Check browser, log back in, and the extension will resume automatically.`;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch {}
  try {
    const sb = db();
    await sb.from('enrichment_log').insert({ machine_id: machine_id || null, account_slug: account_slug || null, status: 'halted', error_type: reason || 'unknown', error_detail: `halted ${halted_minutes}m` });
  } catch {}
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

// STEP 0: extension no longer holds service_role. Outbound chat messages are saved here.
// The anon key is public (ships in the extension), so it is NOT proof of identity.
// Caller is authenticated by machine_id existing in extension_status; the account is
// taken from the machine's own registration — body.account_slug is ignored for auth.
async function handleOutbound(req: Request): Promise<Response> {
  const sb = db();
  let body: any;
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }

  const machineId = body.machine_id;
  if (!machineId) return new Response(JSON.stringify({ error: 'need machine_id' }), { status: 400 });

  // AUTH: machine must be registered (heartbeat) — resolves its own account_slug.
  const { data: ext } = await sb.from('extension_status').select('account_slug').eq('machine_id', machineId).maybeSingle();
  if (!ext?.account_slug) return new Response(JSON.stringify({ error: 'unknown machine' }), { status: 403 });
  const slug = String(ext.account_slug).toLowerCase();

  // Resolve account_id: accounts.slug, else team_members(slug|alias).account_id
  let accountId: string | null = null;
  const { data: acc } = await sb.from('accounts').select('id').eq('slug', slug).maybeSingle();
  if (acc?.id) accountId = acc.id;
  if (!accountId) {
    const { data: tm } = await sb.from('team_members').select('account_id').eq('slug', slug).maybeSingle();
    if (tm?.account_id) accountId = tm.account_id;
    else {
      const { data: tmA } = await sb.from('team_members').select('account_id').contains('aliases', [slug]).maybeSingle();
      if (tmA?.account_id) accountId = tmA.account_id;
    }
  }
  if (!accountId) return new Response(JSON.stringify({ skipped: 'no_account', slug }), { status: 200 });

  const name = body.client_name || '';
  const { data: cli } = await sb.from('clients').select('id').ilike('name', name).limit(1).maybeSingle();
  if (!cli?.id) return new Response(JSON.stringify({ skipped: 'client_not_found', name }), { status: 200 });

  const { error: insErr } = await sb.from('messages_context').insert({
    client_id: cli.id,
    account_id: accountId,
    message_direction: 'outbound',
    raw_text: body.text || '',
    summary: (body.text || '').substring(0, 300),
    chat_url: body.chat_url || null,
  });
  if (insErr) return new Response(JSON.stringify({ error: insErr.message }), { status: 500 });
  return new Response(JSON.stringify({ ok: true, saved: 'outbound', client: name }), { status: 200 });
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const url = new URL(req.url);
  const path = url.pathname;
  try {
    if (path.endsWith('/log')) return await handleLog(req);
    if (path.endsWith('/halt-alert')) return await handleHaltAlert(req);
    if (path.endsWith('/outbound')) return await handleOutbound(req);
    return await handleEnrich(req);
  } catch (err) {
    return new Response(JSON.stringify({ error: String((err as Error)?.message || err) }), { status: 500 });
  }
});
