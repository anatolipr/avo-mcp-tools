import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tenant, TenantConnection } from './tenant.js';
import type { ToolManifestEntry, ToolParamSpec } from './types.js';
import { REMOTE_REGISTER_BY_PATH_CALL, REMOTE_REGISTER_BY_CODE_CALL, REMOTE_UNREGISTER_CALL } from './client-bridge.js';

class UnsupportedParamTypeError extends Error {}

function paramSpecToZod(spec: ToolParamSpec): z.ZodTypeAny {
  let schema: z.ZodTypeAny;
  switch (spec.type) {
    case 'string': schema = z.string(); break;
    case 'number': schema = z.number(); break;
    case 'boolean': schema = z.boolean(); break;
    default: throw new UnsupportedParamTypeError(`unsupported param type "${(spec as any).type}" (supported: string, number, boolean)`);
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
 * Same shape describe_tools returns for the caller's own current channel,
 * built from any Tenant — shared with describe_channel (channel-tools.ts)
 * so a channel's manifest can be inspected by name without join_channel
 * retargeting the session onto it first.
 */
export function buildDescribePayload<TSchema, TValues>(t: Tenant<TSchema, TValues>) {
  const conns = [...t.connections.values()];

  if (conns.length <= 1) {
    return {
      summary: t.toolManifestSummary ?? null,
      tools: t.toolManifest.map((e) => ({ name: e.name, description: e.description })),
    };
  }

  const slugFor = computeSlugs(conns);
  return {
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
}

const DESCRIBE_TOOLS_NAME = 'describe_tools';
const IDENTIFY_CONNECTION_NAME = 'identify_connection';
const REGISTER_TOOL_BY_PATH_NAME = 'register_page_tool_by_path';
const REGISTER_TOOL_BY_CODE_NAME = 'register_page_tool_by_code';
const UNREGISTER_TOOL_NAME = 'unregister_page_tool';

const IDENTIFY_CONNECTION_DESCRIPTION =
  'Pops an alert in the browser tab behind one connection, so a human looking at several open tabs/windows ' +
  'can tell which one this session means. Use when the user has multiple tabs bridged in and asks "which one ' +
  'is X" or you need them to look at a specific one. Pass the connection `id` from describe_tools\' ' +
  '`connections` array (single-connection channels can omit it). Fire-and-forget: returns immediately, does ' +
  'not confirm the human saw it.';

const DESCRIBE_TOOLS_DESCRIPTION =
  'Returns manifest-level context for the tools connected to THIS SESSION\'S CURRENT CHANNEL: a ' +
  'page-authored summary (what kind of page/app this is, cross-tool sequencing rules, ' +
  'domain concepts) plus the current list of tool names and one-line descriptions. Call ' +
  'this once after connecting, before calling any other tool from this page, so you have ' +
  'the shared context that individual tool descriptions don\'t repeat. When multiple ' +
  'pages/tabs are connected to this session at once, tool names are prefixed per ' +
  'connection (e.g. "formalin__submit_form", "htmlpaint__clear_canvas") and this tool\'s ' +
  'response includes a `connections` array listing each connection\'s id, label, and ' +
  'prefix — call it whenever you\'re unsure which prefix routes to which tab. ' +
  'IMPORTANT — an empty or unexpected result here does NOT mean no page is bridged: this session may ' +
  'simply be on the wrong channel (see join_channel). If the user expects a specific bridged app/page by ' +
  'name (e.g. "the bulletino tab") and it\'s missing, call list_channels to check for a matching channel ' +
  'and join_channel to it before assuming nothing is connected. If a tool listed here instead fails to ' +
  'invoke with "No such tool available" (typically right after the MCP server process was restarted), ' +
  'your MCP client\'s own connection is stale, not this manifest — tell the user to reconnect the MCP ' +
  'client (e.g. /mcp in Claude Code) rather than retrying the call.';

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
        const payload = buildDescribePayload(tenant());
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }
    );
    handles.set(DESCRIBE_TOOLS_NAME, handle);
  }

  function registerIdentifyConnection() {
    const handle = mcp.registerTool(
      IDENTIFY_CONNECTION_NAME,
      {
        description: IDENTIFY_CONNECTION_DESCRIPTION,
        inputSchema: { id: z.string().optional().describe('Connection id from describe_tools\' `connections` array. Omit when only one connection is live.') },
      },
      async ({ id }: { id?: string }) => {
        const t = tenant();
        const targetId = id ?? [...t.connections.keys()][0];
        if (!targetId) {
          return { content: [{ type: 'text', text: 'No live connection on this channel to identify.' }], isError: true };
        }
        const ok = t.identifyConnection(targetId);
        return {
          content: [{ type: 'text', text: ok ? `Identify signal sent to connection "${targetId}".` : `Connection "${targetId}" is not currently open.` }],
          isError: !ok,
        };
      }
    );
    handles.set(IDENTIFY_CONNECTION_NAME, handle);
  }

  /**
   * These three tools ride on the existing generic Tenant.call/call_result
   * round trip via reserved `name` values (REMOTE_REGISTER_BY_PATH_CALL etc,
   * see client-bridge.ts) rather than a new wire-protocol message type - the
   * page's onCall handler special-cases those names instead of dispatching
   * to a real page tool. Generic at this layer (any tenant-lib consumer
   * gets them, same tradeoff already accepted for identify_connection); a
   * page with no reserved-name handling just gets a clear
   * "no page tool named..."-style error from its own onCall fallback,
   * same as calling identify_connection against a page with no onIdentify
   * handler already does today.
   */
  function registerRegisterToolByPath() {
    const handle = mcp.registerTool(
      REGISTER_TOOL_BY_PATH_NAME,
      {
        description:
          'Registers a NEW tool on an already-connected browser tab, pointing at an existing ' +
          'window.* function (e.g. path "myApp.save" resolves window.myApp.save). Use this to expose ' +
          'something the page already does, without writing new code — prefer ' +
          'register_page_tool_by_code when no existing function does what you need. Waits for the ' +
          'browser to confirm registration succeeded; a bad path (does not resolve, or resolves to ' +
          'something that is not a function) surfaces as a tool error, not a silent no-op. The new ' +
          'tool becomes callable immediately but (per the MCP tools/list_changed caveat noted on ' +
          'describe_tools) some MCP clients may need a session restart to see it.',
        inputSchema: {
          id: z.string().optional().describe('Connection id from describe_tools\' `connections` array. Omit when only one connection is live.'),
          name: z.string().describe('Tool name to register — must be unique on this connection.'),
          description: z.string().describe('One-line description of what this tool does, shown to agents.'),
          path: z.string().describe('Dot path off window to an existing function, e.g. "myApp.save" for window.myApp.save.'),
        },
      },
      async ({ id, name, description, path }: { id?: string; name: string; description: string; path: string }) => {
        const t = tenant();
        const targetId = id ?? [...t.connections.keys()][0];
        if (!targetId) return { content: [{ type: 'text', text: 'No live connection on this channel to register a tool on.' }], isError: true };
        try {
          const result = await t.call(targetId, REMOTE_REGISTER_BY_PATH_CALL, { name, description, path });
          return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: String((err as Error).message) }], isError: true };
        }
      }
    );
    handles.set(REGISTER_TOOL_BY_PATH_NAME, handle);
  }

  function registerRegisterToolByCode() {
    const handle = mcp.registerTool(
      REGISTER_TOOL_BY_CODE_NAME,
      {
        description:
          'Registers a NEW tool on an already-connected browser tab by supplying a fresh JavaScript ' +
          'function body to compile and run in that page — the same trust model as pasting code into ' +
          'that page\'s own DevTools console. Use this when no existing window.* function already does ' +
          'what you need (use register_page_tool_by_path instead when one does). The code runs as ' +
          'the body of `new Function(\'args\', \'document\', \'window\', code)` — return a value (or a ' +
          'Promise) from `code`; it becomes this tool\'s result. Good for exploration too: a ' +
          'discovery/inspection function (e.g. "list every window.* key matching /save/i") can inform ' +
          'what other tools to register next. UNLIKE register_page_tool_by_path, this requires a HUMAN ' +
          'APPROVAL step before it runs — the request appears as a popup on this MCP server\'s dashboard ' +
          '(the same page a human would open to see connected browser tabs; not the bridged page itself), ' +
          'showing the name/description/code with Approve/Decline. TELL THE USER TO OPEN THE DASHBOARD ' +
          '(they can also open it themselves at any time — no js-bridge-mcp-side action needed to trigger ' +
          'it, it is always the localhost port this MCP server is running on) so they see the prompt; this ' +
          'call will not resolve until they answer there (or ~2 minutes pass with no answer, treated as a ' +
          'decline). If declined, the result is an error reading "User declined to register this tool" — ' +
          'treat that as a real no (don\'t retry silently), not a transient failure to work around. A ' +
          'throwing/invalid snippet (once approved) surfaces as a real tool error too, not a silent failure.',
        inputSchema: {
          id: z.string().optional().describe('Connection id from describe_tools\' `connections` array. Omit when only one connection is live.'),
          name: z.string().describe('Tool name to register — must be unique on this connection.'),
          description: z.string().describe('One-line description of what this tool does, shown to agents AND to the human in the dashboard approval popup — write it for both audiences.'),
          code: z.string().describe('JavaScript source for the function body — same signature as new Function("args","document","window", code). Return the result (a value or a Promise). Shown verbatim to the human for approval before it runs.'),
        },
      },
      async ({ id, name, description, code }: { id?: string; name: string; description: string; code: string }) => {
        const t = tenant();
        const targetId = id ?? [...t.connections.keys()][0];
        if (!targetId) return { content: [{ type: 'text', text: 'No live connection on this channel to register a tool on.' }], isError: true };
        try {
          // Approval happens on the DASHBOARD, not the bridged page itself
          // — requestApproval() creates a pending entry the dashboard's SSE
          // stream picks up and renders as a popup; this call blocks until
          // a human answers there (resolveApproval, via a new REST action)
          // or the request times out. Only on approval does the actual
          // Tenant.call reach the bridged page - which then just compiles
          // and registers, no confirmation of its own.
          const approved = await t.requestApproval(name, description, code);
          if (!approved) {
            return { content: [{ type: 'text', text: 'User declined to register this tool' }], isError: true };
          }
          const result = await t.call(targetId, REMOTE_REGISTER_BY_CODE_CALL, { name, description, code });
          return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: String((err as Error).message) }], isError: true };
        }
      }
    );
    handles.set(REGISTER_TOOL_BY_CODE_NAME, handle);
  }

  function registerUnregisterTool() {
    const handle = mcp.registerTool(
      UNREGISTER_TOOL_NAME,
      {
        description:
          'Unregisters a previously DYNAMICALLY-added tool (one created via register_page_tool_by_path ' +
          '/register_page_tool_by_code, or a human\'s window.__mcpToolBus.registerTool paste) from an ' +
          'already-connected browser tab, by name. Host-defined tools (ones the page itself defined in ' +
          'window.__mcpTools) can NEVER be unregistered this way — the browser rejects such a request ' +
          'with a clear error instead of silently ignoring it. Also errors clearly (rather than ' +
          'no-op\'ing) if the named tool is not currently a tracked dynamic registration on that ' +
          'connection (already removed, never existed, or was a host tool).',
        inputSchema: {
          id: z.string().optional().describe('Connection id from describe_tools\' `connections` array. Omit when only one connection is live.'),
          toolName: z.string().describe('Name of the dynamically-registered tool to remove.'),
        },
      },
      async ({ id, toolName }: { id?: string; toolName: string }) => {
        const t = tenant();
        const targetId = id ?? [...t.connections.keys()][0];
        if (!targetId) return { content: [{ type: 'text', text: 'No live connection on this channel to unregister a tool from.' }], isError: true };
        try {
          const result = await t.call(targetId, REMOTE_UNREGISTER_CALL, { toolName });
          return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: String((err as Error).message) }], isError: true };
        }
      }
    );
    handles.set(UNREGISTER_TOOL_NAME, handle);
  }

  function sync() {
    const conns = [...tenant().connections.values()];
    const multi = conns.length >= 2;
    const slugFor = multi ? computeSlugs(conns) : undefined;

    // registeredName -> which connection/entry it dispatches to. With a
    // single (or no) connection, registeredName === entry.name, exactly
    // like before multi-connection support existed.
    const registeredNow = new Map<string, { connectionId: string | undefined; entry: ToolManifestEntry }>();
    const RESERVED_NAMES = new Set([
      DESCRIBE_TOOLS_NAME,
      IDENTIFY_CONNECTION_NAME,
      REGISTER_TOOL_BY_PATH_NAME,
      REGISTER_TOOL_BY_CODE_NAME,
      UNREGISTER_TOOL_NAME,
    ]);

    if (multi) {
      for (const conn of conns) {
        for (const entry of conn.manifest) {
          if (RESERVED_NAMES.has(entry.name)) continue;
          registeredNow.set(`${slugFor!.get(conn.id)}__${entry.name}`, { connectionId: conn.id, entry });
        }
      }
    } else {
      const conn = conns[0];
      for (const entry of tenant().toolManifest) {
        if (RESERVED_NAMES.has(entry.name)) continue;
        registeredNow.set(entry.name, { connectionId: conn?.id, entry });
      }
    }

    // Page tools named "describe_tools"/"identify_connection"/etc would
    // collide with the fixed tools below - the fixed ones always win so
    // agents can rely on the name.
    const currentNames = new Set([...RESERVED_NAMES, ...registeredNow.keys()]);

    for (const [name, handle] of handles) {
      if (!currentNames.has(name)) {
        handle.remove();
        handles.delete(name);
      }
    }

    if (!handles.has(DESCRIBE_TOOLS_NAME)) registerDescribeTools();
    if (!handles.has(IDENTIFY_CONNECTION_NAME)) registerIdentifyConnection();
    if (!handles.has(REGISTER_TOOL_BY_PATH_NAME)) registerRegisterToolByPath();
    if (!handles.has(REGISTER_TOOL_BY_CODE_NAME)) registerRegisterToolByCode();
    if (!handles.has(UNREGISTER_TOOL_NAME)) registerUnregisterTool();

    for (const [registeredName, { connectionId, entry }] of registeredNow) {
      if (handles.has(registeredName)) continue;
      let inputSchema: Record<string, z.ZodTypeAny>;
      try {
        inputSchema = manifestEntryToZodShape(entry);
      } catch (err) {
        // A single page-authored tool with a malformed param spec (bad/missing
        // `type`) must not take down sync() for every other tool on the
        // channel, nor crash whatever triggered this sync (e.g. join_channel
        // migrating the registry) — skip just this one entry.
        if (err instanceof UnsupportedParamTypeError) {
          console.error(`[mcp-tenant-lib] skipping tool "${registeredName}": ${err.message}`);
          continue;
        }
        throw err;
      }
      const handle = mcp.registerTool(
        registeredName,
        { description: entry.description, inputSchema },
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
