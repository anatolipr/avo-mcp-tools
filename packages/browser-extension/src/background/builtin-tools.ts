// Registers the extension's ship-with-the-package tools at startup -
// source: 'host', NOT registered via the reserved register_page_tool_by_*
// calls (those exist for an AGENT to create a new tool remotely). Host tools
// can never be remotely unregistered (unregister_page_tool's existing safety
// guarantee, see mcp-tenant-lib/src/manifest-tools.ts), so an agent cannot
// accidentally strip the extension's own built-in capabilities. See the plan
// (section 3) for why this is a separate category from agent-created dynamic
// tools rather than a shared mechanism.
import type { ExtensionTool } from './extension-tool-bus.js';
import { registerHostTools, unregisterHostTools } from './host-tools.js';
import { startNetworkLogCapture, getNetworkLog } from './network-log.js';
import { startConsoleLogCapture, getConsoleLog } from './console-log.js';
import { injectScriptOnce, injectPersistentScript, unregisterPersistentScript } from './script-injection.js';
import {
  isDebuggerApiAvailable,
  requestDebuggerApproval,
  ensureDebuggerAttached,
  startDebuggerDetachTracking,
} from './debugger-permission.js';
import { readResponseBody, modifyRequest, unregisterRequestModifier, clearDebuggerStateForTab } from './debugger-tools.js';

const DEBUGGER_GATED_TOOL_NAMES = ['read_response_body', 'modify_request', 'unregister_request_modifier'];

async function resolveTabId(explicitTabId?: number): Promise<number> {
  if (typeof explicitTabId === 'number') return explicitTabId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found and no tabId was given.');
  return tab.id;
}

export async function registerBuiltinTools(): Promise<void> {
  startNetworkLogCapture();
  await startConsoleLogCapture();

  const tools: Omit<ExtensionTool, 'source'>[] = [
    {
      name: 'get_network_log',
      description:
        'Recent network requests/responses (URL, method, status, response headers, timing) observed for a browser tab. ' +
        'Read-only — does not intercept or modify traffic. Defaults to the active tab if tabId is omitted.',
      params: { tabId: { type: 'number', description: 'Tab id to read. Omit for the active tab.', optional: true } },
      fn: async (args) => {
        const { tabId } = (args ?? {}) as { tabId?: number };
        return getNetworkLog(await resolveTabId(tabId));
      },
    },
    {
      name: 'get_console_log',
      description:
        'Recent console.log/info/warn/error/debug calls captured from a browser tab. Defaults to the active tab if tabId is omitted.',
      params: { tabId: { type: 'number', description: 'Tab id to read. Omit for the active tab.', optional: true } },
      fn: async (args) => {
        const { tabId } = (args ?? {}) as { tabId?: number };
        return getConsoleLog(await resolveTabId(tabId));
      },
    },
    {
      name: 'inject_script',
      description:
        'Runs JavaScript once in a browser tab (same window/document access as pasting into that tab\'s own DevTools console). ' +
        'Defaults to the active tab if tabId is omitted. Returns the code\'s return value.',
      params: {
        code: { type: 'string', description: 'JavaScript source to run — same signature as new Function(code).' },
        tabId: { type: 'number', description: 'Tab id to run in. Omit for the active tab.', optional: true },
      },
      fn: async (args) => {
        const { code, tabId } = args as { code: string; tabId?: number };
        return injectScriptOnce(await resolveTabId(tabId), code);
      },
    },
    {
      name: 'inject_persistent_script',
      description:
        'Registers JavaScript that re-runs automatically at the start of every future page load matching matchOrigin ' +
        '(a URL match pattern, e.g. "https://example.com/*" or "<all_urls>"), until unregister_persistent_script is called ' +
        'with the returned id. Use this for something that needs to survive navigations, unlike inject_script\'s one-shot run.',
      params: {
        matchOrigin: { type: 'string', description: 'URL match pattern, e.g. "https://example.com/*" or "<all_urls>".' },
        code: { type: 'string', description: 'JavaScript source to run on each matching page load.' },
      },
      fn: async (args) => {
        const { matchOrigin, code } = args as { matchOrigin: string; code: string };
        const id = await injectPersistentScript(matchOrigin, code);
        return { id };
      },
    },
    {
      name: 'unregister_persistent_script',
      description: 'Removes a persistent script previously registered via inject_persistent_script, by its returned id.',
      params: { id: { type: 'string', description: 'id returned by inject_persistent_script.' } },
      fn: async (args) => {
        const { id } = args as { id: string };
        const removed = await unregisterPersistentScript(id);
        return removed ? `unregistered "${id}"` : `"${id}" was not a registered persistent script`;
      },
    },
  ];

  if (isDebuggerApiAvailable()) {
    tools.push({
      name: 'enable_debugger_tools',
      description:
        'Chrome-only. Asks the human to approve attaching chrome\'s debugger to a tab, which unlocks read_response_body and ' +
        'modify_request (not available until this succeeds). Shows a browser notification the human must click "Approve" — ' +
        'this call blocks until they respond. Once approved, attaches to the given (or active) tab; Chrome then shows a ' +
        'visible "extension is debugging this browser" banner on that tab for as long as it stays attached. Not available ' +
        'on Firefox (no chrome.debugger equivalent).',
      params: { tabId: { type: 'number', description: 'Tab id to attach to. Omit for the active tab.', optional: true } },
      fn: async (args) => {
        const { tabId } = (args ?? {}) as { tabId?: number };
        const resolvedTabId = await resolveTabId(tabId);
        const approved = await requestDebuggerApproval(
          `A connected agent wants to read/modify network traffic on tab ${resolvedTabId} using Chrome's debugger.`
        );
        if (!approved) {
          return { approved: false, message: 'Not approved (declined or dismissed).' };
        }
        await ensureDebuggerAttached(resolvedTabId);
        registerDebuggerGatedTools();
        return { approved: true, tabId: resolvedTabId, message: 'read_response_body and modify_request are now available.' };
      },
    });
  }

  registerHostTools(tools);

  if (isDebuggerApiAvailable()) {
    startDebuggerDetachTracking((tabId) => {
      clearDebuggerStateForTab(tabId);
      unregisterHostTools(DEBUGGER_GATED_TOOL_NAMES);
    });
  }
}

// Called once enable_debugger_tools succeeds - adds the two gated tools to
// the host manifest (triggers a register_tools resend via
// host-tools.ts's onHostToolsChange, wired in extension-connection.ts).
// Removed again on debugger detach (see startDebuggerDetachTracking above),
// so describe_tools never advertises a tool that would immediately fail.
function registerDebuggerGatedTools(): void {
  registerHostTools([
    {
      name: 'read_response_body',
      description:
        'Reads the response body of a network request by its CDP requestId (from get_network_log\'s entries, once ' +
        'chrome.debugger has Network domain access) on a tab enable_debugger_tools was already run against.',
      params: {
        tabId: { type: 'number', description: 'Tab id — must already have debugger tools enabled via enable_debugger_tools.' },
        requestId: { type: 'string', description: 'Request id, e.g. from get_network_log.' },
      },
      fn: async (args) => {
        const { tabId, requestId } = args as { tabId: number; requestId: string };
        return readResponseBody(tabId, requestId);
      },
    },
    {
      name: 'modify_request',
      description:
        'Intercepts future requests on a tab matching urlPattern and continues them with overridden headers/method/body. ' +
        'Requires enable_debugger_tools to have been run against the same tab first. Returns an id — pass it to ' +
        'unregister_request_modifier to stop intercepting.',
      params: {
        tabId: { type: 'number', description: 'Tab id — must already have debugger tools enabled via enable_debugger_tools.' },
        urlPattern: { type: 'string', description: 'URL match pattern, e.g. "https://example.com/api/*".' },
        overrideHeaders: { type: 'string', description: 'JSON object of header name -> value overrides.', optional: true },
        overrideMethod: { type: 'string', description: 'HTTP method override.', optional: true },
        overridePostData: { type: 'string', description: 'Request body override.', optional: true },
      },
      fn: async (args) => {
        const { tabId, urlPattern, overrideHeaders, overrideMethod, overridePostData } = args as {
          tabId: number;
          urlPattern: string;
          overrideHeaders?: string;
          overrideMethod?: string;
          overridePostData?: string;
        };
        const id = await modifyRequest(tabId, {
          urlPattern,
          overrideHeaders: overrideHeaders ? JSON.parse(overrideHeaders) : undefined,
          overrideMethod,
          overridePostData,
        });
        return { id };
      },
    },
    {
      name: 'unregister_request_modifier',
      description: 'Stops a request interception previously registered via modify_request, by its returned id.',
      params: { id: { type: 'string', description: 'id returned by modify_request.' } },
      fn: async (args) => {
        const { id } = args as { id: string };
        const removed = await unregisterRequestModifier(id);
        return removed ? `unregistered "${id}"` : `"${id}" was not a registered request modifier`;
      },
    },
  ]);
}
