// Claude Opus API helper for proposal generation and bid decisions
import { getConfig } from './config.js';
import { getSupabase } from './supabase.js';

const OPUS_MODEL = 'claude-sonnet-4-20250514'; // fast + smart for proposals

// Load knowledge base from Supabase
async function getKnowledge(key) {
  const sb = await getSupabase();
  const rows = await sb.query('opus_knowledge', { filters: { key }, limit: 1 });
  return rows[0]?.content || '';
}

// Load account context (bio, cases, cv, positioning)
async function getAccountContext(accountSlug) {
  const sb = await getSupabase();
  const accounts = await sb.query('accounts', { filters: { slug: accountSlug }, limit: 1 });
  if (!accounts.length) throw new Error(`Account ${accountSlug} not found`);
  return accounts[0];
}

// Load winners for this account (top 10)
async function getWinners(accountId) {
  const sb = await getSupabase();
  return sb.query('winners_log', {
    filters: { account_id: accountId },
    limit: 10,
    order: 'created_at.desc'
  });
}

// Call Claude API via Supabase Edge Function proxy (avoids CORS)
async function callClaude(systemPrompt, userMessage) {
  const config = await getConfig();
  if (!config.anthropicApiKey) throw new Error('Anthropic API key not configured');

  const proxyUrl = `${config.supabaseUrl}/functions/v1/opus-proxy`;
  
  const res = await fetch(proxyUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.supabaseAnonKey}`,
      'x-anthropic-key': config.anthropicApiKey
    },
    body: JSON.stringify({
      model: OPUS_MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.content[0]?.text || '';
}

// ============================================
// BID DECISION: should we bid on this job?
// ============================================
export async function makeBidDecision(job, accountSlug) {
  const systemPrompt = await getKnowledge('bid_decision_prompt');
  const account = await getAccountContext(accountSlug);

  const userMessage = `ACCOUNT CONTEXT:
Name: ${account.name}
Slug: ${account.slug}
JSS: ${account.jss_current}%
Account age: ${account.account_age_months} months
Specialization: ${(account.specialization || []).join(', ')}
Positioning: ${account.positioning}
Rate: $${account.hourly_rate}/hr
Language: ${account.language}
Status: ${account.status}

JOB DATA:
Title: ${job.title}
Description: ${job.description?.substring(0, 2000)}
Budget: ${job.budget_type} ${job.budget_min ? `$${job.budget_min}` : ''}${job.budget_max ? `-$${job.budget_max}` : ''}
Client rating: ${job.client_rating || 'New client'}
Client hires: ${job.client_hires || 0}
Client total spent: $${job.client_spent_total || 0}
Client country: ${job.client_country || 'Unknown'}
Proposals already: ${job.proposals_count || '?'}
Skills required: ${(job.skills || []).join(', ')}

Analyze and return JSON decision.`;

  const response = await callClaude(systemPrompt, userMessage);
  
  // Parse JSON from response
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('[Opus] Failed to parse bid decision:', e);
  }
  
  return { decision: 'skip', reason: 'Failed to parse AI response', client_risk: 'medium', priority: 'skip' };
}

// ============================================
// PROPOSAL GENERATION
// ============================================
export async function generateProposal(job, accountSlug) {
  const systemPrompt = await getKnowledge('proposal_system_prompt');
  const account = await getAccountContext(accountSlug);
  const winners = await getWinners(account.id);

  const winnersContext = winners.length > 0
    ? `\n\nWINNERS LOG (top proposals that got hired):\n${winners.map(w => 
        `- Job: ${w.job_title}, Tone: ${w.tone}, Language: ${w.language}, Opening: "${w.opening_line}"`
      ).join('\n')}`
    : '\n\nNo winners log yet — use cases and portfolio for reference.';

  const casesStr = (account.cases || []).map(c => 
    `- ${c.name}: ${c.result} (${c.market}) → ${c.url || 'no URL'}`
  ).join('\n');

  const userMessage = `FREELANCER PROFILE:
Name: ${account.name}
Bio: ${account.bio?.substring(0, 500)}
Rate: $${account.hourly_rate}/hr
Language preference: ${account.language}
Style: ${account.proposal_style}
Portfolio: https://www.upwork.com/freelancers/dmytrop79

CASES:
${casesStr}

CV (key facts):
${account.cv_text?.substring(0, 800)}
${winnersContext}

JOB TO WRITE PROPOSAL FOR:
Title: ${job.title}
Full description: ${job.description?.substring(0, 3000)}
Budget: ${job.budget_type} ${job.budget_min ? `$${job.budget_min}` : ''}${job.budget_max ? `-$${job.budget_max}` : ''}
Client country: ${job.client_country || 'Unknown'}
Client rating: ${job.client_rating || 'New'}
Skills: ${(job.skills || []).join(', ')}

Generate the proposal. Pick 1-3 most relevant cases. Match language to client country (DE countries = German, else English). Use Pain→Solution→Benefit. First 230 chars must hook.`;

  return callClaude(systemPrompt, userMessage);
}

// ============================================
// CLIENT REPLY GENERATION (strategic)
// ============================================
export async function generateReply(clientMessage, clientId, accountSlug) {
  const systemPrompt = await getKnowledge('reply_system_prompt');
  const account = await getAccountContext(accountSlug);
  const sb = await getSupabase();

  // Load client CRM card
  const clients = await sb.query('clients', { filters: { id: clientId }, limit: 1 });
  const client = clients[0] || {};

  // Load client strategy
  let strategy = {};
  if (clientId) {
    const strategies = await sb.query('client_strategy', { filters: { client_id: clientId }, limit: 1 });
    strategy = strategies[0] || {};
  }

  // Load recent messages context (last 15)
  const messages = await sb.query('messages_context', {
    filters: { client_id: clientId },
    limit: 15,
    order: 'created_at.desc'
  });

  // Load open promises
  const promises = await sb.query('promises', {
    filters: { client_id: clientId, status: 'pending' },
    limit: 10
  });

  // Load communication style knowledge
  const commStyle = await getKnowledge('dima_communication_style');
  const salesPatterns = await getKnowledge('dima_sales_patterns');

  const userMessage = `CLIENT CRM CARD:
Name: ${client.name || 'Unknown'}
Company: ${client.company || ''}
Language: ${client.language || 'EN'}
Tone: ${client.communication_tone || 'informal'}
Goal: ${client.project_goal || ''}
Status: ${client.status || 'neutral'}

CLIENT STRATEGY:
Type: ${strategy.client_type || 'unknown'}
Strategy: ${strategy.engagement_strategy || 'No strategy set'}
Upsell opportunities: ${strategy.upsell_opportunities || 'None identified'}
Pain points: ${strategy.pain_points || 'Unknown'}
Real hours estimate: ${strategy.estimated_hours_actual || '?'}
Billable target: ${strategy.billed_hours_target || '?'}h/week
Weekly limit: ${strategy.weekly_hours_limit || '?'}h
Response urgency: ${strategy.response_urgency || 'normal'}
Communication notes: ${strategy.communication_notes || ''}
Next action: ${strategy.next_action || 'None set'}
Risk factors: ${strategy.risk_factors || 'None'}
Open deliverables: ${strategy.open_deliverables || 'None'}

OPEN PROMISES:
${promises.length ? promises.map(p => `- ${p.description} (deadline: ${p.deadline || 'none'})`).join('\n') : 'None'}

RECENT MESSAGES (newest first):
${messages.map(m => `[${m.message_direction}] ${m.raw_text?.substring(0, 300)}`).join('\n') || 'No history'}

DIMA'S COMMUNICATION STYLE:
${commStyle.substring(0, 1000)}

SALES PATTERNS:
${salesPatterns.substring(0, 1000)}

FREELANCER: ${account.name} (${account.slug})

NEW CLIENT MESSAGE:
"${clientMessage}"

Think strategically. Generate the full JSON response with reply_text, strategy_notes, revenue_play, time estimates, promises, next_actions, reminders, mood assessment, risk level, and upsell opportunity.`;

  const response = await callClaude(systemPrompt, userMessage);
  
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      
      // Save reminders to bot_memory if any
      if (parsed.reminders?.length) {
        for (const reminder of parsed.reminders) {
          await sb.insert('bot_memory', {
            memory_type: 'todo',
            content: `[${client.name}] ${reminder.text}`,
            context: { 
              priority: parsed.risk_level === 'high' ? 'urgent' : 'medium',
              client_id: clientId,
              when: reminder.when,
              auto_generated: true 
            }
          });
        }
      }
      
      return parsed;
    }
  } catch (e) {
    console.error('[Opus] Failed to parse reply:', e);
  }
  
  return { reply_text: response, tone: 'informal', promises_extracted: [], flag_admin: false, strategy_notes: 'Parse failed — raw response' };
}
