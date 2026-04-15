// Content Script — runs on all Upwork pages
// Passive data collection + message monitoring

(function() {
  'use strict';
  
  const PAGE_HANDLERS = {
    '/messages': monitorMessages,
    '/my-jobs/proposals': scrapeProposalStatuses,
    '/reports/overview': scrapeConnectsBalance,
    '/my-jobs/active': scrapeActiveContracts,
    '/notifications': scrapeNotifications,
    '/job/': scrapeJobPage
  };

  // ============================================
  // INIT — detect which page we're on
  // ============================================
  function init() {
    const path = window.location.pathname;
    console.log('[OptimizeUp] Content script loaded on:', path);

    for (const [pattern, handler] of Object.entries(PAGE_HANDLERS)) {
      if (path.includes(pattern)) {
        // Wait for page to fully render
        setTimeout(() => {
          try {
            handler();
          } catch (err) {
            console.error(`[OptimizeUp] Handler error for ${pattern}:`, err);
          }
        }, 2000);
        break;
      }
    }
  }

  // ============================================
  // /messages — monitor for new client messages
  // ============================================
  const processedMessages = new Set(); // dedup within session
  
  function monitorMessages() {
    console.log('[OptimizeUp] Monitoring messages...');
    
    // Watch for new messages via MutationObserver
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            checkForNewMessage(node);
          }
        }
      }
    });

    // Observe the message container — try multiple selectors
    const container = document.querySelector('[class*="thread-messages"]')
      || document.querySelector('[class*="message-list"]')
      || document.querySelector('[data-test="message-list"]') 
      || document.querySelector('.messages-thread')
      || document.body;
    
    observer.observe(container, { childList: true, subtree: true });
    console.log('[OptimizeUp] Message observer attached to:', container.className || 'body');
    
    // Also do initial scan for visible messages
    setTimeout(() => scanExistingMessages(), 3000);
  }
  
  function scanExistingMessages() {
    // Find the most recent client message on the page
    const allMsgs = document.querySelectorAll('p[class*="break-word"], [class*="message-body"] p, [data-test*="message"] p');
    console.log(`[OptimizeUp] Found ${allMsgs.length} message elements on page`);
  }

  function checkForNewMessage(node) {
    // Look for message bubbles — Upwork uses various class patterns
    const msgElements = [];
    
    // Direct message text elements
    if (node.matches?.('p[class*="break-word"], [class*="message-body"], [data-test*="message"]')) {
      msgElements.push(node);
    }
    
    // Or children of added container
    const children = node.querySelectorAll?.('p[class*="break-word"], [class*="message-body"], [data-test*="message"]');
    if (children) msgElements.push(...children);
    
    for (const el of msgElements) {
      const text = el.textContent?.trim();
      if (!text || text.length < 3 || text.length > 5000) continue;
      
      // Create message fingerprint for dedup
      const fingerprint = text.substring(0, 100) + text.length;
      if (processedMessages.has(fingerprint)) continue;
      processedMessages.add(fingerprint);
      
      // Check if this is NOT our own message (look for sender indicator)
      const msgContainer = el.closest('[class*="message"]') || el.closest('[class*="msg"]') || el.parentElement?.parentElement;
      const isOwnMessage = msgContainer?.querySelector?.('[class*="visitor"]') 
        || msgContainer?.classList?.contains('is-own')
        || msgContainer?.querySelector?.('[class*="self"]');
      
      // We want client messages, not our own
      // On Upwork, own messages are usually on the right side
      // Skip common UI elements
      if (text === 'More options' || text === 'Show more' || text.startsWith('View ')) continue;
      
      // Get client name from the page
      const clientName = getClientName();
      
      if (clientName && text.length > 10) {
        console.log(`[OptimizeUp] New message from ${clientName}: ${text.substring(0, 80)}...`);
        
        // Send to background for Opus processing
        chrome.runtime.sendMessage({
          type: 'NEW_CLIENT_MESSAGE',
          data: {
            clientName,
            messageText: text,
            url: window.location.href,
            timestamp: new Date().toISOString()
          }
        });
      }
    }
  }
  
  function getClientName() {
    // Try multiple selectors for client name on messages page
    return document.querySelector('[class*="room-header"] [class*="name"]')?.textContent?.trim()
      || document.querySelector('[class*="thread-header"] [class*="name"]')?.textContent?.trim()
      || document.querySelector('h2[class*="name"], h3[class*="name"]')?.textContent?.trim()
      || document.title?.replace(' | Upwork', '').replace('Messages - ', '').trim()
      || 'Unknown';
  }

  // ============================================
  // /my-jobs/proposals — scrape proposal statuses
  // ============================================
  function scrapeProposalStatuses() {
    console.log('[OptimizeUp] Scraping proposal statuses...');
    
    const proposals = [];
    const rows = document.querySelectorAll('[data-test="proposal-row"], .proposal-row, tr[class*="proposal"]');
    
    rows.forEach(row => {
      const title = row.querySelector('.title, [data-test="job-title"]')?.textContent?.trim();
      const status = row.querySelector('.status, [data-test="status"]')?.textContent?.trim();
      
      if (title) {
        proposals.push({ title, status: status?.toLowerCase() || 'unknown' });
      }
    });

    if (proposals.length > 0) {
      chrome.runtime.sendMessage({
        type: 'PAGE_DATA',
        data: { type: 'proposals_status', proposals }
      });
      console.log(`[OptimizeUp] Sent ${proposals.length} proposal statuses`);
    }
  }

  // ============================================
  // /reports/overview — connects balance
  // ============================================
  function scrapeConnectsBalance() {
    console.log('[OptimizeUp] Scraping connects balance...');
    
    // Look for connects number in various possible selectors
    const connectsText = document.body.innerText.match(/(\d+)\s*(?:Connects|connects)/);
    
    if (connectsText) {
      const balance = parseInt(connectsText[1]);
      chrome.runtime.sendMessage({
        type: 'PAGE_DATA',
        data: { type: 'connects_balance', balance }
      });
      console.log(`[OptimizeUp] Connects balance: ${balance}`);
    }
  }

  // ============================================
  // /my-jobs/active — active contracts
  // ============================================
  function scrapeActiveContracts() {
    console.log('[OptimizeUp] Scraping active contracts...');
    
    const contracts = [];
    const rows = document.querySelectorAll('[data-test="contract-row"], .contract-card, .my-jobs-card');
    
    rows.forEach(row => {
      const title = row.querySelector('.title, h3, [data-test="job-title"]')?.textContent?.trim();
      const client = row.querySelector('.client-name, [data-test="client-name"]')?.textContent?.trim();
      const hours = row.querySelector('.hours, [data-test="hours"]')?.textContent?.trim();
      
      if (title) {
        contracts.push({ title, client, hours });
      }
    });

    if (contracts.length > 0) {
      chrome.runtime.sendMessage({
        type: 'PAGE_DATA',
        data: { type: 'active_contracts', contracts }
      });
      console.log(`[OptimizeUp] Sent ${contracts.length} active contracts`);
    }
  }

  // ============================================
  // /notifications — invites, profile views
  // ============================================
  function scrapeNotifications() {
    console.log('[OptimizeUp] Scraping notifications...');
    // TODO: parse invite notifications
  }

  // ============================================
  // /job/ — single job page (for autofill)
  // ============================================
  function scrapeJobPage() {
    console.log('[OptimizeUp] On job page, ready for autofill');
    
    // Listen for autofill command from background/popup
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'AUTOFILL_PROPOSAL') {
        autofillProposal(msg.data.proposalText);
        sendResponse({ ok: true });
      }
    });
  }

  function autofillProposal(text) {
    // Find the proposal textarea/editor
    const textarea = document.querySelector('[data-test="proposal-textarea"]')
      || document.querySelector('textarea[name="coverLetter"]')
      || document.querySelector('.cover-letter-area textarea')
      || document.querySelector('[contenteditable="true"]');
    
    if (textarea) {
      if (textarea.tagName === 'TEXTAREA') {
        textarea.value = text;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        textarea.innerHTML = text.replace(/\n/g, '<br>');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
      console.log('[OptimizeUp] Proposal autofilled!');
    } else {
      console.warn('[OptimizeUp] Proposal textarea not found');
    }
  }

  // ============================================
  // START
  // ============================================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
