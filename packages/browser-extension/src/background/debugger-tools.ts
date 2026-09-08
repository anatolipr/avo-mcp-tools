// read_response_body / modify_request - the two chrome.debugger-gated tools
// (Phase 4). Uses the Chrome DevTools Protocol's Network/Fetch domains
// directly via chrome.debugger.sendCommand, since that's the only way to
// read a response body or intercept/modify a request from an extension
// (webRequest is read-only for headers/metadata, never bodies, and never
// blocking without the deprecated webRequestBlocking permission this
// package doesn't request).
import { ensureDebuggerAttached } from './debugger-permission.js';

function sendCommand<T = unknown>(tabId: number, method: string, params?: object): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result as T);
    });
  });
}

const networkEnabledTabs = new Set<number>();

async function ensureNetworkDomainEnabled(tabId: number): Promise<void> {
  await ensureDebuggerAttached(tabId);
  if (networkEnabledTabs.has(tabId)) return;
  await sendCommand(tabId, 'Network.enable');
  networkEnabledTabs.add(tabId);
}

export async function readResponseBody(tabId: number, requestId: string): Promise<{ body: string; base64Encoded: boolean }> {
  await ensureNetworkDomainEnabled(tabId);
  return sendCommand(tabId, 'Network.getResponseBody', { requestId });
}

// "Modify" a request: sets up a Fetch-domain interception matching a URL
// pattern on a tab, then continues each matched request with the caller's
// overrides applied. One registration per (tabId, urlPattern) combination -
// re-registering the same tab replaces its previous pattern/overrides
// (Fetch.enable takes one pattern set per tab) rather than stacking listeners.
export interface ModifyRequestOptions {
  urlPattern: string;
  overrideHeaders?: Record<string, string>;
  overrideMethod?: string;
  overridePostData?: string;
}

interface ModifierEntry {
  id: string;
  tabId: number;
  listener: (source: chrome.debugger.Debuggee, method: string, params: any) => void;
}

let modifierCounter = 0;
const modifiersByTab = new Map<number, ModifierEntry>();

export async function modifyRequest(tabId: number, opts: ModifyRequestOptions): Promise<string> {
  await ensureDebuggerAttached(tabId);

  const existing = modifiersByTab.get(tabId);
  if (existing) chrome.debugger.onEvent.removeListener(existing.listener);

  await sendCommand(tabId, 'Fetch.enable', { patterns: [{ urlPattern: opts.urlPattern }] });

  const id = `modifier-${++modifierCounter}`;
  const listener = (source: chrome.debugger.Debuggee, method: string, params: any) => {
    if (source.tabId !== tabId || method !== 'Fetch.requestPaused') return;
    const headers = opts.overrideHeaders
      ? Object.entries({ ...(params.request.headers ?? {}), ...opts.overrideHeaders }).map(([name, value]) => ({
          name,
          value: String(value),
        }))
      : undefined;
    chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', {
      requestId: params.requestId,
      method: opts.overrideMethod,
      postData: opts.overridePostData,
      headers,
    });
  };
  chrome.debugger.onEvent.addListener(listener);
  modifiersByTab.set(tabId, { id, tabId, listener });

  return id;
}

export async function unregisterRequestModifier(id: string): Promise<boolean> {
  const entry = [...modifiersByTab.values()].find((m) => m.id === id);
  if (!entry) return false;
  chrome.debugger.onEvent.removeListener(entry.listener);
  modifiersByTab.delete(entry.tabId);
  await sendCommand(entry.tabId, 'Fetch.disable').catch(() => undefined);
  return true;
}

// Called from debugger-permission.ts's onDetach tracking - a detached tab's
// enabled-domain/modifier bookkeeping here is no longer valid (the debugger
// session it belonged to is gone), so drop it rather than leaving stale
// entries that would silently no-op or throw on next use.
export function clearDebuggerStateForTab(tabId: number): void {
  networkEnabledTabs.delete(tabId);
  const entry = modifiersByTab.get(tabId);
  if (entry) {
    chrome.debugger.onEvent.removeListener(entry.listener);
    modifiersByTab.delete(tabId);
  }
}
