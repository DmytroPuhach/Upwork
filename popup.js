// OptimizeUp Extension — popup (v17.1.1)
// v17.1.1: Scraping Control panel — Start/Stop/Save preset, wired to background.js

document.getElementById('extVersion').textContent = chrome.runtime.getManifest().version;

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return d.toLocaleDateString();
}

function setMsg(el, text, kind) {
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
  if (text) {
    clearTimeout(el._timer);
    el._timer = setTimeout(() => { el.textContent = ''; el.className = 'msg'; }, 4000);
  }
}

// Read preset from inputs
function readPresetFromUI() {
  const query = document.getElementById('presetQuery').value.trim() || 'seo';
  const sort = document.getElementById('presetSort').value;
  const typeVal = document.getElementById('presetType').value;
  const hourly = typeVal === 'hourly' ? true : typeVal === 'fixed' ? false : null;
  return { query, sort, hourly };
}

// Write preset into inputs
function writePresetToUI(preset) {
  if (!preset) return;
  document.getElementById('presetQuery').value = preset.query || 'seo';
  document.getElementById('presetSort').value = preset.sort === 'relevance' ? 'relevance' : 'recency';
  document.getElementById('presetType').value =
    preset.hourly === true ? 'hourly' : preset.hourly === false ? 'fixed' : 'any';
}

// Toggle bidding status display and button label
function updateBiddingUI(enabled) {
  const statusEl = document.getElementById('biddingStatus');
  const btnEl = document.getElementById('biddingToggleBtn');
  if (enabled) {
    statusEl.textContent = '✅ enabled';
    statusEl.className = 'value status-ok';
    btnEl.textContent = 'Pause';
    btnEl.className = 'toggle-btn on';
  } else {
    statusEl.textContent = '⏸ disabled';
    statusEl.className = 'value status-warn';
    btnEl.textContent = 'Enable';
    btnEl.className = 'toggle-btn off';
  }
}

// 2B: peak-window check (mirror of background isInPeakWindow) for popup status display
function popupInPeakWindow(cachedIdentity) {
  const windows = cachedIdentity?.scrape_preset?.peak_windows;
  if (!Array.isArray(windows) || windows.length === 0) return true;
  for (const w of windows) {
    try {
      const tz = w.timezone || cachedIdentity?.account?.timezone || 'Europe/Berlin';
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
      const nowMin = parseInt(parts.find(p => p.type === 'hour').value, 10) * 60 + parseInt(parts.find(p => p.type === 'minute').value, 10);
      const [sh, sm] = String(w.start || '00:00').split(':').map(n => parseInt(n, 10) || 0);
      const [eh, em] = String(w.end || '23:59').split(':').map(n => parseInt(n, 10) || 0);
      const s = sh * 60 + sm, e = eh * 60 + em;
      const inW = s <= e ? (nowMin >= s && nowMin < e) : (nowMin >= s || nowMin < e);
      if (inW) return true;
    } catch {}
  }
  return false;
}

// Toggle Start/Stop visibility based on scraping state
function updateScrapingUI(active, inPeak) {
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const stateEl = document.getElementById('scrapeState');
  const panel = document.getElementById('scrapePanel');

  if (active) {
    startBtn.style.display = 'none';
    stopBtn.style.display = 'block';
    if (inPeak === false) {
      stateEl.textContent = '▶ Active — outside peak window';
      stateEl.className = 'scrape-state off';
    } else {
      stateEl.textContent = '▶ Scraping active';
      stateEl.className = 'scrape-state on';
    }
    panel.classList.add('active');
  } else {
    startBtn.style.display = 'block';
    stopBtn.style.display = 'none';
    stateEl.textContent = '⏸ Stopped';
    stateEl.className = 'scrape-state off';
    panel.classList.remove('active');
  }
}

async function loadStatus() {
  const storage = await chrome.storage.local.get([
    'cachedIdentity', 'cachedIdentityAt', 'machineId',
    'jobsScrapedToday', 'messagesCapturedToday',
    'lastScraperError', 'pendingUpdate', 'pausedUntilUpdate',
    'scrapingActive', 'scrapingTabId'
  ]);

  document.getElementById('machineId').textContent =
    storage.machineId ? storage.machineId.substring(0, 8) + '...' : 'not set';

  if (storage.cachedIdentity?.ok && storage.cachedIdentity.member) {
    const m = storage.cachedIdentity.member;
    document.getElementById('memberSlug').textContent = m.slug;
    updateBiddingUI(m.is_bidding_enabled);
    // Load preset from cached identity
    writePresetToUI(storage.cachedIdentity.scrape_preset);
  } else {
    document.getElementById('memberSlug').innerHTML = '<span class="status-err">unknown</span>';
    document.getElementById('biddingStatus').innerHTML = '<span class="status-err">NOT IDENTIFIED</span>';
  }

  const scraperEl = document.getElementById('scraperStatus');
  if (storage.pausedUntilUpdate) scraperEl.innerHTML = '<span class="status-warn">⏸ paused (update required)</span>';
  else if (storage.lastScraperError) {
    scraperEl.innerHTML = '<span class="status-err">❌ error</span>';
    scraperEl.title = storage.lastScraperError;
  }
  else scraperEl.innerHTML = '<span class="status-ok">✅ active</span>';

  document.getElementById('jobsToday').textContent = storage.jobsScrapedToday || 0;
  document.getElementById('messagesToday').textContent = storage.messagesCapturedToday || 0;
  document.getElementById('lastHeartbeat').textContent =
    fmtTime(storage.cachedIdentityAt ? new Date(storage.cachedIdentityAt).toISOString() : null);

  // Verify the scraping tab still exists — if stale state, clear it
  let scrapingActive = !!storage.scrapingActive;
  if (scrapingActive && storage.scrapingTabId) {
    try {
      await chrome.tabs.get(storage.scrapingTabId);
    } catch {
      // tab gone — reset
      scrapingActive = false;
      await chrome.storage.local.set({ scrapingActive: false, scrapingTabId: null });
    }
  }
  updateScrapingUI(scrapingActive, popupInPeakWindow(storage.cachedIdentity));

  if (storage.pendingUpdate?.update_available) {
    document.getElementById('updateBanner').style.display = 'block';
    document.getElementById('updateInfo').innerHTML = `
      <div>Current: ${storage.pendingUpdate.current_version}</div>
      <div>Latest: <strong>${storage.pendingUpdate.latest_version}</strong></div>
      <div style="margin-top: 4px; font-size: 11px;">Run in terminal:<br><code>curl -fsSL https://app.optimizeup.io/ext/update.sh | bash</code></div>
      ${storage.pendingUpdate.force_update ? '<div style="color:#c00;"><strong>Required</strong></div>' : ''}
    `;
  }
}

// ═══════════════════════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════════════════════

document.getElementById('biddingToggleBtn').addEventListener('click', async () => {
  const btn = document.getElementById('biddingToggleBtn');
  const msgEl = document.getElementById('biddingMsg');
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = '⏳';
  setMsg(msgEl, '');
  const res = await chrome.runtime.sendMessage({ type: 'TOGGLE_BIDDING' });
  btn.disabled = false;
  if (res?.ok) {
    updateBiddingUI(res.bidding_enabled);
    setMsg(msgEl, res.bidding_enabled ? 'Bidding enabled' : 'Bidding paused', 'ok');
  } else {
    btn.textContent = oldText;
    setMsg(msgEl, res?.error || 'Failed', 'err');
  }
});

document.getElementById('refreshBtn').addEventListener('click', async () => {
  const btn = document.getElementById('refreshBtn');
  const oldText = btn.textContent;
  btn.textContent = '⏳ Refreshing...';
  btn.disabled = true;
  await chrome.runtime.sendMessage({ type: 'FORCE_IDENTIFY' });
  setTimeout(async () => {
    await loadStatus();
    btn.textContent = oldText;
    btn.disabled = false;
  }, 1500);
});

document.getElementById('updateBtn')?.addEventListener('click', () => {
  chrome.runtime.reload();
});

document.getElementById('startBtn').addEventListener('click', async () => {
  const btn = document.getElementById('startBtn');
  const msgEl = document.getElementById('presetMsg');
  btn.disabled = true;
  btn.textContent = '⏳ Starting...';
  setMsg(msgEl, '');

  const preset = readPresetFromUI();
  // Save the current preset to storage immediately so startScraping uses it
  // (even if user hasn't clicked Save)
  const { cachedIdentity } = await chrome.storage.local.get('cachedIdentity');
  if (cachedIdentity) {
    cachedIdentity.scrape_preset = preset;
    await chrome.storage.local.set({ cachedIdentity });
  }

  const res = await chrome.runtime.sendMessage({ type: 'START_SCRAPING', payload: { preset } });

  btn.disabled = false;
  btn.textContent = '▶ Start Scraping';

  if (res?.ok) {
    updateScrapingUI(true);
    setMsg(msgEl, res.reused ? 'Focused existing scraping tab' : 'Scraping started', 'ok');
    // Close popup after short delay so user sees the confirmation
    setTimeout(() => window.close(), 800);
  } else {
    setMsg(msgEl, res?.error || 'Failed to start', 'err');
  }
});

document.getElementById('stopBtn').addEventListener('click', async () => {
  const btn = document.getElementById('stopBtn');
  const msgEl = document.getElementById('presetMsg');
  btn.disabled = true;
  btn.textContent = '⏳ Stopping...';
  setMsg(msgEl, '');

  const res = await chrome.runtime.sendMessage({ type: 'STOP_SCRAPING' });

  btn.disabled = false;
  btn.textContent = '⏸ Stop Scraping';

  if (res?.ok) {
    updateScrapingUI(false);
    setMsg(msgEl, 'Stopped', 'ok');
  } else {
    setMsg(msgEl, res?.error || 'Failed to stop', 'err');
  }
});

document.getElementById('savePresetBtn').addEventListener('click', async () => {
  const btn = document.getElementById('savePresetBtn');
  const msgEl = document.getElementById('presetMsg');
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = '⏳ Saving...';
  setMsg(msgEl, '');

  const preset = readPresetFromUI();
  const res = await chrome.runtime.sendMessage({ type: 'UPDATE_PRESET', payload: preset });

  btn.disabled = false;
  btn.textContent = oldText;

  if (res?.ok) {
    setMsg(msgEl, 'Preset saved to account', 'ok');
  } else {
    setMsg(msgEl, res?.error || 'Save failed', 'err');
  }
});

loadStatus();
