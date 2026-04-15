// Extension config — filled via popup settings
// These are loaded from chrome.storage.local

export const DEFAULT_CONFIG = {
  // Supabase
  supabaseUrl: 'https://nsmcaexdqbipusjuzfht.supabase.co',
  supabaseAnonKey: '', // user fills in popup
  
  // Account
  accountSlug: 'dima', // which freelancer account
  accountId: '', // uuid, fetched from supabase on init
  
  // Telegram
  telegramBotToken: '',
  telegramChatId: '',
  
  // Anthropic
  anthropicApiKey: '',
  
  // RSS polling
  pollIntervalMinutes: 5,
  
  // Safety
  minBidDelaySeconds: 120, // 2 min minimum delay before alerting (anti-pattern)
  maxBidsPerDay: 12,
  
  // Feature flags
  enableRssPolling: true,
  enableMessageMonitoring: true,
  enablePassiveScraping: true,
  autoSendReplies: false // OFF by default — risky feature
};

export async function getConfig() {
  const stored = await chrome.storage.local.get('ecosystemConfig');
  return { ...DEFAULT_CONFIG, ...(stored.ecosystemConfig || {}) };
}

export async function saveConfig(config) {
  await chrome.storage.local.set({ ecosystemConfig: config });
}
