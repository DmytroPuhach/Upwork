// extension-config v11
// v11: heartbeat no longer overwrites a resolved account_slug with 'unknown' (preserves the
//      identify machine_id-fallback anchor). DEPLOY WITH --no-verify-jwt (extension calls have no auth header).
// v10: /identify machine_id fallback — resolve account via extension_status when page uid is missing
//      (survives detectUpworkUser breakage from Upwork UI changes).
// v9: SECURITY — /toggle-bidding now authenticates caller via machine_id in extension_status
//     (anon key is public). Machine may only toggle its OWN account; body.slug ignored for auth.
// v8: STEP 0 — secrets to Deno.env; + /toggle-bidding route (extension no longer holds service_role).
// v7: include account.timezone in /identify response (client uses it for quiet_hours)
// v6: + /preset endpoint (POST) to update account.scrape_preset from popup.
//     + /identify now returns scrape_preset alongside account.
// v5 HOTFIX: dedup scraper_error alerts.
// FIX v4: scrape_commands.account_slug = account.slug.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const reqEnv = (name: string): string => {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
};

const SB_URL = 'https://nsmcaexdqbipusjuzfht.supabase.co';
const SB_KEY = reqEnv('SB_SERVICE_ROLE');
const TG_BRAIN = reqEnv('TG_BRAIN_TOKEN');
const DIMA_CHAT = reqEnv('TG_CHAT_ID');
const ERROR_ALERT_THROTTLE_MIN = 30;

const db = () => createClient(SB_URL, SB_KEY, { db: { schema: 'upwork' } });

function cors(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': '*' } });
}

async function tgAlert(text: string) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_BRAIN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: DIMA_CHAT, text: text.substring(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true }) });
  } catch {}
}

function versionCompare(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n) || 0);
  const pb = b.split('.').map(n => parseInt(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors({ ok: true });
  const url = new URL(req.url);
  const path = url.pathname.split('/').pop() || '';
  const sb = db();

  try {
    if (path === 'identify' || path === 'extension-config') {
      const body = req.method === 'POST' ? await req.json() : {};
      const upwork_user_id = body.upwork_user_id || url.searchParams.get('upwork_user_id');
      const account_slug_hint = (body.account_slug || url.searchParams.get('account_slug') || '').toLowerCase();
      const machine_id = body.machine_id || url.searchParams.get('machine_id');

      let member: any = null;
      if (upwork_user_id) {
        const { data } = await sb.from('team_members').select('id, slug, full_name, display_name, account_id, role, is_active, is_bidding_enabled, permissions, aliases').eq('upwork_user_id', upwork_user_id).eq('is_active', true).maybeSingle();
        if (data) member = data;
      }
      if (!member && account_slug_hint) {
        const { data: bySlug } = await sb.from('team_members').select('id, slug, full_name, display_name, account_id, role, is_active, is_bidding_enabled, permissions, aliases').eq('slug', account_slug_hint).eq('is_active', true).maybeSingle();
        if (bySlug) member = bySlug;
        else {
          const { data: byAlias } = await sb.from('team_members').select('id, slug, full_name, display_name, account_id, role, is_active, is_bidding_enabled, permissions, aliases').contains('aliases', [account_slug_hint]).eq('is_active', true).maybeSingle();
          if (byAlias) member = byAlias;
        }
        if (member && upwork_user_id) await sb.from('team_members').update({ upwork_user_id }).eq('id', member.id);
      }
      // Fallback: resolve by machine_id from a prior successful identification (extension_status).
      // Keeps a machine identified even when the page no longer exposes the Upwork uid
      // (e.g. UI change broke detectUpworkUser). Backfills upwork_user_id if we now have one.
      if (!member && machine_id) {
        const { data: ext } = await sb.from('extension_status').select('account_slug').eq('machine_id', machine_id).maybeSingle();
        const knownSlug = (ext?.account_slug && ext.account_slug !== 'unknown') ? String(ext.account_slug).toLowerCase() : null;
        if (knownSlug) {
          const { data: byMachine } = await sb.from('team_members').select('id, slug, full_name, display_name, account_id, role, is_active, is_bidding_enabled, permissions, aliases').eq('slug', knownSlug).eq('is_active', true).maybeSingle();
          if (byMachine) {
            member = byMachine;
            if (upwork_user_id && !byMachine.upwork_user_id) await sb.from('team_members').update({ upwork_user_id }).eq('id', byMachine.id);
          }
        }
      }
      if (!member) {
        await tgAlert(`⚠️ <b>Extension на unknown Upwork account</b>\nhint: <code>${account_slug_hint || '?'}</code>\nmachine: <code>${machine_id || '?'}</code>`);
        return cors({ ok: false, status: 'unknown_account', message: 'Extension running on unknown account', should_pause: true });
      }

      // v7: include scrape_preset + timezone in account select
      const { data: account } = await sb.from('accounts').select('id, slug, name, bidding_enabled, blocked_countries, specialization, scrape_preset, timezone').eq('id', member.account_id).maybeSingle();
      const accountSlugForScrape = account?.slug || member.slug;
      const { data: scrapeCmd } = await sb.from('scrape_commands').select('*').eq('account_slug', accountSlugForScrape).maybeSingle();
      const { data: currentVersion } = await sb.from('extension_versions').select('version, download_url, min_supported_version, changelog').eq('is_current', true).maybeSingle();

      return cors({
        ok: true,
        member: { id: member.id, slug: member.slug, display_name: member.display_name, full_name: member.full_name, role: member.role, is_bidding_enabled: member.is_bidding_enabled, permissions: member.permissions },
        account: account || null,
        scrape_preset: account?.scrape_preset || { query: 'seo', sort: 'recency', hourly: null },
        scrape_settings: scrapeCmd ? {
          pattern_mode: scrapeCmd.pattern_mode, next_scrape_at: scrapeCmd.next_scrape_at, cooldown_until: scrapeCmd.cooldown_until, enabled: scrapeCmd.enabled,
          min_interval_sec: (scrapeCmd.min_interval_minutes || 3) * 60, max_interval_sec: (scrapeCmd.max_interval_minutes || 45) * 60,
          quiet_hours_start: scrapeCmd.quiet_hours_start || 22, quiet_hours_end: scrapeCmd.quiet_hours_end || 7,
          // v7: prefer account.timezone over scrape_commands.timezone
          timezone: account?.timezone || scrapeCmd.timezone || 'UTC'
        } : null,
        current_version: currentVersion,
        endpoints: { heartbeat: `${SB_URL}/functions/v1/extension-config/heartbeat`, leadgen: `${SB_URL}/functions/v1/leadgen-v2`, reply_generator: `${SB_URL}/functions/v1/reply-generator`, proposals_sync: `${SB_URL}/functions/v1/proposals-sync`, preset: `${SB_URL}/functions/v1/extension-config/preset` }
      });
    }

    if (path === 'heartbeat') {
      if (req.method !== 'POST') return cors({ error: 'POST only' }, 405);
      const body = await req.json();
      const { account_slug, upwork_user_id, version, machine_id, user_agent, scraper_status, scraper_error, jobs_scraped_today, messages_captured_today } = body;
      if (!machine_id || !version) return cors({ error: 'need machine_id + version' }, 400);

      const now = new Date().toISOString();
      const { data: existing } = await sb.from('extension_status').select('id, version, scraper_error, last_error_alert_at, account_slug').eq('machine_id', machine_id).maybeSingle();

      // v11: an 'unknown' heartbeat must NOT erase a previously-resolved account_slug —
      // that anchor is exactly what /identify's machine_id fallback relies on.
      const incomingSlug = (account_slug && account_slug !== 'unknown') ? account_slug : null;
      const keepSlug = incomingSlug
        || ((existing?.account_slug && existing.account_slug !== 'unknown') ? existing.account_slug : 'unknown');

      let member_id: string | null = null;
      if (keepSlug && keepSlug !== 'unknown') {
        const { data: m } = await sb.from('team_members').select('id').eq('slug', keepSlug).maybeSingle();
        member_id = m?.id || null;
      }

      const isVersionChange = existing && existing.version !== version;
      const newError = scraper_error || null;
      const prevError = existing?.scraper_error || null;

      let shouldAlertError = false;
      if (newError) {
        if (newError !== prevError) shouldAlertError = true;
        else if (existing?.last_error_alert_at) {
          const mins = (Date.now() - new Date(existing.last_error_alert_at).getTime()) / 60000;
          if (mins >= ERROR_ALERT_THROTTLE_MIN) shouldAlertError = true;
        } else shouldAlertError = true;
      }

      const updatePayload: Record<string, any> = {
        member_id, account_slug: keepSlug, upwork_user_id, version, user_agent,
        last_heartbeat_at: now, last_activity_at: now,
        scraper_status: scraper_status || 'active', scraper_error: newError,
        jobs_scraped_today: jobs_scraped_today || 0, messages_captured_today: messages_captured_today || 0,
        updated_at: now
      };
      if (shouldAlertError) updatePayload.last_error_alert_at = now;

      if (existing) {
        await sb.from('extension_status').update(updatePayload).eq('id', existing.id);
        try { await sb.rpc('increment_heartbeat', { mid: machine_id }); } catch {}
        if (isVersionChange) await tgAlert(`🔄 <b>Extension updated</b>\nmember: <code>${account_slug}</code>\n${existing.version} → <b>${version}</b>\nmachine: <code>${machine_id.substring(0, 12)}...</code>`);
      } else {
        await sb.from('extension_status').insert({ ...updatePayload, machine_id, created_at: now });
        await tgAlert(`🟢 <b>New extension install</b>\nmember: <code>${account_slug || '?'}</code>\nversion: <code>${version}</code>\nmachine: <code>${machine_id.substring(0, 12)}...</code>`);
      }

      const { data: curVer } = await sb.from('extension_versions').select('version, download_url, min_supported_version, changelog, is_deprecated').eq('is_current', true).maybeSingle();
      let update_info: any = null;
      let force_update = false;
      if (curVer) {
        const cmp = versionCompare(version, curVer.version);
        if (cmp < 0) {
          update_info = { current_version: version, latest_version: curVer.version, download_url: curVer.download_url, changelog: curVer.changelog, update_available: true };
          if (curVer.min_supported_version && versionCompare(version, curVer.min_supported_version) < 0) { force_update = true; update_info.force_update = true; }
        }
      }

      if (shouldAlertError && newError) await tgAlert(`❌ <b>Extension error</b>\nmember: ${account_slug}\nversion: ${version}\nerror: <code>${String(newError).substring(0, 300)}</code>`);

      return cors({ ok: true, heartbeat_received_at: now, update_info, force_update, scrape_next_check_in_sec: 60 });
    }

    if (path === 'check-update') {
      const current = url.searchParams.get('version') || '0.0.0';
      const { data: curVer } = await sb.from('extension_versions').select('version, download_url, min_supported_version, changelog').eq('is_current', true).maybeSingle();
      if (!curVer) return cors({ ok: true, update_available: false });
      const cmp = versionCompare(current, curVer.version);
      return cors({ ok: true, current_installed: current, latest: curVer.version, update_available: cmp < 0, download_url: cmp < 0 ? curVer.download_url : null, force_update: curVer.min_supported_version && versionCompare(current, curVer.min_supported_version) < 0, changelog: cmp < 0 ? curVer.changelog : null });
    }

    if (path === 'preset') {
      if (req.method !== 'POST') return cors({ error: 'POST only' }, 405);
      const body = await req.json();
      const { machine_id, scrape_preset } = body;
      if (!machine_id || !scrape_preset || typeof scrape_preset !== 'object') return cors({ error: 'need machine_id + scrape_preset' }, 400);

      const { data: ext } = await sb.from('extension_status').select('account_slug').eq('machine_id', machine_id).maybeSingle();
      if (!ext?.account_slug) return cors({ error: 'unknown machine' }, 404);

      let accountId: string | null = null;
      const slugLower = String(ext.account_slug).toLowerCase();
      const { data: tmBySlug } = await sb.from('team_members').select('account_id').eq('slug', slugLower).maybeSingle();
      if (tmBySlug?.account_id) accountId = tmBySlug.account_id;
      if (!accountId) {
        const { data: tmAlias } = await sb.from('team_members').select('account_id').contains('aliases', [slugLower]).maybeSingle();
        if (tmAlias?.account_id) accountId = tmAlias.account_id;
      }
      if (!accountId) {
        const { data: acc } = await sb.from('accounts').select('id').eq('slug', slugLower).maybeSingle();
        if (acc?.id) accountId = acc.id;
      }
      if (!accountId) return cors({ error: 'account not resolvable' }, 404);

      const sanitized: Record<string, any> = {
        query: String(scrape_preset.query || 'seo').substring(0, 100),
        sort: ['recency', 'relevance'].includes(scrape_preset.sort) ? scrape_preset.sort : 'recency',
        hourly: scrape_preset.hourly === true ? true : scrape_preset.hourly === false ? false : null,
        updated_at: new Date().toISOString(),
      };
      await sb.from('accounts').update({ scrape_preset: sanitized }).eq('id', accountId);
      return cors({ ok: true, scrape_preset: sanitized });
    }

    if (path === 'toggle-bidding') {
      // Extension calls this with the (public) anon key, so the anon key alone is NOT
      // proof of identity. Caller is authenticated by machine_id existing in
      // extension_status (same pattern as /preset). A machine may only toggle bidding
      // for ITS OWN account — body.slug is ignored for authorization.
      if (req.method !== 'POST') return cors({ error: 'POST only' }, 405);
      const body = await req.json();
      const machine_id = body.machine_id;
      const enabled = body.enabled === true ? true : body.enabled === false ? false : null;
      if (!machine_id) return cors({ error: 'need machine_id' }, 400);
      if (enabled === null) return cors({ error: 'need enabled:boolean' }, 400);

      // AUTH: machine must be registered (heartbeat) — resolves its own account_slug.
      const { data: ext } = await sb.from('extension_status').select('account_slug').eq('machine_id', machine_id).maybeSingle();
      if (!ext?.account_slug) return cors({ error: 'unknown machine' }, 403);
      const slug = String(ext.account_slug).toLowerCase();

      // Find member by the machine's own slug, then alias fallback
      let { data: member } = await sb.from('team_members').select('id, slug').eq('slug', slug).maybeSingle();
      if (!member) {
        const { data: byAlias } = await sb.from('team_members').select('id, slug').contains('aliases', [slug]).maybeSingle();
        member = byAlias || null;
      }
      if (!member) return cors({ error: 'team_member not found', slug }, 404);

      const { error: updErr } = await sb.from('team_members').update({ is_bidding_enabled: enabled }).eq('id', member.id);
      if (updErr) return cors({ error: updErr.message }, 500);
      return cors({ ok: true, slug: member.slug, is_bidding_enabled: enabled });
    }

    if (path === 'team') {
      const { data } = await sb.from('team_members').select('slug, display_name, full_name, role, is_active, is_bidding_enabled, upwork_user_id, upwork_profile_url').eq('is_active', true).order('role', { ascending: false });
      return cors({ ok: true, team: data || [] });
    }

    if (path === 'status') {
      const { data: statuses } = await sb.from('extension_status').select('account_slug, version, last_heartbeat_at, scraper_status, scraper_error, jobs_scraped_today, messages_captured_today, machine_id').order('last_heartbeat_at', { ascending: false });
      const enriched = (statuses || []).map((s: any) => { const minsAgo = Math.round((Date.now() - new Date(s.last_heartbeat_at).getTime()) / 60000); return { ...s, machine_id: s.machine_id?.substring(0, 8) + '...', online: minsAgo < 15, minutes_since_last_heartbeat: minsAgo }; });
      return cors({ ok: true, count: enriched.length, installs: enriched });
    }

    return cors({ error: 'unknown path', available: ['identify', 'heartbeat', 'check-update', 'preset', 'toggle-bidding', 'team', 'status'] }, 404);
  } catch (err: any) {
    console.error('[extension-config]', err);
    return cors({ error: String(err?.message || err) }, 500);
  }
});
