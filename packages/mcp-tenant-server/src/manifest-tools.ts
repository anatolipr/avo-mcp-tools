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

const DESCRIBE_TOOLS_NAME = 'describe_tools';

const DESCRIBE_TOOLS_DESCRIPTION =
  'Returns manifest-level context for the tools this connected page registered: a ' +
  'page-authored summary (what kind of page/app this is, cross-tool sequencing rules, ' +
  'domain concepts) plus the current list of tool names and one-line descriptions. Call ' +
  'this once after connecting, before calling any other tool from this page, so you have ' +
  'the shared context that individual tool descriptions don\'t repeat.';

/**
 * Registers one MCP tool per entry in tenant().toolManifest, dispatching
 * calls to the page via tenant().call(target, args). Also always registers
 * a fixed `describe_tools` tool that surfaces tenant().toolManifestSummary -
 * the page-authored manifest-level context from RegisterToolsMessage.summary
 * - plus a compact index of current tool names/descriptions. That summary
 * can't be baked into the McpServer's static `instructions` because the
 * page (and its manifest/summary) only connects and registers *after* the
 * McpServer is already constructed per session (see http.ts) - describe_tools
 * is the one mechanism that can carry page-supplied context to the agent.
 * Call sync() again after the manifest changes (e.g. on a fresh
 * register_tools push) to remove stale tools and register new ones - each
 * mutation trips the SDK's own tools/list_changed notification automatically.
 */
export function createManifestToolRegistry<TSchema, TValues>(
  mcp: McpServer,
  tenant: () => Tenant<TSchema, TValues>
): ManifestToolRegistry {
  const handles = new Map<string, RegisteredTool>();

  function registerDescribeTools() {
    const handle = mcp.registerTool(
      DESCRIBE_TOOLS_NAME,
      { description: DESCRIBE_TOOLS_DESCRIPTION, inputSchema: {} },
      async () => {
        const t = tenant();
        const payload = {
          summary: t.toolManifestSummary ?? null,
          tools: t.toolManifest.map((e) => ({ name: e.name, description: e.description })),
        };
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }
    );
    handles.set(DESCRIBE_TOOLS_NAME, handle);
  }

  function sync() {
    const manifest = tenant().toolManifest;
    // A page tool named "describe_tools" would collide with the fixed tool
    // below - the fixed one always wins so agents can rely on the name.
    const currentNames = new Set([DESCRIBE_TOOLS_NAME, ...manifest.map((e) => e.name)]);

    for (const [name, handle] of handles) {
      if (!currentNames.has(name)) {
        handle.remove();
        handles.delete(name);
      }
    }

    if (!handles.has(DESCRIBE_TOOLS_NAME)) registerDescribeTools();

    for (const entry of manifest) {
      if (entry.name === DESCRIBE_TOOLS_NAME) continue;
      if (handles.has(entry.name)) continue;
      const handle = mcp.registerTool(
        entry.name,
        { description: entry.description, inputSchema: manifestEntryToZodShape(entry) },
        async (args: any) => {
          try {
            const result = await tenant().call(entry.name, args);
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
