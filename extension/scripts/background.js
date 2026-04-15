// Background Service Worker — OptimizeUp Ecosystem
// Handles: RSS polling, job processing, alarms, message relay

import { getConfig } from './config.js';
import { getSupabase } from './supabase.js';
import { triggerJobSearch } from './job-search.js';
import { makeBidDecision, generateProposal, generateReply } from './opus.js';
import { sendTelegramAlert, formatJobAlert } from './telegram.js';

// ============================================
// INITIALIZATION
// ============================================
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[BG] OptimizeUp Ecosystem installed');
  await setupAlarms();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[BG] Extension startup');
  await setupAlarms();
});

async function setupAlarms() {
  const config = await getConfig();
  
  // RSS polling alarm
  chrome.alarms.create('rss-poll', {
    periodInMinutes: config.pollIntervalMinutes || 5
  });
  
  // Check for approved replies every 30 seconds
  chrome.alarms.create('check-approved-replies', {
    periodInMinutes: 0.5
  });
  
  // Check for new messages every 3 minutes
  chrome.alarms.create('check-messages', {
    periodInMinutes: 3
  });
  
  console.log(`[BG] RSS polling every ${config.pollIntervalMinutes || 5}m, messages check every 3m`);
}

// ============================================
// ALARM HANDLER
// ============================================
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'rss-poll') {
    await pollRssFeeds();
  }
  if (alarm.name === 'check-approved-replies') {
    await processApprovedReplies();
  }
  if (alarm.name === 'check-messages') {
    await checkForNewMessages();
  }
});

// ============================================
// JOB SEARCH — scrapes Upwork search page (RSS is dead, 410 Gone)
// ============================================
async function pollRssFeeds() {
  console.log('[SEARCH] Job search started...');
  
  try {
    const config = await getConfig();
    if (!config.enableRssPolling) {
      console.log('[SEARCH] Polling disabled');
      return;
    }

    const sb = await getSupabase();
    
    // Get current account
    const accounts = await sb.query('accounts', { 
      filters: { slug: config.accountSlug },
      limit: 1 
    });
    
    if (!accounts.length) {
      console.error('[SEARCH] Account not found:', config.accountSlug);
      return;
    }
    
    const account = accounts[0];

    // Use job search scraper (requires Upwork tab open)
    console.log('[SEARCH] Triggering search scrape...');
    const jobs = await triggerJobSearch();
    console.log(`[SEARCH] Found ${jobs.length} jobs`);

    if (jobs.length === 0) {
      console.warn('[SEARCH] No jobs found. Make sure you have an Upwork tab open and are logged in.');
      await sendTelegramAlert('⚠️ Job search returned 0 results.\n\nMake sure you have Upwork open in a tab and are logged in.');
      return;
    }

    // Process each job
    let newJobCount = 0;
    for (const job of jobs) {
      try {
        const isNew = await processJob(job, account, config);
        if (isNew) newJobCount++;
      } catch (err) {
        console.error('[SEARCH] Error processing job:', job.title, err);
      }
    }

    console.log(`[SEARCH] Done. ${newJobCount} new jobs processed.`);
    
    // Update badge
    if (newJobCount > 0) {
      chrome.action.setBadgeText({ text: String(newJobCount) });
      chrome.action.setBadgeBackgroundColor({ color: '#10B981' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 30000);
    }

  } catch (err) {
    console.error('[SEARCH] Poll failed:', err);
  }
}

// ============================================
// PROCESS SINGLE JOB
// ============================================
async function processJob(job, account, config) {
  const sb = await getSupabase();
  
  // Check if job already exists (dedup by upwork_job_id)
  const existing = await sb.query('jobs', { 
    filters: { upwork_job_id: job.upwork_job_id },
    limit: 1 
  });
  
  if (existing.length > 0) {
    return false; // Already processed
  }

  // Clean data before insert — remove fields not in DB schema
  const jobData = {
    upwork_job_id: job.upwork_job_id,
    title: job.title || '',
    description: (job.description || '').substring(0, 5000),
    budget_min: job.budget_min || null,
    budget_max: job.budget_max || null,
    budget_type: job.budget_type || null,
    client_country: job.client_country || null,
    client_rating: job.client_rating || null,
    client_hires: job.client_hires || null,
    client_spent_total: job.client_spent_total || null,
    skills: job.skills || [],
    proposals_count: job.proposals_count || null,
    posted_at: job.posted_at || new Date().toISOString(),
    upwork_url: job.upwork_url || null,
    matched_account_id: account.id
  };

  // Save job to DB
  const savedJobs = await sb.insert('jobs', jobData);
  const savedJob = savedJobs[0];
  console.log(`[JOB] New: ${job.title}`);

  // Try Opus bid decision (may fail due to CORS in extension)
  let decision = { decision: 'bid_medium', reason: 'Auto — Opus not available (CORS)', client_risk: 'medium', priority: 'within_hour' };
  let proposalText = null;
  
  try {
    decision = await makeBidDecision(savedJob, config.accountSlug);
    console.log(`[OPUS] Decision: ${decision.decision} — ${decision.reason}`);
  } catch (err) {
    console.warn(`[OPUS] Bid decision failed (will send alert anyway): ${err.message}`);
  }

  // Try proposal generation (may fail due to CORS)
  if (decision.decision === 'bid_high' || decision.decision === 'bid_medium') {
    try {
      proposalText = await generateProposal(savedJob, config.accountSlug);
      console.log(`[OPUS] Proposal generated (${proposalText?.length} chars)`);

      if (proposalText) {
        await sb.insert('proposals', {
          job_id: savedJob.id,
          account_id: account.id,
          proposal_text: proposalText,
          language: 'EN',
          status: 'generated'
        });
      }
    } catch (err) {
      console.warn(`[OPUS] Proposal generation failed: ${err.message}`);
    }
  }

  // Send Telegram alert — ALWAYS, even without proposal
  const alertText = formatJobAlert(savedJob, proposalText, decision);
  const buttons = [];
  
  if (job.upwork_url) {
    buttons.push({ text: '🔗 Open Job', url: job.upwork_url });
  }
  
  await sendTelegramAlert(alertText, buttons);

  return true; // New job processed
}

// ============================================
// CHECK FOR NEW MESSAGES — scans messages tab for unread badges
// ============================================
const seenMessages = new Set(); // dedup across checks

async function checkForNewMessages() {
  try {
    // Find any Upwork tab (messages or any page — we can check the nav badge)
    const tabs = await chrome.tabs.query({ url: '*://www.upwork.com/*' });
    if (!tabs.length) return;
    
    // First try to find messages tab
    let msgTab = tabs.find(t => t.url?.includes('/messages'));
    
    // If no messages tab, use any Upwork tab to check unread count in nav
    const targetTab = msgTab || tabs[0];
    
    const results = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: () => {
        const messages = [];
        
        // Method 1: Check nav badge for unread count
        const navBadge = document.querySelector('a[href*="messages"] .badge, a[href*="messages"] [class*="count"], [data-test="nav-messages"] .badge');
        const unreadCount = navBadge ? parseInt(navBadge.textContent) || 0 : 0;
        
        // Method 2: If we're on messages page, scan thread list for unread indicators
        if (window.location.pathname.includes('/messages')) {
          const threads = document.querySelectorAll('a[href*="/rooms/"]');
          threads.forEach(thread => {
            // Look for unread indicators — bold text, unread dot, badge
            const isUnread = thread.querySelector('[class*="unread"], [class*="bold"], [class*="badge"]') 
              || thread.closest('[class*="unread"]')
              || (thread.querySelector('[class*="name"]')?.style?.fontWeight === 'bold');
            
            if (isUnread) {
              const nameEl = thread.querySelector('[class*="name"], [class*="title"]');
              const previewEl = thread.querySelector('[class*="preview"], [class*="last-message"], [class*="snippet"]');
              const name = nameEl?.textContent?.trim() || '';
              const preview = previewEl?.textContent?.trim() || '';
              const href = thread.href || '';
              
              if (name && name.length > 2) {
                messages.push({ name, preview: preview.substring(0, 200), url: href });
              }
            }
          });
          
          // Method 3: Parse visible thread list text for message previews
          if (messages.length === 0) {
            const threadItems = document.querySelectorAll('[class*="thread-list"] > *, [class*="room-list"] > *');
            threadItems.forEach(item => {
              const text = item.textContent?.trim() || '';
              const link = item.querySelector('a[href*="/rooms/"]');
              // Check if item has visual unread indicator (usually bolder text or dot)
              const style = window.getComputedStyle(item);
              const isBold = style.fontWeight === '700' || style.fontWeight === 'bold';
              
              if (link && text.length > 10 && isBold) {
                const parts = text.split('\n').filter(p => p.trim().length > 2);
                messages.push({
                  name: parts[0]?.trim() || 'Unknown',
                  preview: parts.slice(1).join(' ').trim().substring(0, 200),
                  url: link.href || ''
                });
              }
            });
          }
        }
        
        return { unreadCount, messages, onMessagesPage: window.location.pathname.includes('/messages') };
      }
    });
    
    const data = results[0]?.result;
    if (!data) return;
    
    console.log(`[MSG-CHECK] Unread: ${data.unreadCount}, Threads: ${data.messages?.length || 0}, On messages: ${data.onMessagesPage}`);
    
    // Process unread messages
    if (data.messages?.length) {
      for (const msg of data.messages) {
        const key = `${msg.name}:${msg.preview.substring(0, 50)}`;
        if (seenMessages.has(key)) continue;
        seenMessages.add(key);
        
        // Keep set manageable
        if (seenMessages.size > 200) {
          const arr = [...seenMessages];
          arr.splice(0, 100);
          seenMessages.clear();
          arr.forEach(k => seenMessages.add(k));
        }
        
        console.log(`[MSG-CHECK] Unread from ${msg.name}: ${msg.preview.substring(0, 60)}`);
        
        // Process as new client message
        await handleClientMessage({
          clientName: msg.name.split(',')[0].trim(), // "Daniel Osafo, DO MARKETING" → "Daniel Osafo"
          messageText: msg.preview || `New unread message from ${msg.name}`,
          url: msg.url,
          timestamp: new Date().toISOString()
        });
      }
    } else if (data.unreadCount > 0 && !data.onMessagesPage) {
      // We see unread badge but can't read messages — notify to open messages tab
      const badgeKey = `badge:${data.unreadCount}:${new Date().getHours()}`;
      if (!seenMessages.has(badgeKey)) {
        seenMessages.add(badgeKey);
        await sendTelegramAlert(`📩 <b>${data.unreadCount} unread message${data.unreadCount > 1 ? 's' : ''}</b> on Upwork!\n\nOpen messages tab for details.`, 
          [{ text: '💬 Open Messages', url: 'https://www.upwork.com/ab/messages' }]);
      }
    }
    
  } catch (err) {
    // Silent fail — tab might have navigated away
    if (!String(err).includes('No tab') && !String(err).includes('Cannot access')) {
      console.error('[MSG-CHECK] Error:', err);
    }
  }
}

// ============================================
// PROCESS APPROVED REPLIES — auto-insert to Upwork
// ============================================
async function processApprovedReplies() {
  try {
    const sb = await getSupabase();
    
    // Get approved but not yet sent replies
    const approved = await sb.query('pending_replies', {
      filters: { status: 'approved' },
      limit: 5,
      order: 'decided_at.asc'
    });
    
    if (!approved.length) return;
    
    console.log(`[REPLY] Found ${approved.length} approved replies to send`);
    
    for (const reply of approved) {
      try {
        const replyText = reply.final_reply || reply.suggested_reply;
        if (!replyText) continue;
        
        // Find the messages tab with this client's chat open
        const chatUrl = reply.chat_url;
        if (!chatUrl) {
          console.warn(`[REPLY] No chat URL for reply to ${reply.client_name}`);
          // Mark as sent anyway to avoid stuck queue
          await sb.update('pending_replies', { status: 'sent', sent_at: new Date().toISOString() }, { id: reply.id });
          continue;
        }
        
        // Find or open the chat tab
        const tabs = await chrome.tabs.query({ url: '*://www.upwork.com/ab/messages/*' });
        let targetTab = tabs.find(t => t.url?.includes(chatUrl.split('rooms/')[1]?.split('?')[0] || 'NOMATCH'));
        
        if (!targetTab && tabs.length > 0) {
          // Navigate existing messages tab to the right room
          targetTab = tabs[0];
          await chrome.tabs.update(targetTab.id, { url: chatUrl });
          await new Promise(r => setTimeout(r, 4000)); // Wait for page load
        }
        
        if (!targetTab) {
          console.warn(`[REPLY] No Upwork messages tab open for ${reply.client_name}`);
          await sendTelegramAlert(`⚠️ Can't auto-send to ${reply.client_name} — no messages tab open.\n\nCopy and paste manually:\n<code>${replyText.substring(0, 500)}</code>`);
          await sb.update('pending_replies', { status: 'sent', sent_at: new Date().toISOString() }, { id: reply.id });
          continue;
        }
        
        // Inject reply text into the message input (INSERT ONLY — no auto-click)
        const result = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          func: (text) => {
            // Find the message input area
            const input = document.querySelector('textarea[class*="msg-composer"], textarea[name="message"], [contenteditable="true"][class*="msg"], [contenteditable="true"][class*="composer"], textarea[placeholder*="Send"], textarea[class*="text-input"]');
            if (!input) return { ok: false, error: 'Input not found' };
            
            if (input.tagName === 'TEXTAREA') {
              input.value = text;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
              input.textContent = text;
              input.dispatchEvent(new Event('input', { bubbles: true }));
            }
            
            return { ok: true, message: 'Text inserted — press Send manually' };
          },
          args: [replyText]
        });
        
        const sendResult = result[0]?.result;
        console.log(`[REPLY] Insert result for ${reply.client_name}:`, sendResult);
        
        // Update status
        await sb.update('pending_replies', { status: 'sent', sent_at: new Date().toISOString() }, { id: reply.id });
        
        if (sendResult?.ok) {
          await sendTelegramAlert(`✅ Reply inserted for <b>${reply.client_name}</b>!\n\nText is in the input field — just hit Send in Upwork.\n\n💬 ${chatUrl}`);
        } else {
          await sendTelegramAlert(`⚠️ Could not insert reply for ${reply.client_name}.\n\nCopy manually:\n<code>${replyText.substring(0, 500)}</code>`);
        }
        
      } catch (err) {
        console.error(`[REPLY] Error sending to ${reply.client_name}:`, err);
      }
    }
  } catch (err) {
    console.error('[REPLY] Error checking approved replies:', err);
  }
}

// ============================================
// MESSAGE RELAY from content script
// ============================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'NEW_CLIENT_MESSAGE') {
    handleClientMessage(message.data).then(sendResponse);
    return true; // async response
  }
  
  if (message.type === 'PAGE_DATA') {
    handlePageData(message.data).then(sendResponse);
    return true;
  }

  if (message.type === 'TRIGGER_RSS_POLL') {
    pollRssFeeds().then(() => sendResponse({ ok: true }));
    return true;
  }
  
  if (message.type === 'CHECK_PROPOSAL') {
    checkProposalForJob(message.data.jobId).then(sendResponse);
    return true;
  }
  
  if (message.type === 'GET_LATEST_PROPOSAL') {
    getLatestProposal().then(sendResponse);
    return true;
  }
  
  if (message.type === 'GET_STATUS') {
    getStatus().then(sendResponse);
    return true;
  }
});

async function handleClientMessage(data) {
  console.log(`[MSG] Client message from ${data.clientName}: ${data.messageText?.substring(0, 100)}`);
  
  try {
    const config = await getConfig();
    const sb = await getSupabase();
    
    // Find or create client in DB
    const existingClients = await sb.query('clients', { 
      filters: { name: data.clientName },
      limit: 1 
    });
    
    let clientId = existingClients[0]?.id;
    
    if (!clientId) {
      // Create new client record
      const newClient = await sb.insert('clients', {
        name: data.clientName,
        account_id: (await sb.query('accounts', { filters: { slug: config.accountSlug }, limit: 1 }))[0]?.id,
        status: 'neutral',
        language: 'EN',
        communication_tone: 'informal'
      });
      clientId = newClient[0]?.id;
    }
    
    // Save incoming message to messages_context
    if (clientId) {
      await sb.insert('messages_context', {
        account_id: (await sb.query('accounts', { filters: { slug: config.accountSlug }, limit: 1 }))[0]?.id,
        client_id: clientId,
        message_direction: 'inbound',
        raw_text: data.messageText,
        summary: data.messageText.substring(0, 200),
        tone_detected: 'auto'
      });
    }
    
    // Generate AI reply via Opus
    let suggestedReply = null;
    try {
      const replyData = await generateReply(data.messageText, clientId, config.accountSlug);
      suggestedReply = replyData;
      console.log(`[OPUS] Reply generated for ${data.clientName}`);
      
      // Save suggested reply
      if (clientId && replyData.reply_text) {
        await sb.insert('messages_context', {
          account_id: (await sb.query('accounts', { filters: { slug: config.accountSlug }, limit: 1 }))[0]?.id,
          client_id: clientId,
          message_direction: 'outbound_draft',
          raw_text: replyData.reply_text,
          summary: 'AI-suggested reply (pending approval)',
          tone_detected: replyData.tone || 'informal'
        });
      }
      
      // Extract promises if any
      if (replyData.promises_extracted?.length && clientId) {
        for (const promise of replyData.promises_extracted) {
          await sb.insert('promises', {
            account_id: (await sb.query('accounts', { filters: { slug: config.accountSlug }, limit: 1 }))[0]?.id,
            client_id: clientId,
            description: promise,
            status: 'pending'
          });
        }
      }
    } catch (err) {
      console.warn(`[OPUS] Reply generation failed: ${err.message}`);
    }
    
    // Save to pending_replies for TG workflow
    let pendingId = null;
    if (suggestedReply?.reply_text) {
      try {
        const pending = await sb.insert('pending_replies', {
          client_id: clientId,
          account_id: (await sb.query('accounts', { filters: { slug: config.accountSlug }, limit: 1 }))[0]?.id,
          client_name: data.clientName,
          client_message: data.messageText.substring(0, 2000),
          suggested_reply: suggestedReply.reply_text,
          strategy_notes: suggestedReply.strategy_notes || '',
          revenue_play: suggestedReply.revenue_play || '',
          status: 'pending',
          chat_url: data.url
        });
        pendingId = pending[0]?.id;
      } catch (err) {
        console.warn('[MSG] Failed to save pending reply:', err);
      }
    }

    // Send TG alert with message + suggested reply + strategy
    let alertText = `📩 <b>New message from ${data.clientName}</b>\n\n`;
    alertText += `💬 "${data.messageText.substring(0, 400)}"\n\n`;
    
    if (suggestedReply?.reply_text) {
      // Client mood & risk
      const moodEmoji = {happy:'😊',neutral:'😐',concerned:'😟',frustrated:'😤',urgent:'🚨'}[suggestedReply.client_mood] || '💬';
      alertText += `${moodEmoji} Mood: ${suggestedReply.client_mood || '?'} | Risk: ${suggestedReply.risk_level || '?'}\n\n`;
      
      // Suggested reply
      alertText += `🤖 <b>Reply:</b>\n<code>${suggestedReply.reply_text.substring(0, 600)}</code>\n\n`;
      
      // Strategy notes for Dima
      if (suggestedReply.strategy_notes) {
        alertText += `🧠 <b>Strategy:</b>\n${suggestedReply.strategy_notes.substring(0, 300)}\n\n`;
      }
      
      // Revenue play
      if (suggestedReply.revenue_play) {
        alertText += `💰 <b>Revenue:</b> ${suggestedReply.revenue_play.substring(0, 200)}\n`;
        if (suggestedReply.time_estimate_real && suggestedReply.time_estimate_billable) {
          alertText += `⏱ Real: ${suggestedReply.time_estimate_real} → Bill: ${suggestedReply.time_estimate_billable}\n`;
        }
        alertText += `\n`;
      }
      
      // Upsell
      if (suggestedReply.upsell_opportunity) {
        alertText += `📈 <b>Upsell:</b> ${suggestedReply.upsell_opportunity.substring(0, 200)}\n\n`;
      }
      
      // Promises & next actions
      if (suggestedReply.promises_extracted?.length) {
        alertText += `📌 Promises: ${suggestedReply.promises_extracted.join(', ')}\n`;
      }
      if (suggestedReply.next_actions?.length) {
        alertText += `✅ Next: ${suggestedReply.next_actions.join(', ')}\n`;
      }
      
      if (suggestedReply.flag_admin) {
        alertText += `\n⚠️ <b>NEEDS YOUR ATTENTION</b>\n`;
      }
    } else {
      alertText += `⚠️ Could not generate AI reply\n\n`;
    }
    
    // TG inline buttons for quick actions
    const buttons = [];
    if (pendingId) {
      buttons.push({ text: '✅ Approve & Send', callback_data: `approve:${pendingId}` });
      buttons.push({ text: '⏰ Later', callback_data: `later:${pendingId}` });
      buttons.push({ text: '⏭ Skip', callback_data: `skip:${pendingId}` });
    }
    if (data.url) {
      buttons.push({ text: '💬 Open Chat', url: data.url });
    }
    
    await sendTelegramAlert(alertText, buttons);
    
    return { ok: true, reply: suggestedReply };
    
  } catch (err) {
    console.error('[MSG] Error handling client message:', err);
    return { ok: false, error: err.message };
  }
}

async function handlePageData(data) {
  // Passive scraping data from content script
  console.log('[SCRAPE] Page data:', data.type, data);
  
  try {
    const sb = await getSupabase();
    
    if (data.type === 'proposals_status') {
      // Update proposal statuses
      // TODO: match and update
    }
    
    if (data.type === 'connects_balance') {
      const config = await getConfig();
      const accounts = await sb.query('accounts', { filters: { slug: config.accountSlug }, limit: 1 });
      if (accounts.length) {
        await sb.insert('connects_log', {
          account_id: accounts[0].id,
          connects_balance: data.balance
        });
      }
    }

    if (data.type === 'active_contracts') {
      // TODO: sync contract data
    }

  } catch (err) {
    console.error('[SCRAPE] Error handling page data:', err);
  }
  
  return { ok: true };
}

async function getStatus() {
  try {
    const config = await getConfig();
    const sb = await getSupabase();
    const accounts = await sb.query('accounts', { filters: { slug: config.accountSlug }, limit: 1 });
    
    return {
      configured: !!(config.supabaseAnonKey && config.anthropicApiKey && config.telegramBotToken),
      account: accounts[0]?.name || 'Not found',
      accountSlug: config.accountSlug,
      rssEnabled: config.enableRssPolling,
      pollInterval: config.pollIntervalMinutes
    };
  } catch (err) {
    return { configured: false, error: err.message };
  }
}

async function checkProposalForJob(jobId) {
  try {
    const sb = await getSupabase();
    // Find job by upwork_job_id
    const jobs = await sb.query('jobs', { filters: { upwork_job_id: jobId }, limit: 1 });
    if (!jobs.length) return { proposalText: null };
    
    // Find proposal for this job
    const proposals = await sb.query('proposals', { filters: { job_id: jobs[0].id, status: 'generated' }, limit: 1 });
    return { proposalText: proposals[0]?.proposal_text || null };
  } catch (err) {
    console.error('[BG] Check proposal error:', err);
    return { proposalText: null };
  }
}

async function getLatestProposal() {
  try {
    const sb = await getSupabase();
    const proposals = await sb.query('proposals', { 
      filters: { status: 'generated' },
      limit: 1,
      order: 'created_at.desc'
    });
    return { proposalText: proposals[0]?.proposal_text || null };
  } catch (err) {
    console.error('[BG] Get latest proposal error:', err);
    return { proposalText: null };
  }
}

// ============================================
// HELPERS
// ============================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
