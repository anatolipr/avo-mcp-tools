// Service-worker adaptation of js-bridge-mcp/src/client/main.ts's onCall
// handler for the three reserved call names (register_page_tool_by_path/
// _by_code, unregister_page_tool - see mcp-tenant-lib/src/client-bridge.ts's
// REMOTE_REGISTER_BY_PATH_CALL/REMOTE_REGISTER_BY_CODE_CALL/
// REMOTE_UNREGISTER_CALL). Not a shared import: main.ts's handlers hard-require
// `window`/`document` (path resolution off `window as any`, code compiled as
// `new Function('args', 'document', 'window', code)`), neither of which
// exists in a service worker. Only the reserved-name string constants
// themselves are shared (imported from mcp-tenant-lib/client) so the two
// implementations can never drift on the magic strings.
//
// Trust model: agent-registered code here compiles with `chrome`/`browser` in
// scope (raw APIs, no curated wrapper) - the same trust level page-side
// dynamic tools already have today (full window/document, no sandboxing).
// The extension is something the user explicitly installs and controls, not
// third-party code, so this is a deliberate choice, not an oversight.
import {
  REMOTE_REGISTER_BY_PATH_CALL,
  REMOTE_REGISTER_BY_CODE_CALL,
  REMOTE_UNREGISTER_CALL,
  REMOTE_REQUEST_RECONNECT_CALL,
} from 'mcp-tenant-lib/client';
import type { ToolParamSpec } from 'mcp-tenant-lib';
import { getExtensionToolBus } from './extension-tool-bus.js';
import { getKnownOrigin } from './storage.js';
import { injectConnectSnippet } from './connect-tab.js';
import { markTabConnected } from './auto-reconnect.js';
import { recordConnectedTab } from './connected-tabs.js';

const dynamicUnregisterByName = new Map<string, () => void>();

export async function handleReservedCall(name: string, args: unknown): Promise<{ handled: true; result?: unknown; error?: string } | { handled: false }> {
  const bus = getExtensionToolBus();

  if (name === REMOTE_REGISTER_BY_PATH_CALL) {
    try {
      const { name: toolName, description, path, params } = args as { name: string; description: string; path: string; params?: Record<string, ToolParamSpec> };
      const segments = path.split('.');
      const lastKey = segments.pop()!;
      const root = (self as any).__extensionApiRoot ?? self;
      const parent = segments.reduce((obj: any, key) => obj?.[key], root as any);
      const fn = parent?.[lastKey];
      if (typeof fn !== 'function') {
        return { handled: true, error: `"${path}" does not resolve to a function on the extension's global scope` };
      }
      const bound = (a: unknown) => fn.call(parent, a);
      const unregister = bus.registerTool(toolName, bound, { description, params, origin: { kind: 'path', path } });
      dynamicUnregisterByName.set(toolName, unregister);
      return { handled: true, result: `registered "${toolName}" -> self.${path}` };
    } catch (err) {
      return { handled: true, error: String((err as Error).message) };
    }
  }

  if (name === REMOTE_REGISTER_BY_CODE_CALL) {
    try {
      const { name: toolName, description, code, params } = args as { name: string; description: string; code: string; params?: Record<string, ToolParamSpec> };
      let compiled: (a: unknown, chromeApi: typeof chrome, browserApi: unknown) => unknown;
      try {
        // No `document`/`window` params here (a service worker has neither) -
        // `chrome`/`browser` take their place as the ambient privileged APIs
        // this context naturally offers, mirroring main.ts's "expose whatever
        // this execution context's ambient globals are" pattern.
        compiled = new Function('args', 'chrome', 'browser', code) as any;
      } catch (err) {
        return { handled: true, error: `code failed to compile: ${(err as Error).message}` };
      }
      const browserGlobal = (self as any).browser ?? chrome;
      const wrapped = async (a: unknown) => compiled(a, chrome, browserGlobal);
      const unregister = bus.registerTool(toolName, wrapped, { description, params, origin: { kind: 'code', code } });
      dynamicUnregisterByName.set(toolName, unregister);
      return { handled: true, result: `registered "${toolName}" from code` };
    } catch (err) {
      return { handled: true, error: String((err as Error).message) };
    }
  }

  if (name === REMOTE_REQUEST_RECONNECT_CALL) {
    const { targetOrigin, targetTabId } = args as { targetOrigin?: string; targetTabId?: number };
    return handleRequestReconnect(targetOrigin, targetTabId);
  }

  if (name === REMOTE_UNREGISTER_CALL) {
    const { toolName } = args as { toolName: string };
    const unregister = dynamicUnregisterByName.get(toolName);
    if (!unregister) {
      return {
        handled: true,
        error: `"${toolName}" is not a currently-tracked dynamically-registered tool on the extension connection (already removed, never dynamic, or a host tool — host tools can never be unregistered remotely)`,
      };
    }
    unregister();
    dynamicUnregisterByName.delete(toolName);
    return { handled: true, result: `unregistered "${toolName}"` };
  }

  return { handled: false };
}

// The real implementation of request_reconnect (see mcp-tenant-lib's
// manifest-tools.ts and client-bridge.ts) - an agent-triggered version of
// the popup's manual "connect this tab" flow (connect-tab.ts), with the
// channel implied by targetOrigin's already-known-channel storage entry
// (storage.ts) rather than asked interactively. Errors clearly, same
// "clear tool error, not silent failure" convention register_page_tool_by_code
// already follows, if targetOrigin has no known prior channel.
async function handleRequestReconnect(
  targetOrigin: string | undefined,
  targetTabId: number | undefined
): Promise<{ handled: true; result?: unknown; error?: string }> {
  try {
    let tabId = targetTabId;
    let origin = targetOrigin;

    if (tabId === undefined) {
      if (!origin) {
        return { handled: true, error: 'request_reconnect needs targetOrigin or targetTabId to know which tab to reconnect.' };
      }
      const tabs = await chrome.tabs.query({ url: `${origin}/*` });
      const tab = tabs[0];
      if (!tab?.id) {
        return { handled: true, error: `No open tab found matching origin "${origin}".` };
      }
      tabId = tab.id;
    } else if (!origin) {
      const tab = await chrome.tabs.get(tabId);
      if (!tab.url) return { handled: true, error: `Tab ${tabId} has no URL to resolve an origin from.` };
      origin = new URL(tab.url).origin;
    }

    const known = await getKnownOrigin(origin);
    if (!known) {
      return {
        handled: true,
        error: `Origin "${origin}" has no known prior channel — it was never connected via the extension's popup, so there's nothing to reconnect it to.`,
      };
    }

    const label = known.appLabel || origin.replace(/^https?:\/\//, '');
    await injectConnectSnippet(tabId, known.channel, label);
    markTabConnected(tabId);
    recordConnectedTab(tabId, known.channel, label);
    return { handled: true, result: `reconnected tab ${tabId} (origin "${origin}") to channel "${known.channel}"` };
  } catch (err) {
    return { handled: true, error: String((err as Error).message) };
  }
}
