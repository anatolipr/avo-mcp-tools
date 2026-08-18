import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tenant, TenantConnection } from './tenant.js';
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
  'the shared context that individual tool descriptions don\'t repeat. When multiple ' +
  'pages/tabs are connected to this session at once, tool names are prefixed per ' +
  'connection (e.g. "formalin__submit_form", "htmlpaint__clear_canvas") and this tool\'s ' +
  'response includes a `connections` array listing each connection\'s id, label, and ' +
  'prefix — call it whenever you\'re unsure which prefix routes to which tab.';

/**
 * Derives a stable, unique tool-name prefix per connection: sanitized from
 * `label` (falling back to "tab" when absent or empty after sanitizing),
 * with a 1-based ordinal appended on collision (first connection to open
 * keeps the bare slug; later ones sharing that slug get "2", "3", ...).
 * Recomputed fresh on every call from `connections`' current iteration
 * order (== connection-open order, since Map preserves insertion order and
 * entries are only ever added/removed, never reordered) — no state to
 * keep in sync separately.
 */
function computeSlugs(connections: TenantConnection[]): Map<string, string> {
  const slugFor = new Map<string, string>();
  const countSoFar = new Map<string, number>();
  for (const conn of connections) {
    const base = slugify(conn.label);
    const n = (countSoFar.get(base) ?? 0) + 1;
    countSoFar.set(base, n);
    slugFor.set(conn.id, n === 1 ? base : `${base}${n}`);
  }
  return slugFor;
}

function slugify(label: string | undefined): string {
  const cleaned = (label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  return cleaned || 'tab';
}

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
        const conns = [...t.connections.values()];

        if (conns.length <= 1) {
          const payload = {
            summary: t.toolManifestSummary ?? null,
            tools: t.toolManifest.map((e) => ({ name: e.name, description: e.description })),
          };
          return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
        }

        const slugFor = computeSlugs(conns);
        const payload = {
          connections: conns.map((c) => ({
            id: c.id,
            label: c.label ?? null,
            toolPrefix: slugFor.get(c.id),
            summary: c.summary ?? null,
            tools: c.manifest.map((e) => ({
              name: `${slugFor.get(c.id)}__${e.name}`,
              description: e.description,
            })),
          })),
        };
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }
    );
    handles.set(DESCRIBE_TOOLS_NAME, handle);
  }

  function sync() {
    const conns = [...tenant().connections.values()];
    const multi = conns.length >= 2;
    const slugFor = multi ? computeSlugs(conns) : undefined;

    // registeredName -> which connection/entry it dispatches to. With a
    // single (or no) connection, registeredName === entry.name, exactly
    // like before multi-connection support existed.
    const registeredNow = new Map<string, { connectionId: string | undefined; entry: ToolManifestEntry }>();
    if (multi) {
      for (const conn of conns) {
        for (const entry of conn.manifest) {
          if (entry.name === DESCRIBE_TOOLS_NAME) continue;
          registeredNow.set(`${slugFor!.get(conn.id)}__${entry.name}`, { connectionId: conn.id, entry });
        }
      }
    } else {
      const conn = conns[0];
      for (const entry of tenant().toolManifest) {
        if (entry.name === DESCRIBE_TOOLS_NAME) continue;
        registeredNow.set(entry.name, { connectionId: conn?.id, entry });
      }
    }

    // A page tool named "describe_tools" would collide with the fixed tool
    // below - the fixed one always wins so agents can rely on the name.
    const currentNames = new Set([DESCRIBE_TOOLS_NAME, ...registeredNow.keys()]);

    for (const [name, handle] of handles) {
      if (!currentNames.has(name)) {
        handle.remove();
        handles.delete(name);
      }
    }

    if (!handles.has(DESCRIBE_TOOLS_NAME)) registerDescribeTools();

    for (const [registeredName, { connectionId, entry }] of registeredNow) {
      if (handles.has(registeredName)) continue;
      const handle = mcp.registerTool(
        registeredName,
        { description: entry.description, inputSchema: manifestEntryToZodShape(entry) },
        async (args: any) => {
          try {
            const result = await tenant().call(connectionId, entry.name, args);
            return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
          } catch (err) {
            return { content: [{ type: 'text', text: String((err as Error).message) }], isError: true };
          }
        }
      );
      handles.set(registeredName, handle);
    }
  }

  return { handles, sync };
}
