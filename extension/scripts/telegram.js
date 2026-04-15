// Telegram Bot API helper
import { getConfig } from './config.js';

export async function sendTelegramAlert(text, buttons = []) {
  const config = await getConfig();
  if (!config.telegramBotToken || !config.telegramChatId) {
    console.warn('[TG] Bot not configured, skipping alert');
    return;
  }

  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  
  const body = {
    chat_id: config.telegramChatId,
    text: text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };

  // Add inline keyboard if buttons provided
  if (buttons.length > 0) {
    // Split into rows: action buttons on first row, links on second
    const actionButtons = buttons.filter(b => b.callback_data).map(b => ({
      text: b.text,
      callback_data: b.callback_data
    }));
    const linkButtons = buttons.filter(b => b.url).map(b => ({
      text: b.text,
      url: b.url
    }));
    
    const keyboard = [];
    if (actionButtons.length) keyboard.push(actionButtons);
    if (linkButtons.length) keyboard.push(linkButtons);
    
    body.reply_markup = { inline_keyboard: keyboard };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!data.ok) console.error('[TG] Send error:', data.description);
    return data;
  } catch (err) {
    console.error('[TG] Failed to send:', err);
  }
}

// Format job alert for Telegram
export function formatJobAlert(job, proposal, decision) {
  const riskEmoji = {
    low: '🟢',
    medium: '🟡', 
    high: '🔴'
  };

  const decisionEmoji = {
    bid_high: '✅ HIGH PRIORITY',
    bid_medium: '⚡ MEDIUM',
    skip: '⏭ SKIP',
    stop: '🚨 STOP'
  };

  let msg = '';
  msg += `🆕 <b>${escapeHtml(job.title)}</b>\n\n`;
  msg += `💰 Budget: ${job.budget_type === 'hourly' ? `$${job.budget_min}-${job.budget_max}/hr` : `$${job.budget_min}-${job.budget_max} fixed`}\n`;
  msg += `⭐ Client: ${job.client_rating || 'New'} (${job.client_hires || 0} hires)\n`;
  msg += `🌍 ${job.client_country || 'Unknown'}\n`;
  msg += `📊 Proposals: ${job.proposals_count || '?'}\n`;
  msg += `${riskEmoji[decision.client_risk] || '⚪'} Risk: ${decision.client_risk?.toUpperCase()}\n`;
  msg += `${decisionEmoji[decision.decision] || '❓'}\n\n`;
  
  if (decision.reason) {
    msg += `💡 ${escapeHtml(decision.reason)}\n\n`;
  }

  msg += `🔗 <a href="${job.upwork_url || '#'}">Open job</a>\n\n`;
  
  if (proposal && decision.decision.startsWith('bid')) {
    msg += `📝 <b>Proposal:</b>\n<pre>${escapeHtml(proposal.substring(0, 3500))}</pre>`;
  }

  return msg;
}

// Format client message alert
export function formatMessageAlert(clientName, messageText, suggestedReply) {
  let msg = '';
  msg += `💬 <b>${escapeHtml(clientName)}</b> wrote:\n`;
  msg += `<i>${escapeHtml(messageText.substring(0, 500))}</i>\n\n`;
  msg += `📝 <b>Suggested reply:</b>\n`;
  msg += `<pre>${escapeHtml(suggestedReply.substring(0, 3000))}</pre>`;
  return msg;
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
