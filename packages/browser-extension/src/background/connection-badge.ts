// Toolbar icon badge reflecting the ACTIVE tab's connection state - a small
// colored dot (green = connected, red = not connected on a page we've
// previously connected or could connect, nothing = not a connectable page at
// all) via chrome.action.setBadgeText/setBadgeBackgroundColor, per-tab so
// switching tabs shows each tab's own state rather than one global icon.
import { tabAlreadyConnected } from './connect-tab.js';

const GREEN = '#22c55e';
const RED = '#ef4444';

async function updateBadgeForTab(tabId: number, url: string | undefined): Promise<void> {
  if (!url || !/^https?:/.test(url)) {
    await chrome.action.setBadgeText({ tabId, text: '' });
    return;
  }
  const connected = await tabAlreadyConnected(tabId);
  await chrome.action.setBadgeText({ tabId, text: connected ? '●' : '○' });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: connected ? GREEN : RED });
}

// Exported so message-handler.ts (after a successful connect-active-tab) and
// auto-reconnect.ts (after injecting/finding a live connection) can refresh
// the badge immediately rather than waiting for the next tab-switch/navigation
// event to happen to trigger a recheck.
export async function refreshBadgeForActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id !== undefined) await updateBadgeForTab(tab.id, tab.url);
}

export function startConnectionBadge(): void {
  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    await updateBadgeForTab(tabId, tab?.url);
  });

  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') return;
    if (!tab.active) return;
    await updateBadgeForTab(tabId, tab.url);
  });

  refreshBadgeForActiveTab();
}
