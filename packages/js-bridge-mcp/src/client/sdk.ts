// The unified, ergonomic entrypoint for a normal bundler-based host app
// (Vite/TS, e.g. formalin/mindfoo/bulletino/htmlpaint-style) to adopt
// js-bridge-mcp: `import { connectMcpBridge, defineTool } from
// 'js-bridge-mcp/client'`. This is TypeScript, unlike tool-bus.js/connect.js
// (which stay hand-written vanilla JS, served as static files and imported
// by URL) - this file goes through the real tsc/vite build pipeline instead
// of copyClientExtras, because it's meant to be resolved from node_modules
// like any other npm dependency, not fetched at runtime.
//
// sdk.ts does NOT bundle tool-bus.js's or connect.js's actual logic - it
// stays a thin orchestration/typing layer over those URL-fetched globals
// (window.__mcpToolBus, createMcpConnect), so a consumer that only uses
// defineTool still lazily fetches the bus on first use rather than
// statically bundling it in. This keeps the "genuinely lazy, zero baggage"
// property intact even for js-bridge-mcp/client consumers: an app that
// imports this module but never calls defineTool/connectMcpBridge never
// triggers the bus fetch at all.
//
// FUTURE (not built here, deliberately deferred - see README "Roadmap"):
// a visual tool-mapper UI (browse window.* for candidate functions, map to
// a tool name via a click-through picker instead of hand-typing
// registerTool calls) would hook in here as its own further lazy import,
// e.g. `await import(\`${JSBRIDGE_HOST}/tool-mapper.js\`)` triggered by an
// explicit user action (a DevTools console call, or a dashboard button
// that itself performs that import) - never auto-loaded, so a page that
// never opts in pays zero bytes for it. This comment is the extension
// point, not a stub to fill in.

import { createMcpConnect } from './connect.js';

export interface McpToolBus {
  registerProvider(providerName: string, tools: unknown[]): () => void;
  registerTool(
    name: string,
    fn: (args: any) => unknown | Promise<unknown>,
    opts?: DefineToolOptions
  ): () => void;
  getTools(): unknown[];
  onChange(cb: () => void): () => void;
}

export interface DefineToolOptions {
  description?: string;
  params?: Record<string, { type: string; description?: string; optional?: boolean }>;
  example?: Record<string, unknown>;
}

// tool-bus.js is normally fetched by URL (`<server>/tool-bus.js`, or a
// jsDelivr URL for a no-bundler host) - this SDK entrypoint is a BUNDLED
// file with no guaranteed access to that URL at build time, so it needs a
// runtime dynamic import of it, mirroring the exact pattern bulletino-1's
// mcp-connect.mjs already uses for its own bus loading. tool-bus.js
// self-installs on `window.__mcpToolBus ??= (...)`, so a redundant import
// (e.g. the host page already loaded it another way) is a safe no-op.
//
// JSBRIDGE_HOST mirrors connect.js's own hardcoded localhost target -
// js-bridge-mcp has no production deployment, so the live connection
// always targets localhost regardless of where this SDK's own code was
// fetched from (npm/node_modules here, vs. a URL for tool-bus.js itself).
const JSBRIDGE_HOST = 'http://localhost:8766';

let busLoadPromise: Promise<McpToolBus | undefined> | undefined;

function ensureToolBusLoaded(): Promise<McpToolBus | undefined> {
  busLoadPromise ??= import(/* @vite-ignore */ `${JSBRIDGE_HOST}/tool-bus.js`)
    .then(() => (window as any).__mcpToolBus as McpToolBus | undefined)
    .catch(() => undefined);
  return busLoadPromise;
}

/**
 * Ergonomic, typed wrapper over window.__mcpToolBus.registerTool - for a
 * normal bundler app that wants to register one ad-hoc tool without
 * touching the raw bus global directly. Lazily loads the bus on first
 * call; a page that never calls this (or registerProvider/connectMcpBridge
 * below) never fetches tool-bus.js at all.
 */
export async function defineTool(
  name: string,
  fn: (args: any) => unknown | Promise<unknown>,
  opts: DefineToolOptions = {}
): Promise<(() => void) | undefined> {
  const bus = await ensureToolBusLoaded();
  return bus?.registerTool(name, fn, opts);
}

/** Typed passthrough to window.__mcpToolBus.registerProvider, after ensuring the bus is loaded. */
export async function registerProvider(providerName: string, tools: unknown[]): Promise<(() => void) | undefined> {
  const bus = await ensureToolBusLoaded();
  return bus?.registerProvider(providerName, tools);
}

export interface ConnectMcpBridgeOptions {
  appName: string;
  defaultChannel?: string;
  onStateChange?: (state: 'disconnected' | 'connecting' | 'connected', channel: string, appLabel: string) => void;
  /** Extra bus/provider setup beyond the automatic tool-bus load, e.g. registering a provider before the first connect. */
  beforeConnect?: () => Promise<void> | void;
}

/**
 * The "ergonomic all-in-one" entrypoint (requirement 4): composes
 * createMcpConnect (connect.js) with an automatic tool-bus load in
 * beforeConnect, replacing the ~15-line boilerplate every consumer repo
 * currently hand-rolls (JSBRIDGE_HOST const, the bus-load-then-merge
 * dance). The sync-stub-then-swap shim a host needs for a
 * top-level-await-unsupported bundler target stays THAT HOST's own
 * concern (it's about their bundler's build target, not this SDK's
 * shape) - see htmlpaint.com's/mindfoo's own mcp-connect wrapper for the
 * pattern; do not miscategorize that shim as something this SDK should
 * absorb.
 */
export function connectMcpBridge(opts: ConnectMcpBridgeOptions) {
  return createMcpConnect({
    appName: opts.appName,
    defaultChannel: opts.defaultChannel,
    onStateChange: opts.onStateChange,
    beforeConnect: async () => {
      await ensureToolBusLoaded();
      await opts.beforeConnect?.();
    },
  });
}
