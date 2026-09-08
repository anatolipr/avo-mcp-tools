// Backs get_console_log. Two document_start content scripts (built from
// src/content-scripts/, see build/vite.content-scripts.config.ts), registered
// here once at startup so they run in every tab from then on. The MAIN-world
// script patches the page's own console.*; the ISOLATED-world script relays
// each call to the background script via chrome.runtime.sendMessage (a
// MAIN-world script has no chrome.* bridge) - routed here via
// message-handler.ts's onConsoleCapture callback, since chrome.runtime has
// one listener registry per extension. Simpler than requiring
// chrome.debugger's Runtime.consoleAPICalled (Phase 4's territory) for a
// capability plain content-script injection already covers.
const MAIN_SCRIPT_ID = 'mcp-console-capture-main';
const RELAY_SCRIPT_ID = 'mcp-console-capture-relay';
const MAX_ENTRIES_PER_TAB = 200;

export interface ConsoleLogEntry {
  level: string;
  args: string[];
  timestamp: number;
}

const logsByTab = new Map<number, ConsoleLogEntry[]>();

export async function startConsoleLogCapture(): Promise<void> {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [MAIN_SCRIPT_ID, RELAY_SCRIPT_ID] });
  if (existing.length === 0) {
    await chrome.scripting.registerContentScripts([
      {
        id: MAIN_SCRIPT_ID,
        matches: ['<all_urls>'],
        runAt: 'document_start',
        world: 'MAIN',
        js: ['content-scripts/console-capture-main.js'],
      },
      {
        id: RELAY_SCRIPT_ID,
        matches: ['<all_urls>'],
        runAt: 'document_start',
        world: 'ISOLATED',
        js: ['content-scripts/console-capture-relay.js'],
      },
    ]);
  }

  chrome.tabs.onRemoved.addListener((tabId) => {
    logsByTab.delete(tabId);
  });
}

export function recordConsoleCapture(tabId: number, level: string, args: string[]): void {
  let buf = logsByTab.get(tabId);
  if (!buf) {
    buf = [];
    logsByTab.set(tabId, buf);
  }
  buf.push({ level, args, timestamp: Date.now() });
  if (buf.length > MAX_ENTRIES_PER_TAB) buf.splice(0, buf.length - MAX_ENTRIES_PER_TAB);
}

export function getConsoleLog(tabId: number): ConsoleLogEntry[] {
  return logsByTab.get(tabId) ?? [];
}
