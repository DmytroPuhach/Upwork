// Popup script — config management and status

const DEFAULT_CONFIG = {
  supabaseUrl: 'https://nsmcaexdqbipusjuzfht.supabase.co',
  supabaseAnonKey: '',
  accountSlug: 'dima',
  accountId: '',
  telegramBotToken: '',
  telegramChatId: '',
  anthropicApiKey: '',
  pollIntervalMinutes: 5,
  minBidDelaySeconds: 120,
  maxBidsPerDay: 12,
  enableRssPolling: true,
  enableMessageMonitoring: true,
  enablePassiveScraping: true
};

// Load config on popup open
document.addEventListener('DOMContentLoaded', async () => {
  const stored = await chrome.storage.local.get('ecosystemConfig');
  const config = { ...DEFAULT_CONFIG, ...(stored.ecosystemConfig || {}) };
  
  // Fill form
  document.getElementById('accountSlug').value = config.accountSlug || 'dima';
  document.getElementById('supabaseKey').value = config.supabaseAnonKey || '';
  document.getElementById('anthropicKey').value = config.anthropicApiKey || '';
  document.getElementById('tgToken').value = config.telegramBotToken || '';
  document.getElementById('tgChatId').value = config.telegramChatId || '';
  document.getElementById('pollInterval').value = config.pollIntervalMinutes || 5;
  
  // Update status
  updateStatus();
});

// Save config
document.getElementById('saveBtn').addEventListener('click', async () => {
  const config = {
    ...DEFAULT_CONFIG,
    accountSlug: document.getElementById('accountSlug').value,
    supabaseAnonKey: document.getElementById('supabaseKey').value.trim(),
    anthropicApiKey: document.getElementById('anthropicKey').value.trim(),
    telegramBotToken: document.getElementById('tgToken').value.trim(),
    telegramChatId: document.getElementById('tgChatId').value.trim(),
    pollIntervalMinutes: parseInt(document.getElementById('pollInterval').value) || 5
  };

  await chrome.storage.local.set({ ecosystemConfig: config });
  showToast('Saved! Extension activated.');
  updateStatus();
});

// Manual RSS poll
document.getElementById('pollBtn').addEventListener('click', async () => {
  showToast('Polling RSS...');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'TRIGGER_RSS_POLL' });
    showToast(response?.ok ? 'RSS poll complete!' : 'Poll error');
  } catch (err) {
    showToast('Error: ' + err.message, true);
  }
});

// Test Telegram
document.getElementById('testTgBtn').addEventListener('click', async () => {
  const stored = await chrome.storage.local.get('ecosystemConfig');
  const config = stored.ecosystemConfig || {};
  
  if (!config.telegramBotToken || !config.telegramChatId) {
    showToast('Set TG token & chat ID first', true);
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text: '✅ OptimizeUp Ecosystem connected!\n\nBot is working. You will receive job alerts here.',
        parse_mode: 'HTML'
      })
    });
    const data = await res.json();
    showToast(data.ok ? 'TG message sent!' : 'TG error: ' + data.description, !data.ok);
  } catch (err) {
    showToast('TG error: ' + err.message, true);
  }
});

// Update status display
async function updateStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    
    const badge = document.getElementById('statusBadge');
    badge.textContent = response?.configured ? 'ACTIVE' : 'SETUP';
    badge.className = 'badge' + (response?.configured ? '' : ' off');
    
    const setStatus = (id, ok, text) => {
      const el = document.getElementById(id);
      el.textContent = text;
      el.className = 'status-value ' + (ok ? 'ok' : 'err');
    };
    
    setStatus('stAccount', response?.account, response?.account || 'Not found');
    
    const stored = await chrome.storage.local.get('ecosystemConfig');
    const config = stored.ecosystemConfig || {};
    
    setStatus('stSupabase', !!config.supabaseAnonKey, config.supabaseAnonKey ? 'Connected' : 'Not set');
    setStatus('stTelegram', !!(config.telegramBotToken && config.telegramChatId), 
      (config.telegramBotToken && config.telegramChatId) ? 'Connected' : 'Not set');
    setStatus('stOpus', !!config.anthropicApiKey, config.anthropicApiKey ? 'Connected' : 'Not set');
    setStatus('stRss', response?.rssEnabled, response?.rssEnabled ? `Every ${response.pollInterval}m` : 'Disabled');
    
  } catch (err) {
    document.getElementById('statusBadge').textContent = 'ERROR';
    document.getElementById('statusBadge').className = 'badge off';
  }
}

function showToast(msg, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => toast.className = 'toast', 3000);
}
