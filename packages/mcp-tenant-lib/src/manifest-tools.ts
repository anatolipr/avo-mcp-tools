import { z } from 'zod';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tenant, TenantConnection } from './tenant.js';
import { listRootTenants, dashboardEvents } from './tenant.js';
import type { ToolManifestEntry, ToolParamSpec } from './types.js';
import {
  REMOTE_REGISTER_BY_PATH_CALL,
  REMOTE_REGISTER_BY_CODE_CALL,
  REMOTE_UNREGISTER_CALL,
  REMOTE_REQUEST_RECONNECT_CALL,
} from './client-bridge.js';

class UnsupportedParamTypeError extends Error {}

function paramSpecToZod(spec: ToolParamSpec): z.ZodTypeAny {
  let schema: z.ZodTypeAny;
  switch (spec.type) {
    case 'string': schema = z.string(); break;
    case 'number': schema = z.number(); break;
    case 'boolean': schema = z.boolean(); break;
    case 'array': schema = z.array(paramSpecToZod(spec.items)); break;
    case 'object': schema = z.object(paramsToZodShape(spec.properties)); break;
    default: throw new UnsupportedParamTypeError(`unsupported param type "${(spec as any).type}" (supported: string, number, boolean, array, object)`);
  }
  if (spec.description) schema = schema.describe(spec.description);
  return spec.optional ? schema.optional() : schema;
}

function paramsToZodShape(params: Record<string, ToolParamSpec>): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, spec] of Object.entries(params)) {
    shape[key] = paramSpecToZod(spec);
  }
  return shape;
}

function manifestEntryToZodShape(entry: ToolManifestEntry): Record<string, z.ZodTypeAny> {
  return paramsToZodShape(entry.params);
}

/**
 * Zod shape for the `params` argument accepted by register_page_tool_by_path/
 * _by_code — describes the NEW tool's own parameters (a map of param name to
 * {type, description?, optional?}), the same shape as ToolParamSpec/
 * ToolManifestEntry.params. Without this, a registered tool always gets
 * params: {} (empty inputSchema), so MCP clients strip any call-time
 * arguments before they reach the page's JS — see this package's own README
 * / the session report that led to this field ("register one generic
 * wrapper and call it with different payloads" was unusable without it).
 */
/**
 * Mirrors ToolParamSpec (types.ts) so a tool registered here can declare
 * arbitrarily nested params — an array of objects, an object with an array
 * field, ... — instead of forcing the caller to flatten everything to
 * scalars and JSON.stringify the rest into a single string param.
 */
const TOOL_PARAM_SPEC_SCHEMA: z.ZodType<ToolParamSpec> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.enum(['string', 'number', 'boolean']),
      description: z.string().optional(),
      optional: z.boolean().optional(),
    }),
    z.object({
      type: z.literal('array'),
      items: TOOL_PARAM_SPEC_SCHEMA,
      description: z.string().optional(),
      optional: z.boolean().optional(),
    }),
    z.object({
      type: z.literal('object'),
      properties: z.record(z.string(), TOOL_PARAM_SPEC_SCHEMA),
      description: z.string().optional(),
      optional: z.boolean().optional(),
    }),
  ])
);

const REGISTER_TOOL_PARAMS_SHAPE = z
  .record(z.string(), TOOL_PARAM_SPEC_SCHEMA)
  .optional()
  .describe(
    'Parameters the NEW tool itself should accept, e.g. {"action":{"type":"string"},"count":{"type":"number",' +
      '"optional":true}} — read as `args.action`/`args.count` inside `code` (or as the single object argument ' +
      'passed to the function at `path`). `array` nests an `items` spec of this same shape and `object` nests a ' +
      '`properties` map of this same shape (e.g. {"edits":{"type":"array","items":{"type":"object","properties":' +
      '{"field":{"type":"string"},"value":{"type":"string"}}}}}), so a tool can take structured input directly ' +
      'instead of the caller JSON.stringify-ing it into a string param. Omit for a zero-argument tool. Always set ' +
      'this instead of hardcoding values into `code` when the tool should be reusable across calls with different ' +
      'inputs — an omitted/empty params means MCP clients will strip any arguments passed at call time.'
  );

function paramsArgToRecord(params: Record<string, ToolParamSpec> | undefined): Record<string, ToolParamSpec> {
  return params ?? {};
}

export interface ManifestToolRegistry {
  handles: Map<string, RegisteredTool>;
  sync(): void;
  /** Unsubscribes this registry from dashboardEvents (see createManifestToolRegistry). Call once, from the same place the caller already tears the registry down (e.g. mcp.server.onclose). */
  dispose(): void;
}

/**
 * Same shape describe_tools returns for the caller's own current channel,
 * built from any Tenant — shared with describe_channel (channel-tools.ts)
 * so a channel's manifest can be inspected by name without join_channel
 * retargeting the session onto it first.
 */
export function buildDescribePayload<TSchema, TValues>(t: Tenant<TSchema, TValues>) {
  const conns = [...t.connections.values()];
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
        origin: e.origin,
      })),
    })),
  };
}

const DESCRIBE_TOOLS_NAME = 'describe_tools';
const IDENTIFY_CONNECTION_NAME = 'identify_connection';
const REGISTER_TOOL_BY_PATH_NAME = 'register_page_tool_by_path';
const REGISTER_TOOL_BY_CODE_NAME = 'register_page_tool_by_code';
const UNREGISTER_TOOL_NAME = 'unregister_page_tool';
const REQUEST_RECONNECT_NAME = 'request_reconnect';

const IDENTIFY_CONNECTION_DESCRIPTION =
  'Pops an alert in the browser tab behind one connection, so a human looking at several open tabs/windows ' +
  'can tell which one this session means. Use when the user has multiple tabs bridged in and asks "which one ' +
  'is X" or you need them to look at a specific one. Pass the connection `id` from describe_tools\' ' +
  '`connections` array (single-connection channels can omit it). Fire-and-forget: returns immediately, does ' +
  'not confirm the human saw it.';

const DESCRIBE_TOOLS_DESCRIPTION =
  'Returns manifest-level context for every tool visible to THIS SESSION right now — both this ' +
  'session\'s current channel and any root connections (unnamed/directly-addressed ones, e.g. a ' +
  'browser extension or an MCP proxy), which are always merged in: a page-authored summary (what kind ' +
  'of page/app this is, cross-tool sequencing rules, domain concepts) plus the current list of tool ' +
  'names and one-line descriptions. Call this once after connecting, before calling any other tool, so ' +
  'you have the shared context that individual tool descriptions don\'t repeat. Every connection\'s ' +
  'tools are always prefixed by its own name (e.g. "formalin__submit_form", "dbhub_local__query") so ' +
  'a specific connection can be addressed directly by name in a prompt — this tool\'s response includes ' +
  'a `connections` array listing each connection\'s id, label, and prefix — call it whenever you\'re ' +
  'unsure which prefix routes to which connection. ' +
  'A dynamic tool (one previously registered via register_page_tool_by_path/_by_code) includes an ' +
  '`origin` field showing what it actually does — `{kind:"code",code}` with its full JS source, or ' +
  '`{kind:"path",path}` with the window.* function it wraps — so you can inspect what a prior session ' +
  '(yours or another agent\'s) already built before deciding whether to reuse, redefine, or save it as a ' +
  'skill. Absent for host tools and for dynamic tools with no captured origin (e.g. a human\'s own ' +
  'window.__mcpToolBus.registerTool() DevTools paste). ' +
  'IMPORTANT — an empty or unexpected result here does NOT mean no page is bridged: this session may ' +
  'simply be on the wrong channel (see join_channel). If the user expects a specific bridged app/page by ' +
  'name (e.g. "the bulletino tab") and it\'s missing, call list_channels to check for a matching channel ' +
  'and join_channel to it before assuming nothing is connected. If a tool listed here instead fails to ' +
  'invoke with "No such tool available" (typically right after the MCP server process was restarted), ' +
  'your MCP client\'s own connection is stale, not this manifest — tell the user to reconnect the MCP ' +
  'client (e.g. /mcp in Claude Code) rather than retrying the call.';

/**
 * Derives a stable, unique tool-name prefix per connection: sanitized from
 * `name` (the collision-resolved, stable identifier set at registration —
 * see TenantConnection — falling back to "tab" when absent or empty after
 * sanitizing), with a 1-based ordinal appended on collision (first
 * connection to open keeps the bare slug; later ones sharing that slug get
 * "2", "3", ...). Always applied — every connection gets a prefix, whether
 * it's the only one present or one of several, so a tool's fully-qualified
 * name never changes shape as other connections come and go. Recomputed
 * fresh on every call from the given connection list's order — for a single
 * Tenant this is connection-open order (Map preserves insertion order);
 * callers merging in root connections (see sync() below) control that
 * ordering themselves.
 */
function computeSlugs(connections: TenantConnection[]): Map<string, string> {
  const slugFor = new Map<string, string>();
  const countSoFar = new Map<string, number>();
  for (const conn of connections) {
    const base = slugify(conn.name);
    const n = (countSoFar.get(base) ?? 0) + 1;
    countSoFar.set(base, n);
    slugFor.set(conn.id, n === 1 ? base : `${base}${n}`);
  }
  return slugFor;
}

function slugify(name: string | undefined): string {
  const cleaned = (name ?? '')
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
/**
 * The session's own current tenant's connections, plus every OTHER live
 * root connection's (single) connection folded in — the combined view that
 * both sync() and describe_tools present, so root tools are always visible
 * without an explicit join_channel, and describe_tools' response matches
 * what tools/list actually contains. Excludes the session's own tenant from
 * the root fold-in when it's itself a root connection, to avoid listing that
 * one connection twice. Each entry carries the Tenant it actually came from,
 * since dispatch must call back against THAT tenant, not the session's
 * ambient current one (see sync()'s registeredNow below).
 */
function mergedConnections<TSchema, TValues>(
  t: Tenant<TSchema, TValues>
): { conn: TenantConnection; owner: Tenant<any, any> }[] {
  const own = [...t.connections.values()].map((conn) => ({ conn, owner: t as Tenant<any, any> }));
  const root = listRootTenants()
    .filter((rt) => rt.id !== t.id)
    .flatMap((rt) => [...rt.connections.values()].map((conn) => ({ conn, owner: rt })));
  return [...own, ...root];
}

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
        const merged = mergedConnections(tenant());
        const slugFor = computeSlugs(merged.map((m) => m.conn));
        const payload = {
          connections: merged.map(({ conn: c }) => ({
            id: c.id,
            label: c.label ?? null,
            toolPrefix: slugFor.get(c.id),
            summary: c.summary ?? null,
            tools: c.manifest.map((e) => ({
              name: `${slugFor.get(c.id)}__${e.name}`,
              description: e.description,
              origin: e.origin,
            })),
          })),
        };
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
          'window.* function (e.g. path "myApp.save" resolves window.myApp.save). The target function ' +
          'receives one argument: the object built from `params` (or {} if params is omitted). Use this ' +
          'to expose something the page already does, without writing new code — prefer ' +
          'register_page_tool_by_code when no existing function does what you need. Waits for the ' +
          'browser to confirm registration succeeded; a bad path (does not resolve, or resolves to ' +
          'something that is not a function) surfaces as a tool error, not a silent no-op. Some MCP ' +
          'clients require a manual one-time enable of a newly-registered dynamic tool before it can be ' +
          'called (a UI limitation of that client, not this server). The new ' +
          'tool becomes callable immediately but (per the MCP tools/list_changed caveat noted on ' +
          'describe_tools) some MCP clients may need a session restart to see it. Registration is ' +
          'logged as a sticky toast on this MCP server\'s dashboard so a human can review what got ' +
          'registered, but does not block on any approval.',
        inputSchema: {
          id: z.string().optional().describe('Connection id from describe_tools\' `connections` array. Omit when only one connection is live.'),
          name: z.string().describe('Tool name to register — must be unique on this connection.'),
          description: z.string().describe('One-line description of what this tool does, shown to agents.'),
          path: z.string().describe('Dot path off window to an existing function, e.g. "myApp.save" for window.myApp.save.'),
          params: REGISTER_TOOL_PARAMS_SHAPE,
        },
      },
      async ({ id, name, description, path, params }: { id?: string; name: string; description: string; path: string; params?: Record<string, ToolParamSpec> }) => {
        const t = tenant();
        const targetId = id ?? [...t.connections.keys()][0];
        if (!targetId) return { content: [{ type: 'text', text: 'No live connection on this channel to register a tool on.' }], isError: true };
        try {
          const result = await t.call(targetId, REMOTE_REGISTER_BY_PATH_CALL, { name, description, path, params: paramsArgToRecord(params) });
          t.logToolRegistration(name, description);
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
          'the body of `new Function(\'args\', \'document\', \'window\', code)` — `args` is the object ' +
          'built from `params` (or {} if params is omitted); return a value (or a ' +
          'Promise) from `code`; it becomes this tool\'s result. Set `params` (rather than hardcoding ' +
          'values into `code`) whenever the tool should be reusable across calls with different inputs. ' +
          'Good for exploration too: a ' +
          'discovery/inspection function (e.g. "list every window.* key matching /save/i") can inform ' +
          'what other tools to register next. Registers immediately, no approval step — the ' +
          'name/description/code are logged as a sticky toast on this MCP server\'s dashboard so a human ' +
          'can review what got registered after the fact. A throwing/invalid snippet surfaces as a real ' +
          'tool error, not a silent failure.',
        inputSchema: {
          id: z.string().optional().describe('Connection id from describe_tools\' `connections` array. Omit when only one connection is live.'),
          name: z.string().describe('Tool name to register — must be unique on this connection.'),
          description: z.string().describe('One-line description of what this tool does, shown to agents.'),
          code: z.string().describe('JavaScript source for the function body — same signature as new Function("args","document","window", code). Return the result (a value or a Promise).'),
          params: REGISTER_TOOL_PARAMS_SHAPE,
        },
      },
      async ({ id, name, description, code, params }: { id?: string; name: string; description: string; code: string; params?: Record<string, ToolParamSpec> }) => {
        const t = tenant();
        const targetId = id ?? [...t.connections.keys()][0];
        if (!targetId) return { content: [{ type: 'text', text: 'No live connection on this channel to register a tool on.' }], isError: true };
        try {
          // Registers immediately against the bridged page, no human gate —
          // logToolRegistration below is purely informational: it surfaces
          // a sticky toast on the dashboard's SSE stream so a human can see
          // what was registered after the fact, same as a build log.
          const result = await t.call(targetId, REMOTE_REGISTER_BY_CODE_CALL, { name, description, code, params: paramsArgToRecord(params) });
          t.logToolRegistration(name, description, code);
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

  /**
   * Same reserved-call-name mechanism as the three tools above
   * (REMOTE_REQUEST_RECONNECT_CALL, see client-bridge.ts), generic at this
   * layer for the same reason those three are: what "reconnect" means, and
   * whether targetOrigin/targetTabId do anything at all, is entirely up to
   * whichever connection receives the call. A page's own bridge (e.g.
   * js-bridge-mcp's main.ts) has no way to act on this — its socket dying
   * IS the situation this tool exists for — so it just acks; a browser
   * extension connection is the intended real target, using targetOrigin/
   * targetTabId to find and reconnect the right tab.
   */
  function registerRequestReconnect() {
    const handle = mcp.registerTool(
      REQUEST_RECONNECT_NAME,
      {
        description:
          'Asks an already-connected client (e.g. a browser extension\'s own connection) to (re)connect a page, ' +
          'without the user needing to manually paste a connect snippet. Most useful against a browser-extension ' +
          'connection: pass targetOrigin (and optionally targetTabId) to have it find and reconnect the right tab, ' +
          'using whatever channel that origin was last connected to. Against a plain page connection this is ' +
          'mostly a no-op ack — a page\'s own socket dying (e.g. on navigation) is exactly the situation this tool ' +
          'exists to work around, and a page with no extension present has no way to act on this call at all.',
        inputSchema: {
          id: z.string().optional().describe('Connection id from describe_tools\' `connections` array. Omit when only one connection is live.'),
          targetOrigin: z.string().optional().describe('Origin (e.g. "https://example.com") to reconnect — meaningful to a browser-extension connection with a known prior channel for that origin.'),
          targetTabId: z.number().optional().describe('Specific browser tab id to reconnect, if known — otherwise the receiving connection resolves a tab itself (e.g. from targetOrigin).'),
        },
      },
      async ({ id, targetOrigin, targetTabId }: { id?: string; targetOrigin?: string; targetTabId?: number }) => {
        const t = tenant();
        const targetId = id ?? [...t.connections.keys()][0];
        if (!targetId) return { content: [{ type: 'text', text: 'No live connection on this channel to request a reconnect from.' }], isError: true };
        try {
          const result = await t.call(targetId, REMOTE_REQUEST_RECONNECT_CALL, { targetOrigin, targetTabId });
          return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: String((err as Error).message) }], isError: true };
        }
      }
    );
    handles.set(REQUEST_RECONNECT_NAME, handle);
  }

  function sync() {
    const merged = mergedConnections(tenant());
    const slugFor = computeSlugs(merged.map((m) => m.conn));

    // registeredName -> which connection/entry it dispatches to, and which
    // Tenant owns that connection (its own current tenant for a channel
    // connection, or the specific root Tenant it was folded in from — see
    // mergedConnections). Always prefixed, for any connection count: a
    // tool's fully-qualified name never changes shape as other connections
    // come and go, which is what lets "use dbhub-local" resolve directly to
    // a name already visible in tools/list with zero join_channel/
    // describe_channel round-trip.
    const registeredNow = new Map<string, { owner: Tenant<any, any>; connectionId: string; entry: ToolManifestEntry }>();
    const RESERVED_NAMES = new Set([
      DESCRIBE_TOOLS_NAME,
      IDENTIFY_CONNECTION_NAME,
      REGISTER_TOOL_BY_PATH_NAME,
      REGISTER_TOOL_BY_CODE_NAME,
      UNREGISTER_TOOL_NAME,
      REQUEST_RECONNECT_NAME,
    ]);

    for (const { conn, owner } of merged) {
      for (const entry of conn.manifest) {
        if (RESERVED_NAMES.has(entry.name)) continue;
        registeredNow.set(`${slugFor.get(conn.id)}__${entry.name}`, { owner, connectionId: conn.id, entry });
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
    if (!handles.has(REQUEST_RECONNECT_NAME)) registerRequestReconnect();

    for (const [registeredName, { owner, connectionId, entry }] of registeredNow) {
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
            // Dispatches against the connection's OWNING tenant, not the
            // session's ambient tenant() — for a merged-in root tool, owner
            // is a different Tenant instance than tenant() resolves to.
            const result = await owner.call(connectionId, entry.name, args);
            return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
          } catch (err) {
            return { content: [{ type: 'text', text: String((err as Error).message) }], isError: true };
          }
        }
      );
      handles.set(registeredName, handle);
    }
  }

  // Root tools are merged into every session's tools/list (see
  // mergedConnections) independently of which tenant this registry's own
  // Tenant.syncManifestToolRegistries() call happens to be wired to — a NEW
  // root connection appearing, or an existing one's manifest changing, must
  // refresh every live session, not just ones currently pinned to that root
  // Tenant. dashboardEvents already fires on exactly the shape-changes that
  // matter here (connection open/close, manifest change — see tenant.ts's
  // notifyDashboard), so every registry subscribes to it directly rather
  // than needing a second, root-specific event bus. This means a registry
  // re-syncs on any dashboard-relevant event server-wide, not just ones
  // touching root — accepted: the event rate is low (human-driven actions)
  // and sync() itself is a cheap in-memory diff.
  const onDashboardChange = () => sync();
  dashboardEvents.on('change', onDashboardChange);

  return {
    handles,
    sync,
    dispose: () => dashboardEvents.off('change', onDashboardChange),
  };
}
