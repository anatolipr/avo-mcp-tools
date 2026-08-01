import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tenant } from './tenant.js';
import type { ToolManifestEntry, ToolParamSpec } from './types.js';

function paramSpecToZod(spec: ToolParamSpec): z.ZodTypeAny {
  let schema: z.ZodTypeAny;
  switch (spec.type) {
    case 'string': schema = z.string(); break;
    case 'number': schema = z.number(); break;
    case 'boolean': schema = z.boolean(); break;
    default: throw new Error(`unsupported param type "${(spec as any).type}" (supported: string, number, boolean)`);
  }
  if (spec.description) schema = schema.describe(spec.description);
  return spec.optional ? schema.optional() : schema;
}

function manifestEntryToZodShape(entry: ToolManifestEntry): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, spec] of Object.entries(entry.params)) {
    shape[key] = paramSpecToZod(spec);
  }
  return shape;
}

export interface ManifestToolRegistry {
  handles: Map<string, RegisteredTool>;
  sync(): void;
}

/**
 * Registers one MCP tool per entry in tenant().toolManifest, dispatching
 * calls to the page via tenant().call(target, args). Call sync() again
 * after the manifest changes (e.g. on a fresh register_tools push) to
 * remove stale tools and register new ones — each mutation trips the
 * SDK's own tools/list_changed notification automatically.
 */
export function createManifestToolRegistry<TSchema, TValues>(
  mcp: McpServer,
  tenant: () => Tenant<TSchema, TValues>
): ManifestToolRegistry {
  const handles = new Map<string, RegisteredTool>();

  function sync() {
    const manifest = tenant().toolManifest;
    const currentNames = new Set(manifest.map((e) => e.name));

    for (const [name, handle] of handles) {
      if (!currentNames.has(name)) {
        handle.remove();
        handles.delete(name);
      }
    }

    for (const entry of manifest) {
      if (handles.has(entry.name)) continue;
      const handle = mcp.registerTool(
        entry.name,
        { description: entry.description, inputSchema: manifestEntryToZodShape(entry) },
        async (args: any) => {
          try {
            const result = await tenant().call(entry.target, args);
            return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
          } catch (err) {
            return { content: [{ type: 'text', text: String((err as Error).message) }], isError: true };
          }
        }
      );
      handles.set(entry.name, handle);
    }
  }

  return { handles, sync };
}
