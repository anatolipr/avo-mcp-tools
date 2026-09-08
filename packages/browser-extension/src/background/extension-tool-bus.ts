// Service-worker-safe TypeScript port of js-bridge-mcp/src/client/tool-bus.js's
// registry (registerProvider/registerTool/getTools/onChange) - same shape,
// singleton-attached via `self` (valid in both DOM and worker contexts)
// instead of `window` (undefined in a service worker). Not a shared import:
// tool-bus.js is a hand-copied static asset served at a public URL for other
// host pages to import (see its own header comment) - this file is purely
// internal to this extension's own background bundle, so it goes through the
// normal build/typecheck pipeline instead of being exempted from it the way
// tool-bus.js deliberately is.

// Type-only import from the main entry (not "./client") - erased entirely at
// build time, so this never pulls mcp-tenant-lib's server-only runtime code
// (ws, etc.) into the extension bundle, only the type declarations.
import type { ToolManifestEntry, ToolParamSpec } from 'mcp-tenant-lib';

export interface ExtensionTool extends ToolManifestEntry {
  source: 'dynamic';
  fn: (args: unknown) => unknown | Promise<unknown>;
}

interface RegisterToolOpts {
  description?: string;
  params?: Record<string, ToolParamSpec>;
  example?: Record<string, unknown>;
  origin?: { kind: 'code'; code: string } | { kind: 'path'; path: string };
}

export interface ExtensionToolBus {
  registerProvider(providerName: string, tools: Omit<ExtensionTool, 'source'>[]): () => void;
  registerTool(name: string, fn: (args: unknown) => unknown | Promise<unknown>, opts?: RegisterToolOpts): () => void;
  getTools(): ExtensionTool[];
  onChange(cb: () => void): () => void;
}

function createExtensionToolBus(): ExtensionToolBus {
  const providers = new Map<string, Omit<ExtensionTool, 'source'>[]>();
  const listeners = new Set<() => void>();

  function notify() {
    for (const cb of listeners) cb();
  }

  function getTools(): ExtensionTool[] {
    const claimedBy = new Map<string, string>();
    const out: ExtensionTool[] = [];
    for (const [providerName, tools] of providers) {
      for (const tool of tools) {
        let name = tool.name;
        if (claimedBy.has(name)) {
          name = `${providerName}__${tool.name}`;
        } else {
          claimedBy.set(name, providerName);
        }
        out.push({ ...tool, name, source: 'dynamic' });
      }
    }
    return out;
  }

  return {
    registerProvider(providerName, tools) {
      providers.set(providerName, tools);
      notify();
      return () => {
        providers.delete(providerName);
        notify();
      };
    },
    registerTool(name, fn, opts = {}) {
      const tool: Omit<ExtensionTool, 'source'> = {
        name,
        description: opts.description ?? '',
        params: opts.params ?? {},
        example: opts.example,
        origin: opts.origin,
        fn,
      };
      return this.registerProvider(`tool:${name}`, [tool]);
    },
    getTools,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

declare const self: { __mcpExtensionToolBus?: ExtensionToolBus } & typeof globalThis;

export function getExtensionToolBus(): ExtensionToolBus {
  self.__mcpExtensionToolBus ??= createExtensionToolBus();
  return self.__mcpExtensionToolBus;
}
