// The background's own half of the HUMAN-MCP CALL/RESULT sentinel protocol
// (see human-mcp-relay/src/protocol.js), applied to THIS extension's own
// getHostTools() registry rather than a page's window.__mcpTools. Shared by
// two callers: message-handler.ts's relay-bus-forward handler (when a chat
// tab's injected loop targets EXTENSION_APP_TAB_SENTINEL instead of a real
// app tab - see relay-chat-loop.ts) and its run-host-tool-call handler (the
// popup's own "Relay mode" panel, for a human manually pasting a CALL block
// with no chat-tab loop involved at all). Both paths funnel through
// runCallAgainstHostTools so CALL-parsing/dispatch/RESULT-formatting exists
// in exactly one place.
//
// Only imports primer.js/protocol.js from human-mcp-relay - never relay.js
// itself, which imports Lit from a CDN URL and self-mounts a
// <human-mcp-relay> custom element at module load, neither of which belongs
// in this bundle.
import { parseCall, formatResult } from 'human-mcp-relay/src/protocol.js';
import { buildPrimer } from 'human-mcp-relay/src/primer.js';
import { getHostTools } from './host-tools.js';

// The session name/tag assigned to the extension when it's bridged as an
// "app" (see relay-panel.ts's sentinel option) or renamed from the Relay-
// mode panel. Mirrors what a real app tab's own window.__humanMcpRelay.
// setSessionName persists (see relay.js), but there is no real page for the
// extension itself to hold this - module-level state here instead, with the
// same reload-wipes-it lifetime as every other piece of this package's
// stateless background design (a service worker restart also kills any
// running chat-loop's own win.__mcpRelayAppTabs, so losing this too is
// consistent, not a new weakness).
let extensionSessionName = '';

export function getExtensionSessionName(): string {
  return extensionSessionName;
}

export function setExtensionSessionName(tag: string): void {
  extensionSessionName = tag;
}

// Parses a raw HUMAN-MCP CALL block, dispatches it against getHostTools(),
// and returns a formatted HUMAN-MCP RESULT block - never throws for a
// call-level failure (malformed block, unknown tool name, the tool's own fn
// throwing); those become a well-formed ok:false RESULT instead, matching
// relay.js's own _runCall behavior, so every caller always gets pasteable/
// forwardable text back rather than needing its own try/catch around
// protocol-level errors.
export async function runCallAgainstHostTools(callText: string, sessionName?: string): Promise<string> {
  let toolName = 'unknown';
  try {
    const parsed = parseCall(callText, sessionName);
    toolName = parsed.tool;
    const tool = getHostTools().find((t) => t.name === parsed.tool);
    if (!tool) {
      const names = getHostTools()
        .map((t) => t.name)
        .join(', ');
      return formatResult({ tool: parsed.tool, ok: false, error: `Unknown tool "${parsed.tool}". Available tools: ${names}` }, sessionName);
    }
    const data = await tool.fn(parsed.args);
    return formatResult({ tool: parsed.tool, ok: true, data }, sessionName);
  } catch (err) {
    return formatResult({ tool: toolName, ok: false, error: String((err as Error)?.message ?? err) }, sessionName);
  }
}

// Background-side equivalent of a real app tab's own
// window.__humanMcpRelay.getPrimer() - built directly from getHostTools()
// since the background already has that registry locally, no injection
// needed. Passing an explicit appName means this never touches `document`
// (unavailable in the service worker) - primer.js only reads document.title
// as a fallback behind `context.appName ||`.
export function buildExtensionPrimer(sessionName?: string): string {
  return buildPrimer(getHostTools(), { appName: 'Browser extension', sessionName: sessionName ?? extensionSessionName });
}
