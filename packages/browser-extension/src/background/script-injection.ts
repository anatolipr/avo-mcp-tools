// Backs inject_script / inject_persistent_script / unregister_persistent_script.
//
// inject_persistent_script's mechanism: registerContentScripts requires a
// file-based js[] (see console-log.ts's note on the same constraint), so a
// single pair of static files (persistent-script-runner.js/
// persistent-script-main-runner.js) is registered once per DISTINCT
// matchOrigin pattern; the actual agent-supplied code for each
// inject_persistent_script call is kept here in memory, keyed by an id, and
// looked up by mcp-persistent-script-lookup (see message-handler.ts) against
// the navigating page's URL every time the runner script asks - not baked
// into the registered script itself, which is what lets one static file
// serve arbitrarily many different persistent scripts.
export interface PersistentScriptEntry {
  id: string;
  matchOrigin: string;
  code: string;
}

const RUNNER_SCRIPT_ID_PREFIX = 'mcp-persistent-runner';
const persistentScripts = new Map<string, PersistentScriptEntry>();
let counter = 0;

function urlMatchesPattern(url: string, pattern: string): boolean {
  // Minimal match-pattern support (scheme://host/path with * wildcards) -
  // sufficient for the common "https://example.com/*" / "<all_urls>" cases
  // this tool is meant for; not a full chrome match-pattern implementation.
  if (pattern === '<all_urls>') return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(url);
}

export async function injectScriptOnce(tabId: number, code: string): Promise<unknown> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (function (source: string) {
      return new Function(source)();
    }) as (source: string) => unknown,
    args: [code],
    world: 'MAIN',
  });
  return results[0]?.result;
}

async function ensureRunnerRegistered(matchOrigin: string): Promise<void> {
  const id = `${RUNNER_SCRIPT_ID_PREFIX}:${matchOrigin}`;
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id, `${id}-main`] });
  if (existing.length > 0) return;
  await chrome.scripting.registerContentScripts([
    {
      id,
      matches: [matchOrigin],
      runAt: 'document_start',
      world: 'ISOLATED',
      js: ['content-scripts/persistent-script-runner.js'],
    },
    {
      id: `${id}-main`,
      matches: [matchOrigin],
      runAt: 'document_start',
      world: 'MAIN',
      js: ['content-scripts/persistent-script-main-runner.js'],
    },
  ]);
}

export async function injectPersistentScript(matchOrigin: string, code: string): Promise<string> {
  await ensureRunnerRegistered(matchOrigin);
  const id = `persistent-${++counter}-${Date.now()}`;
  persistentScripts.set(id, { id, matchOrigin, code });
  return id;
}

export async function unregisterPersistentScript(id: string): Promise<boolean> {
  return persistentScripts.delete(id);
}

export function lookupPersistentScriptsForUrl(url: string): string[] {
  return [...persistentScripts.values()].filter((entry) => urlMatchesPattern(url, entry.matchOrigin)).map((entry) => entry.code);
}
