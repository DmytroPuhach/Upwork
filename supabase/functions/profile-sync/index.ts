// profile-sync v3
// v3: + /notifications route (DOM-scraped viewed/hired events from /ab/notifications/);
//       + writes accounts.jss_current on my-stats sync.
// v2: fixed alias resolver (team_members.account_id FK)
// Receives parsed payloads from extension after background-tab visits to:
//   /ab/notifications/, /nx/my-stats/, /nx/proposals/, /nx/plans/connects/history/

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const reqEnv = (name: string): string => {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
};

const SB_URL = 'https://nsmcaexdqbipusjuzfht.supabase.co';
const SB_KEY = reqEnv('SB_SERVICE_ROLE');

const sb = () => createClient(SB_URL, SB_KEY, { db: { schema: 'upwork' } });

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, 'Content-Type': 'application/json' }
});

// ---- alias resolution ----
// Accepts: accounts.slug, team_members.slug, OR any value from team_members.aliases
// Returns: { id, slug } of matching accounts row, or null
async function resolveAccount(slugOrAlias: string) {
  const db = sb();
  const needle = (slugOrAlias || '').toLowerCase().trim();
  if (!needle) return null;

  // 1. Direct match on accounts.slug
  const { data: direct } = await db.from('accounts').select('id, slug').eq('slug', needle).maybeSingle();
  if (direct) return direct;

  // 2. Match via team_members.slug OR team_members.aliases (array contains)
  //    Use account_id FK to find corresponding accounts row
  const { data: tm } = await db.from('team_members')
    .select('account_id')
    .or(`slug.eq.${needle},aliases.cs.{${needle}}`)
    .limit(1)
    .maybeSingle();

  if (tm?.account_id) {
    const { data: acc } = await db.from('accounts').select('id, slug').eq('id', tm.account_id).maybeSingle();
    if (acc) return acc;
  }

  return null;
}

// ---- sync log helper ----
async function logSync(account_id: string, account_slug: string, source: string, status: string,
                       items_ingested = 0, items_updated = 0, error_type: string | null = null,
                       error_message: string | null = null, duration_ms = 0, raw_sample: unknown = null) {
  try {
    await sb().from('profile_sync_log').insert({
      account_id, account_slug, source, status,
      items_ingested, items_updated, error_type, error_message, duration_ms,
      raw_sample: raw_sample ? raw_sample : null
    });
  } catch (e) {
    console.error('[profile-sync] logSync failed:', (e as Error).message);
  }
}

// ============================================================
// ROUTE HANDLERS
// ============================================================

// POST /my-stats
async function handleMyStats(body: any) {
  const t0 = Date.now();
  const { account_slug, stats, raw_payload } = body;
  if (!account_slug || !stats) return json({ error: 'missing account_slug or stats' }, 400);

  const acc = await resolveAccount(account_slug);
  if (!acc) return json({ error: `account not found: ${account_slug}` }, 404);

  const today = new Date().toISOString().slice(0, 10);

  const row = {
    account_id: acc.id,
    account_slug: acc.slug,
    snapshot_date: today,
    jss: stats.jss ?? null,
    earnings_12mo_usd: stats.earnings_12mo_usd ?? null,
    connects_balance: stats.connects_balance ?? null,
    connects_earned_next_month: stats.connects_earned_next_month ?? null,
    proposals_sent_7d: stats.proposals_sent_7d ?? null,
    proposals_viewed_7d: stats.proposals_viewed_7d ?? null,
    interviews_7d: stats.interviews_7d ?? null,
    hires_7d: stats.hires_7d ?? null,
    profile_views_7d: stats.profile_views_7d ?? null,
    invites_7d: stats.invites_7d ?? null,
    impressions_7d: stats.impressions_7d ?? null,
    client_relationships_90d_plus_pct: stats.client_relationships_90d_plus_pct ?? null,
    raw_payload: raw_payload ?? null,
    synced_at: new Date().toISOString()
  };

  const { error } = await sb().from('profile_stats_daily').upsert(row, { onConflict: 'account_id,snapshot_date' });
  if (error) {
    await logSync(acc.id, acc.slug, 'my_stats', 'failure', 0, 0, 'db_upsert', error.message, Date.now() - t0, raw_payload);
    return json({ error: error.message }, 500);
  }

  // v3: also write accounts.jss_current for quick dashboard access
  if (stats.jss !== null && stats.jss !== undefined) {
    await sb().from('accounts').update({ jss_current: stats.jss }).eq('id', acc.id).catch(() => {});
  }

  await logSync(acc.id, acc.slug, 'my_stats', 'success', 1, 1, null, null, Date.now() - t0, null);
  return json({ ok: true, account_slug: acc.slug, snapshot_date: today });
}

// POST /proposals
async function handleProposals(body: any) {
  const t0 = Date.now();
  const { account_slug, proposals } = body;
  if (!account_slug || !Array.isArray(proposals)) return json({ error: 'missing account_slug or proposals array' }, 400);

  const acc = await resolveAccount(account_slug);
  if (!acc) return json({ error: `account not found: ${account_slug}` }, 404);

  const db = sb();
  let ingested = 0, updated = 0;
  const errors: string[] = [];

  for (const p of proposals) {
    if (!p.upwork_proposal_id) { errors.push('missing upwork_proposal_id'); continue; }

    const { data: existing } = await db.from('proposals')
      .select('id')
      .eq('upwork_proposal_id', p.upwork_proposal_id).maybeSingle();

    const patch: Record<string, unknown> = {
      upwork_proposal_id: p.upwork_proposal_id,
      upwork_proposal_url: p.upwork_proposal_url ?? null,
      last_synced_at: new Date().toISOString(),
      sync_source: 'nx_proposals'
    };
    if (p.status) patch.status = p.status;
    if (p.sent_at) patch.sent_at = p.sent_at;
    if (p.viewed_at) patch.viewed_at = p.viewed_at;
    if (p.first_client_reply_at) patch.first_client_reply_at = p.first_client_reply_at;
    if (p.replied_at) patch.replied_at = p.replied_at;
    if (p.hired_at) patch.hired_at = p.hired_at;
    if (typeof p.interview_count === 'number') patch.interview_count = p.interview_count;
    if (typeof p.connects_used === 'number') patch.connects_used = p.connects_used;
    if (typeof p.is_winner === 'boolean') patch.is_winner = p.is_winner;
    if (p.outcome) patch.outcome = p.outcome;

    if (existing) {
      const { error } = await db.from('proposals').update(patch).eq('id', existing.id);
      if (error) errors.push(`update ${p.upwork_proposal_id}: ${error.message}`);
      else updated++;
    } else {
      const stub = {
        ...patch,
        account_id: acc.id,
        member_slug: acc.slug,
        proposal_text: p.proposal_text ?? '(not captured — synced from /nx/proposals/)',
        generator_version: 'external',
        created_at: p.sent_at ?? new Date().toISOString()
      };
      const { error } = await db.from('proposals').insert(stub);
      if (error) errors.push(`insert ${p.upwork_proposal_id}: ${error.message}`);
      else ingested++;
    }
  }

  const status = errors.length === 0 ? 'success' : (ingested + updated > 0 ? 'partial' : 'failure');
  await logSync(acc.id, acc.slug, 'proposals', status, ingested, updated,
    errors.length > 0 ? 'partial_errors' : null,
    errors.length > 0 ? errors.slice(0, 5).join('; ') : null,
    Date.now() - t0, proposals[0] ?? null);

  return json({ ok: true, account_slug: acc.slug, ingested, updated, errors: errors.length });
}

// POST /connects-history
async function handleConnectsHistory(body: any) {
  const t0 = Date.now();
  const { account_slug, transactions } = body;
  if (!account_slug || !Array.isArray(transactions)) return json({ error: 'missing account_slug or transactions array' }, 400);

  const acc = await resolveAccount(account_slug);
  if (!acc) return json({ error: `account not found: ${account_slug}` }, 404);

  const db = sb();
  let ingested = 0;
  const errors: string[] = [];

  for (const tx of transactions) {
    if (!tx.upwork_transaction_id || !tx.transaction_type || typeof tx.delta !== 'number' || !tx.occurred_at) {
      errors.push('missing required field'); continue;
    }

    let proposal_id: string | null = null;
    if (tx.upwork_proposal_id) {
      const { data: prop } = await db.from('proposals')
        .select('id').eq('upwork_proposal_id', tx.upwork_proposal_id).maybeSingle();
      if (prop) proposal_id = prop.id;
    }

    const row = {
      account_id: acc.id,
      account_slug: acc.slug,
      upwork_transaction_id: tx.upwork_transaction_id,
      upwork_proposal_id: tx.upwork_proposal_id ?? null,
      upwork_job_id: tx.upwork_job_id ?? null,
      transaction_type: tx.transaction_type,
      delta: tx.delta,
      balance_after: tx.balance_after ?? null,
      description: tx.description ?? null,
      proposal_id,
      occurred_at: tx.occurred_at,
      raw_payload: tx.raw ?? null
    };

    const { error } = await db.from('connects_ledger').upsert(row, { onConflict: 'account_id,upwork_transaction_id' });
    if (error) errors.push(`${tx.upwork_transaction_id}: ${error.message}`);
    else ingested++;
  }

  const status = errors.length === 0 ? 'success' : (ingested > 0 ? 'partial' : 'failure');
  await logSync(acc.id, acc.slug, 'connects_history', status, ingested, 0,
    errors.length > 0 ? 'partial_errors' : null,
    errors.length > 0 ? errors.slice(0, 5).join('; ') : null,
    Date.now() - t0, transactions[0] ?? null);

  return json({ ok: true, account_slug: acc.slug, ingested, errors: errors.length });
}

// POST /notifications
// Receives DOM-scraped events from /ab/notifications/ and updates
// proposals.viewed_at / proposals.hired_at for matching proposal rows.
async function handleNotifications(body: any) {
  const t0 = Date.now();
  const { account_slug, notifications } = body;
  if (!account_slug || !Array.isArray(notifications)) return json({ error: 'missing account_slug or notifications' }, 400);

  const acc = await resolveAccount(account_slug);
  if (!acc) return json({ error: `account not found: ${account_slug}` }, 404);

  const db = sb();
  let updated = 0;
  const errors: string[] = [];

  for (const n of notifications) {
    if (!n.upwork_job_id || !n.timestamp) continue;
    if (n.type !== 'proposal_viewed' && n.type !== 'hired') continue;

    // Find the proposal by matching job URL pattern — proposals.upwork_proposal_url contains the job URL
    const jobIdClean = String(n.upwork_job_id).replace(/^~/, '');
    const { data: proposal } = await db.from('proposals')
      .select('id, viewed_at, hired_at')
      .eq('account_id', acc.id)
      .ilike('upwork_proposal_url', `%~${jobIdClean}%`)
      .maybeSingle();

    if (!proposal) continue;

    const patch: Record<string, unknown> = {};
    // Only set if not already recorded (don't overwrite newer values with stale DOM timestamps)
    if (n.type === 'proposal_viewed' && !proposal.viewed_at) {
      patch.viewed_at = n.timestamp;
    } else if (n.type === 'hired' && !proposal.hired_at) {
      patch.hired_at = n.timestamp;
    }

    if (Object.keys(patch).length === 0) continue;

    const { error } = await db.from('proposals').update(patch).eq('id', proposal.id);
    if (error) errors.push(`${jobIdClean}: ${error.message}`);
    else updated++;
  }

  const status = errors.length === 0 ? 'success' : (updated > 0 ? 'partial' : 'failure');
  await logSync(acc.id, acc.slug, 'notifications', status, 0, updated,
    errors.length > 0 ? 'partial_errors' : null,
    errors.length > 0 ? errors.slice(0, 3).join('; ') : null,
    Date.now() - t0, notifications[0] ?? null);

  return json({ ok: true, account_slug: acc.slug, updated, errors: errors.length, parsed: notifications.length });
}

// ============================================================
// ROUTER
// ============================================================
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid json' }, 400); }

  const url = new URL(req.url);
  const route = url.pathname.split('/').pop();

  try {
    switch (route) {
      case 'my-stats':         return await handleMyStats(body);
      case 'proposals':        return await handleProposals(body);
      case 'connects-history': return await handleConnectsHistory(body);
      case 'notifications':    return await handleNotifications(body);
      case 'ping':             return json({ ok: true, ts: new Date().toISOString() });
      default: return json({ error: `unknown route: ${route}`, routes: ['my-stats', 'proposals', 'connects-history', 'notifications', 'ping'] }, 404);
    }
  } catch (e) {
    console.error('[profile-sync] unhandled:', (e as Error).message, (e as Error).stack);
    return json({ error: (e as Error).message }, 500);
  }
});
