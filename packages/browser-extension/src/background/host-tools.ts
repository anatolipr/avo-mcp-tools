// Fixed-manifest registry for the extension's own ship-with-the-package
// tools - the extension's analog of a page's window.__mcpTools (always
// source: 'host', kept entirely separate from extension-tool-bus.ts's
// registry of agent-created dynamic tools, exactly like main.ts keeps
// window.__mcpTools and window.__mcpToolBus as two separate sources merged
// only at send/dispatch time). Deliberately its own tiny module rather than
// living in extension-tool-bus.ts: getTools() there hard-tags everything
// 'dynamic', which is correct for that registry and would be wrong here.
import type { ExtensionTool } from './extension-tool-bus.js';

export type HostTool = Omit<ExtensionTool, 'source'> & { source: 'host' };

const hostTools = new Map<string, HostTool>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) cb();
}

export function registerHostTools(tools: Omit<ExtensionTool, 'source'>[]): void {
  for (const tool of tools) {
    hostTools.set(tool.name, { ...tool, source: 'host' });
  }
  notify();
}

// Used by debugger-permission.ts's onDetach path to pull
// read_response_body/modify_request back OUT of the manifest once the
// debugger detaches - see builtin-tools.ts's registerDebuggerGatedTools.
export function unregisterHostTools(names: string[]): void {
  let changed = false;
  for (const name of names) {
    changed = hostTools.delete(name) || changed;
  }
  if (changed) notify();
}

export function getHostTools(): HostTool[] {
  return [...hostTools.values()];
}

export function getHostTool(name: string): HostTool | undefined {
  return hostTools.get(name);
}

// Mirrors extension-tool-bus.ts's onChange - lets extension-connection.ts
// re-send the manifest whenever the host-tool set changes (e.g. the
// debugger-gated tools appearing/disappearing), the same way it already
// reacts to the dynamic bus changing.
export function onHostToolsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
