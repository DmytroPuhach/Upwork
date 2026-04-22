// OptimizeUp Extension v17.0.1 — popup

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return d.toLocaleDateString();
}

async function loadStatus() {
  const {
    cachedIdentity, cachedIdentityAt, machineId,
    jobsScrapedToday, messagesCapturedToday,
    lastScraperError, pendingUpdate, pausedUntilUpdate
  } = await chrome.storage.local.get([
    'cachedIdentity', 'cachedIdentityAt', 'machineId',
    'jobsScrapedToday', 'messagesCapturedToday',
    'lastScraperError', 'pendingUpdate', 'pausedUntilUpdate'
  ]);

  document.getElementById('machineId').textContent = machineId ? machineId.substring(0, 8) + '...' : 'not set';

  if (cachedIdentity?.ok && cachedIdentity.member) {
    const m = cachedIdentity.member;
    document.getElementById('memberSlug').textContent = m.slug;
    document.getElementById('memberRole').textContent = m.role;
    const biddingEl = document.getElementById('biddingStatus');
    if (m.is_bidding_enabled) {
      biddingEl.textContent = '✅ enabled';
      biddingEl.className = 'value status-ok';
    } else {
      biddingEl.textContent = '⏸ disabled';
      biddingEl.className = 'value status-warn';
    }
  } else {
    document.getElementById('memberSlug').innerHTML = '<span class="status-err">unknown</span>';
    document.getElementById('memberRole').textContent = '—';
    document.getElementById('biddingStatus').innerHTML = '<span class="status-err">NOT IDENTIFIED</span>';
  }

  const scraperEl = document.getElementById('scraperStatus');
  if (pausedUntilUpdate) scraperEl.innerHTML = '<span class="status-warn">⏸ paused (update required)</span>';
  else if (lastScraperError) { scraperEl.innerHTML = '<span class="status-err">❌ error</span>'; scraperEl.title = lastScraperError; }
  else scraperEl.innerHTML = '<span class="status-ok">✅ active</span>';

  document.getElementById('jobsToday').textContent = jobsScrapedToday || 0;
  document.getElementById('messagesToday').textContent = messagesCapturedToday || 0;
  document.getElementById('lastHeartbeat').textContent = fmtTime(cachedIdentityAt ? new Date(cachedIdentityAt).toISOString() : null);

  if (pendingUpdate?.update_available) {
    document.getElementById('updateBanner').style.display = 'block';
    document.getElementById('updateInfo').innerHTML = `
      <div>Current: ${pendingUpdate.current_version}</div>
      <div>Latest: <strong>${pendingUpdate.latest_version}</strong></div>
      ${pendingUpdate.force_update ? '<div style="color:#c00;"><strong>Required</strong></div>' : ''}
    `;
  }
}

document.getElementById('refreshBtn').addEventListener('click', async () => {
  const btn = document.getElementById('refreshBtn');
  btn.textContent = '⏳ Refreshing...';
  await chrome.runtime.sendMessage({ type: 'FORCE_IDENTIFY' });
  setTimeout(async () => { await loadStatus(); btn.textContent = '🔄 Refresh identity'; }, 1500);
});

document.getElementById('updateBtn')?.addEventListener('click', async () => {
  if (chrome.runtime.requestUpdateCheck) {
    try {
      await new Promise(r => chrome.runtime.requestUpdateCheck(r));
    } catch (e) { console.warn(e); }
  }
  chrome.runtime.reload();
});

loadStatus();
