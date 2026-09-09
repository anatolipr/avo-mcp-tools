// Backs get_network_log: a chrome.webRequest listener registered once at
// startup, buffering recent request/response summaries per tab in memory.
// Read-only observation only (no webRequestBlocking) - this extension never
// modifies traffic in Phase 3; that's chrome.debugger territory (Phase 4).
export interface NetworkLogEntry {
  requestId: string;
  url: string;
  method: string;
  type: string;
  statusCode?: number;
  statusLine?: string;
  responseHeaders?: Record<string, string>;
  startedAt: number;
  completedAt?: number;
  error?: string;
}

const MAX_ENTRIES_PER_TAB = 200;
const logsByTab = new Map<number, Map<string, NetworkLogEntry>>();

function bufferFor(tabId: number): Map<string, NetworkLogEntry> {
  let buf = logsByTab.get(tabId);
  if (!buf) {
    buf = new Map();
    logsByTab.set(tabId, buf);
  }
  return buf;
}

function trim(buf: Map<string, NetworkLogEntry>): void {
  while (buf.size > MAX_ENTRIES_PER_TAB) {
    const oldestKey = buf.keys().next().value;
    if (oldestKey === undefined) break;
    buf.delete(oldestKey);
  }
}

export function startNetworkLogCapture(): void {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0) return; // not associated with a tab (e.g. extension's own requests)
      const buf = bufferFor(details.tabId);
      buf.set(details.requestId, {
        requestId: details.requestId,
        url: details.url,
        method: details.method,
        type: details.type,
        startedAt: details.timeStamp,
      });
      trim(buf);
    },
    { urls: ['<all_urls>'] }
  );

  chrome.webRequest.onCompleted.addListener(
    (details) => {
      if (details.tabId < 0) return;
      const buf = logsByTab.get(details.tabId);
      const entry = buf?.get(details.requestId);
      if (!entry) return;
      entry.statusCode = details.statusCode;
      entry.statusLine = details.statusLine;
      entry.completedAt = details.timeStamp;
      entry.responseHeaders = Object.fromEntries(
        (details.responseHeaders ?? []).map((h) => [h.name, h.value ?? ''])
      );
    },
    { urls: ['<all_urls>'] },
    // 'extraHeaders' is required to see Set-Cookie (and a few other
    // sensitive headers like X-Frame-Options/CSP) at all - Chrome strips
    // them from responseHeaders by default regardless of what the response
    // actually sent, unless a listener explicitly opts into seeing them.
    ['responseHeaders', 'extraHeaders']
  );

  chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      if (details.tabId < 0) return;
      const buf = logsByTab.get(details.tabId);
      const entry = buf?.get(details.requestId);
      if (!entry) return;
      entry.error = details.error;
      entry.completedAt = details.timeStamp;
    },
    { urls: ['<all_urls>'] }
  );

  chrome.tabs.onRemoved.addListener((tabId) => {
    logsByTab.delete(tabId);
  });
}

export function getNetworkLog(tabId: number): NetworkLogEntry[] {
  const buf = logsByTab.get(tabId);
  return buf ? [...buf.values()] : [];
}
