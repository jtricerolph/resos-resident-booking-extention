// Background Service Worker for Resos NewBook Assistant

let settings = null;
let sidepanelPort = null;

// Track sidepanel open/close via port connection
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    sidepanelPort = port;
    notifyContentScript('panelOpened');

    port.onDisconnect.addListener(() => {
      sidepanelPort = null;
      notifyContentScript('panelClosed');
    });
  }
});

function notifyContentScript(action) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { action }).catch(() => {});
    }
  });
}

async function loadSettings() {
  try {
    const result = await chrome.storage.sync.get('settings');
    settings = result.settings || null;
    return settings;
  } catch (error) {
    console.error('Error loading settings:', error);
    return null;
  }
}

// Initialize on install/update
chrome.runtime.onInstalled.addListener(async () => {
  await loadSettings();
  try {
    await chrome.sidePanel.setOptions({
      path: 'sidepanel/sidepanel.html',
      enabled: false
    });
  } catch (error) {
    console.error('Error setting global sidepanel options:', error);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await loadSettings();
});

// Tab Update Listener
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    await handleTabUpdate(tabId, tab.url);
  }
  // Also forward URL changes mid-navigation (SPA)
  if (changeInfo.url && tab.url && tab.url.includes('app.resos.com')) {
    chrome.runtime.sendMessage({
      action: 'urlChanged',
      url: changeInfo.url
    }).catch(() => {});
  }
});

// Tab Activated Listener
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url) {
      await handleTabUpdate(activeInfo.tabId, tab.url);
      if (tab.url.includes('app.resos.com')) {
        chrome.runtime.sendMessage({
          action: 'urlChanged',
          url: tab.url
        }).catch(() => {});
      }
    }
  } catch (error) {
    // Tab may have been closed
  }
});

async function handleTabUpdate(tabId, url) {
  const isResosDomain = url.includes('app.resos.com');

  try {
    if (isResosDomain) {
      await chrome.sidePanel.setOptions({
        tabId,
        path: 'sidepanel/sidepanel.html',
        enabled: true
      });
      // Auto-open sidepanel on Resos pages
      try {
        await chrome.sidePanel.open({ tabId });
      } catch (_) {
        // May fail if no user gesture yet — that's fine, toolbar click still works
      }
      await chrome.action.setBadgeText({ tabId, text: '' });
      await chrome.action.setTitle({ tabId, title: 'Open Resos NewBook Assistant' });
    } else {
      await chrome.sidePanel.setOptions({ tabId, enabled: false });
      await chrome.action.setBadgeText({ tabId, text: '' });
      await chrome.action.setTitle({ tabId, title: 'Resos NewBook Assistant' });
    }
  } catch (error) {
    console.error('Error handling tab update:', error);
  }
}

// Toolbar click opens side panel
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (error) {
    console.error('Failed to open sidepanel:', error);
  }
});

// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'settingsUpdated') {
    settings = message.settings;
    chrome.runtime.sendMessage(message).catch(() => {});
  } else if (message.action === 'getActiveTabUrl') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      sendResponse({ url: tabs[0]?.url || '' });
    });
    return true; // async response
  } else if (message.action === 'navigateTab') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.update(tabs[0].id, { url: message.url });
      }
    });
  } else if (message.action === 'openSidePanel') {
    const tabId = sender.tab?.id;
    if (tabId) {
      chrome.sidePanel.open({ tabId }).catch((err) => {
        console.error('Failed to open sidepanel:', err);
      });
    }
  } else if (message.action === 'getPanelState') {
    sendResponse({ open: !!sidepanelPort });
    return true;
  }
  return true;
});

loadSettings();
