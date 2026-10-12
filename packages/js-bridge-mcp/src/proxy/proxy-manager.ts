import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { getOrCreateRootTenant, isValidConnectionName, type Tenant, type ToolManifestEntry, type ToolParamSpec } from 'mcp-tenant-lib';
import type { ProxyConfig, ProxyStatus, ProxyTransport } from './types.js';

/**
 * One running proxy's live handles — never persisted, rebuilt fresh from
 * `ProxyConfig` on start. `connectionId` is re-minted every (re)start rather
 * than reused: Tenant.call's existing reconnect-grace-then-reject logic
 * (tenant.ts) already fails any call still in flight against the old id
 * cleanly, with no extra code needed here — see the plan's restart-semantics
 * note.
 */
interface RunningProxy {
  config: ProxyConfig;
  connectionId: string;
  client: Client;
  /**
   * The root Tenant this proxy's connection was actually registered on.
   * Kept here rather than re-looked-up by slug at stop time: a second proxy
   * sharing a slug lands on a suffixed root tenant ("slug2" — see
   * reserveRootName), so a lookup by config.slug would find the FIRST
   * proxy's tenant and remove nothing.
   */
  tenant?: Tenant<any, any>;
  toolCount: number;
  /**
   * Names of upstream tools that connected but couldn't be registered.
   * Always empty since translateSchemaNode gained its `any` fallback (an
   * inexpressible field no longer drops its whole tool) — kept so
   * ProxyStatus.skippedTools stays present for existing consumers.
   */
  skippedTools: string[];
  /** True only between a successful connect+tools/list and the upstream going away — NOT merely "no lastError", which is also true while still connecting. */
  connected: boolean;
  connectedAt: number;
  lastError?: string;
}

const running = new Map<string, RunningProxy>(); // keyed by ProxyConfig.id

let configPath: string;
/** Reported to upstream servers as this proxy client's own version — set from package.json by initProxyManager. */
let packageVersion = '0.0.0';
let configs: ProxyConfig[] = [];

/**
 * Tolerates a hand-edited or truncated file: anything that isn't an array is
 * ignored wholesale, and an entry missing the fields every other function
 * here reads unconditionally (id/slug/transport) is skipped with a warning
 * instead of crashing startup or a later listProxies(). The file itself is
 * left untouched so the human can still fix it by hand.
 */
function loadConfigs(): ProxyConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err: any) {
    if (err.code !== 'ENOENT') console.error(`[proxy-manager] failed to read ${configPath}: ${err.message}`);
    return [];
  }
  // Tighten a file written by an older build (default umask, typically
  // world-readable) — it holds env/headers secrets. Best-effort.
  try { fs.chmodSync(configPath, 0o600); } catch { /* not ours to chmod, or unsupported filesystem */ }
  if (!Array.isArray(parsed)) {
    console.error(`[proxy-manager] ignoring ${configPath}: expected a JSON array of proxy configs`);
    return [];
  }
  return parsed.filter((entry, index): entry is ProxyConfig => {
    const ok = !!entry && typeof entry === 'object'
      && typeof entry.id === 'string' && typeof entry.slug === 'string' && typeof entry.transport === 'string';
    if (!ok) console.error(`[proxy-manager] ignoring entry #${index} in ${configPath}: missing string "id", "slug", or "transport"`);
    return ok;
  }).map((entry) => ({ ...entry, paused: !!entry.paused }));
}

/**
 * Per-id error for a config entry whose slug fails isValidConnectionName —
 * populated at load time (see initProxyManager) for entries that predate
 * isValidConnectionName being enforced on the write path (addProxy/updateProxy),
 * e.g. hand-edited JSON or a file written by an older build. Without this
 * check, such an entry starts normally and produces a root connection name
 * describe_connection can see but that can never round-trip cleanly through
 * a URL/tool-prefix, leaving it permanently unusable with no indication why.
 * Kept separate from RunningProxy.lastError since an invalid slug is never
 * actually started — listProxies() merges the two so the admin UI shows one
 * error either way.
 */
const invalidSlugErrors = new Map<string, string>(); // keyed by ProxyConfig.id

function slugError(slug: string, configPath: string): string {
  return `"${slug}" is not a valid proxy slug (use only letters, digits, underscore, and hyphen) — ` +
    `fix it in ${configPath} and restart, or delete/re-add the proxy.`;
}

/**
 * Written owner-only (0600) since env/headers routinely hold credentials,
 * and via temp-file + rename so a crash mid-write can't leave a truncated
 * file that loadConfigs would then discard wholesale. The rename targets the
 * file's real path, so a config file that is a symlink (e.g. into a dotfiles
 * repo) keeps being one.
 */
function saveConfigs() {
  try {
    const target = fs.existsSync(configPath) ? fs.realpathSync(configPath) : configPath;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(configs, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (err: any) {
    console.error(`[proxy-manager] failed to write ${configPath}: ${err.message}`);
  }
}

function envMs(name: string, defaultMs: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : defaultMs;
}

/**
 * Default per-call budget for a proxied upstream tool. Tenant.call's own
 * default (10s) suits a page tool that answers from in-memory DOM state; an
 * upstream MCP server doing a DB query or a network round trip regularly
 * needs longer. 60s matches the MCP SDK client's own default request timeout.
 */
const DEFAULT_CALL_TIMEOUT_MS = envMs('PROXY_CALL_TIMEOUT_MS', 60_000);

export function proxyCallTimeoutMs(config: Pick<ProxyConfig, 'callTimeoutMs'>): number {
  const n = config.callTimeoutMs;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : DEFAULT_CALL_TIMEOUT_MS;
}

const VALID_TRANSPORTS: readonly string[] = ['stdio', 'sse', 'streamableHttp'];

function isStringRecord(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((v) => typeof v === 'string');
}

/**
 * Rejects a config that could never start, BEFORE it is persisted — without
 * this, e.g. a stdio proxy with no command was saved, failed on every boot,
 * and had to be removed by hand. Only applied on the write path (addProxy/
 * updateProxy): an already-persisted entry that fails these checks still
 * loads and just surfaces its start error via lastError.
 */
export function validateProxyInput(input: Omit<ProxyConfig, 'id' | 'paused'>): void {
  if (!isValidConnectionName(input.slug)) throw new Error(slugError(input.slug, configPath));
  if (!VALID_TRANSPORTS.includes(input.transport)) {
    throw new Error(`"${input.transport}" is not a valid transport (use "stdio", "sse", or "streamableHttp")`);
  }
  if (input.transport === 'stdio') {
    if (typeof input.command !== 'string' || !input.command.trim()) throw new Error('stdio proxy requires "command"');
  } else {
    let url: URL | undefined;
    try { url = new URL(String(input.url ?? '')); } catch { /* reported below */ }
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      throw new Error(`${input.transport} proxy requires an http(s) "url"`);
    }
  }
  if (input.args != null && !(Array.isArray(input.args) && input.args.every((a) => typeof a === 'string'))) {
    throw new Error('"args" must be an array of strings');
  }
  if (input.env != null && !isStringRecord(input.env)) throw new Error('"env" must be an object of string values');
  if (input.headers != null && !isStringRecord(input.headers)) throw new Error('"headers" must be an object of string values');
  if (input.callTimeoutMs != null && !(typeof input.callTimeoutMs === 'number' && Number.isFinite(input.callTimeoutMs) && input.callTimeoutMs > 0)) {
    throw new Error('"callTimeoutMs" must be a positive number');
  }
}

/**
 * Cap on how much of a failed stdio child's stderr gets folded into
 * lastError — enough for an npm/npx error block (e.g. an E404) to be fully
 * readable in the admin UI, not so much that one runaway/looping process
 * balloons the in-memory ProxyStatus.
 */
const STDERR_CAPTURE_LIMIT = 4000;

/**
 * `stderr: 'pipe'` (rather than the default 'inherit') is what makes this
 * capture possible at all — 'inherit' sends the child's stderr straight to
 * this process's own stderr (all you'd see in server logs, per the
 * "Connection closed" report this was added for) with no way for
 * proxy-manager.ts to read it back and surface it in ProxyStatus.lastError.
 */
function buildTransport(config: ProxyConfig): { transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport; readStderr: () => string | undefined } {
  if (config.transport === 'stdio') {
    if (!config.command) throw new Error('stdio proxy requires "command"');
    const transport = new StdioClientTransport({ command: config.command, args: config.args, env: config.env, stderr: 'pipe' });
    let captured = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      captured = (captured + chunk.toString('utf-8')).slice(-STDERR_CAPTURE_LIMIT);
    });
    return { transport, readStderr: () => (captured.trim() || undefined) };
  }
  if (!config.url) throw new Error(`${config.transport} proxy requires "url"`);
  const url = new URL(config.url);
  const opts = config.headers ? { requestInit: { headers: config.headers } } : undefined;
  const transport = config.transport === 'sse' ? new SSEClientTransport(url, opts) : new StreamableHTTPClientTransport(url, opts);
  return { transport, readStderr: () => undefined };
}

/**
 * Compact rendering of a schema node ToolParamSpec can't express, folded
 * into the `any` param's description so the calling model still sees the
 * shape the upstream tool expects (the validation is lost, the documentation
 * is not). Capped: every tool description is resent on each tools/list.
 */
const SCHEMA_HINT_LIMIT = 300;

function describeWithSchema(prop: any): string | undefined {
  if (!prop || typeof prop !== 'object') return undefined;
  const { description, ...schema } = prop;
  let hint = '';
  try { hint = JSON.stringify(schema); } catch { /* circular — no hint */ }
  if (hint.length > SCHEMA_HINT_LIMIT) hint = `${hint.slice(0, SCHEMA_HINT_LIMIT)}…`;
  const text = typeof description === 'string' ? description : '';
  if (!hint || hint === '{}') return text || undefined;
  return `${text}${text ? ' ' : ''}(JSON Schema: ${hint})`;
}

/**
 * Strips a Zod `.nullable()` field's `null` branch before type-mapping, so a
 * nullable string/number/boolean/array/object still translates to its real
 * type — see ToolParamSpec's own `nullable` flag (mcp-tenant-lib/types.ts)
 * and paramSpecToZod's `.nullable()` call (manifest-tools.ts), which this
 * feeds. Two encodings seen in practice: zod-to-json-schema (v3, draft-7 —
 * what this repo's Zod v3 tools produce) emits `type: ["string", "null"]`;
 * other converters (Zod v4, draft-2020-12) emit `anyOf`/`oneOf:
 * [{type: "string"}, {type: "null"}]`. Returns the node unchanged (not
 * nullable) when neither shape matches.
 */
function stripNullableBranch(prop: any): { rest: any; nullable: boolean } {
  if (Array.isArray(prop?.type) && prop.type.includes('null')) {
    const remaining = prop.type.filter((t: string) => t !== 'null');
    if (remaining.length === 1) return { rest: { ...prop, type: remaining[0] }, nullable: true };
  }
  const branches = prop?.anyOf ?? prop?.oneOf;
  if (Array.isArray(branches) && branches.length === 2) {
    const nullBranch = branches.find((b: any) => b?.type === 'null');
    const otherBranch = branches.find((b: any) => b?.type !== 'null');
    if (nullBranch && otherBranch) {
      return { rest: { ...otherBranch, description: prop.description ?? otherBranch.description }, nullable: true };
    }
  }
  return { rest: prop, nullable: false };
}

/**
 * JSON-Schema -> ToolParamSpec translation, recursing into `array`/`object`
 * (ToolParamSpec nests these — see types.ts) so e.g.
 * @modelcontextprotocol/server-filesystem's `paths: string[]`
 * (read_multiple_files) or `edits: {oldText,newText}[]` (edit_file) keep
 * their real shape. Total: a node ToolParamSpec can't express (oneOf/anyOf/
 * allOf, `$ref`, a tuple-style array, a free-form object, a non-string enum)
 * becomes `any` — accepted unvalidated and documented via describeWithSchema
 * — rather than making its whole tool unregistrable, which used to hide
 * every upstream tool with e.g. one `oneOf` field.
 */
function translateSchemaNode(prop: any): ToolParamSpec {
  const { rest, nullable } = stripNullableBranch(prop);
  const flags = nullable ? { nullable: true } : {};
  const any = (): ToolParamSpec => ({ type: 'any', description: describeWithSchema(rest), ...flags });
  if (!rest || typeof rest !== 'object') return any();
  const description: string | undefined = typeof rest.description === 'string' ? rest.description : undefined;

  if (rest.const !== undefined || Array.isArray(rest.enum)) {
    const values: unknown[] = rest.const !== undefined ? [rest.const] : rest.enum;
    if (values.length > 0 && values.every((v) => typeof v === 'string')) {
      return { type: 'string', enum: values as string[], description, ...flags };
    }
    return any();
  }

  // JSON Schema's "integer" is a distinct valid primitive type from
  // "number" (a whole-number-only number) — ToolParamSpec only has
  // 'number', so both map to it. Missing this dropped every dbhub
  // search_objects-style tool with an integer `limit`/`offset` param.
  const mappedType = rest.type === 'integer' ? 'number' : rest.type;
  if (mappedType === 'string' || mappedType === 'number' || mappedType === 'boolean') {
    return { type: mappedType, description, ...flags };
  }
  if (mappedType === 'array') {
    // Tuple-style `items: [...]` (and draft-2020-12 `prefixItems`) has a
    // per-position type ToolParamSpec's single `items` can't carry.
    if (Array.isArray(rest.items) || rest.prefixItems) return any();
    return { type: 'array', items: translateSchemaNode(rest.items), description, ...flags };
  }
  if (mappedType === 'object') {
    // z.object() strips keys it doesn't declare, so an object that allows
    // extra keys (or declares none at all) would silently lose data if
    // translated as a fixed-shape object — pass it through whole instead.
    const hasProperties = rest.properties && typeof rest.properties === 'object' && Object.keys(rest.properties).length > 0;
    if (!hasProperties || rest.additionalProperties || rest.patternProperties) return any();
    return { type: 'object', properties: translateSchemaProperties(rest).params, description, ...flags };
  }
  return any();
}

/**
 * `unsupported` is always false now (see translateSchemaNode's `any`
 * fallback) — kept in the return shape so translateTools' skip path, and
 * anything else reading it, stays valid.
 */
export function translateSchemaProperties(schema: unknown): { params: Record<string, ToolParamSpec>; unsupported: boolean } {
  const params: Record<string, ToolParamSpec> = {};
  const obj = schema as { type?: string; properties?: Record<string, any>; required?: string[] } | undefined;
  if (!obj || typeof obj !== 'object' || !obj.properties || typeof obj.properties !== 'object') return { params, unsupported: false };
  const required = new Set(Array.isArray(obj.required) ? obj.required : []);
  for (const [key, prop] of Object.entries(obj.properties)) {
    params[key] = { ...translateSchemaNode(prop), optional: !required.has(key) } as ToolParamSpec;
  }
  return { params, unsupported: false };
}

/**
 * Builds this proxy's manifest under each tool's raw upstream name — the
 * universal always-prefix mechanism in manifest-tools.ts (computeSlugs,
 * keyed off the connection's `name`, which startProxy sets to config.slug)
 * applies the `${slug}__` prefix, so pre-baking it here would double-prefix
 * (e.g. "db__db__query").
 */
function translateTools(config: ProxyConfig, upstreamTools: { name: string; description?: string; inputSchema?: unknown }[]): { entries: ToolManifestEntry[]; skipped: string[] } {
  const entries: ToolManifestEntry[] = [];
  const skipped: string[] = [];
  // +1s so the upstream client's own timeout (set to the same budget in
  // startProxy's directCall) fires first: its error names the request and it
  // sends the upstream a cancellation, where Tenant.call's timer does neither.
  const timeoutMs = proxyCallTimeoutMs(config) + 1000;
  for (const tool of upstreamTools) {
    const { params, unsupported } = translateSchemaProperties(tool.inputSchema);
    if (unsupported) {
      console.error(`[proxy-manager] skipping "${config.slug}__${tool.name}": param schema has a field unsupported by ToolParamSpec`);
      skipped.push(tool.name);
      continue;
    }
    entries.push({
      name: tool.name,
      description: tool.description ?? '',
      params,
      source: 'dynamic',
      origin: { kind: 'path', path: `${config.slug}:${tool.name}` },
      timeoutMs,
    });
  }
  return { entries, skipped };
}

/** tools/list is paginated in the MCP spec — a large upstream server returns `nextCursor` and the rest only on a follow-up call. Page count is capped so a server that always returns a cursor can't loop forever. */
async function listAllTools(client: Client): Promise<Awaited<ReturnType<Client['listTools']>>['tools']> {
  const tools: Awaited<ReturnType<Client['listTools']>>['tools'] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const result = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...result.tools);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

/**
 * Auto-reconnect for a proxy whose upstream went away AFTER connecting (a
 * crashed stdio child, a restarted HTTP server). Not applied to a proxy that
 * never connected in the first place — that is a config problem (bad
 * command, missing auth) retrying won't fix, and respawning `npx` in a loop
 * for it would only burn CPU. Attempts reset once a connection has stayed up
 * for STABLE_CONNECTION_MS, so a server that crashes on every start still
 * runs out of attempts instead of flapping forever.
 */
const RECONNECT_ENABLED = !['0', 'false', 'off', 'no'].includes((process.env.JS_BRIDGE_MCP_PROXY_RECONNECT ?? '').toLowerCase());
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 30_000];
const STABLE_CONNECTION_MS = 30_000;
const reconnectState = new Map<string, { attempts: number; timer?: NodeJS.Timeout }>(); // keyed by ProxyConfig.id
let shuttingDown = false;

function cancelReconnect(configId: string) {
  const state = reconnectState.get(configId);
  if (state?.timer) clearTimeout(state.timer);
  reconnectState.delete(configId);
}

function scheduleReconnect(configId: string) {
  if (!RECONNECT_ENABLED || shuttingDown) return;
  const state = reconnectState.get(configId) ?? { attempts: 0 };
  reconnectState.set(configId, state);
  const delay = RECONNECT_DELAYS_MS[state.attempts];
  if (delay === undefined) {
    const entry = running.get(configId);
    if (entry) entry.lastError = `${entry.lastError ?? 'upstream connection closed'}\nGave up after ${state.attempts} reconnect attempts — restart the proxy to retry.`;
    reconnectState.delete(configId);
    return;
  }
  state.attempts++;
  state.timer = setTimeout(async () => {
    state.timer = undefined;
    const config = configs.find((c) => c.id === configId);
    const entry = running.get(configId);
    // Removed, paused, or already brought back (a manual restart) meanwhile.
    if (!config || config.paused || !entry || entry.connected) return;
    console.error(`[proxy-manager] reconnecting proxy "${config.slug}" (attempt ${state.attempts})`);
    const ok = await startProxy(config);
    const current = running.get(configId);
    if (!ok && current && !current.connected) scheduleReconnect(configId);
  }, delay);
  state.timer.unref();
}

function handleUpstreamClosed(entry: RunningProxy, readStderr: () => string | undefined) {
  // running no longer pointing at this entry means stopProxy got here first
  // (pause/remove/restart/edit) — that close is intentional, not a failure.
  if (running.get(entry.config.id) !== entry || !entry.connected) return;
  entry.connected = false;
  entry.toolCount = 0;
  entry.tenant?.removeConnection(entry.connectionId);
  const stderr = readStderr();
  entry.lastError = stderr ? `upstream connection closed\n${stderr}` : 'upstream connection closed';
  console.error(`[proxy-manager] proxy "${entry.config.slug}" lost its upstream: ${entry.lastError}`);
  const state = reconnectState.get(entry.config.id);
  if (state && Date.now() - entry.connectedAt > STABLE_CONNECTION_MS) state.attempts = 0;
  scheduleReconnect(entry.config.id);
}

/** Re-reads the upstream's tool list into this proxy's manifest — run on the upstream's own tools/list_changed notification, so tools it adds or removes mid-session show up without a manual restart. */
async function refreshTools(entry: RunningProxy) {
  if (running.get(entry.config.id) !== entry || !entry.connected) return;
  try {
    const tools = await listAllTools(entry.client);
    if (running.get(entry.config.id) !== entry || !entry.connected) return;
    const { entries: manifest, skipped } = translateTools(entry.config, tools);
    entry.tenant?.updateConnectionManifest(entry.connectionId, manifest, entry.config.description, entry.config.slug);
    entry.toolCount = manifest.length;
    entry.skippedTools = skipped;
  } catch (err: any) {
    console.error(`[proxy-manager] failed to refresh tools for proxy "${entry.config.slug}": ${err?.message ?? String(err)}`);
  }
}

/** Resolves true once the proxy is connected with its tools registered; false (with the reason in lastError) otherwise. Never rejects. */
async function startProxy(config: ProxyConfig): Promise<boolean> {
  // A previous entry still here is a dead one being replaced by a reconnect
  // (every other caller goes through stopProxy first) — drop its client.
  running.get(config.id)?.client.close().catch(() => {});

  const client = new Client({ name: `js-bridge-mcp-proxy-${config.slug}`, version: packageVersion });
  const connectionId = randomUUID();
  const entry: RunningProxy = { config, connectionId, client, toolCount: 0, skippedTools: [], connected: false, connectedAt: 0 };
  running.set(config.id, entry);
  // Superseded = stopProxy (or a newer startProxy) replaced this entry while
  // an await below was pending; whatever this call connected is orphaned.
  const superseded = () => running.get(config.id) !== entry;

  let readStderr: () => string | undefined = () => undefined;
  try {
    // Every proxy is a root connection (no dedicated per-proxy channel) —
    // slug becomes the root connection's name directly, doubling as the
    // tool-name prefix via the universal computeSlugs-based mechanism
    // (manifest-tools.ts). Created before connecting so a proxy that fails
    // to start is still visible via describe_connection, with zero
    // connections.
    const { tenant } = getOrCreateRootTenant(config.slug, undefined, {});
    entry.tenant = tenant;
    // Inside the try (it used to sit above it): buildTransport throws on a
    // config missing its command/url, which otherwise left this entry in
    // `running` with no lastError — reported as connected — and, from
    // initProxyManager's un-awaited call, was an unhandled rejection.
    const built = buildTransport(config);
    readStderr = built.readStderr;
    await client.connect(built.transport);
    if (superseded()) { await client.close().catch(() => {}); return false; }
    const tools = await listAllTools(client);
    if (superseded()) { await client.close().catch(() => {}); return false; }
    const { entries: manifest, skipped } = translateTools(config, tools);
    const timeout = proxyCallTimeoutMs(config);
    tenant.registerDirectConnection(
      connectionId,
      (name, args) => client.callTool({ name, arguments: args as Record<string, unknown> | undefined }, undefined, { timeout }),
      config.slug,
    );
    tenant.updateConnectionManifest(connectionId, manifest, config.description, config.slug);
    entry.toolCount = manifest.length;
    entry.skippedTools = skipped;
    entry.connected = true;
    entry.connectedAt = Date.now();
    client.onclose = () => handleUpstreamClosed(entry, readStderr);
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => refreshTools(entry));
    return true;
  } catch (err: any) {
    // The SDK's own error (e.g. "MCP error -32000: Connection closed") just
    // means the child exited/pipe closed before a session was established —
    // it says nothing about WHY. readStderr() recovers that for a stdio
    // proxy (e.g. an npm/npx 404 for a mistyped package name), which
    // otherwise only ever reaches this server's own stderr (see
    // buildTransport's 'pipe' comment) and never the admin UI at all.
    const stderr = readStderr();
    entry.lastError = stderr ? `${err?.message ?? String(err)}\n${stderr}` : (err?.message ?? String(err));
    console.error(`[proxy-manager] failed to start proxy "${config.slug}": ${entry.lastError}`);
    // A half-started stdio child (spawned, then failed initialize) would
    // otherwise keep running with nothing holding a reference to it.
    client.close().catch(() => {});
    return false;
  }
}

/**
 * Tears down a running proxy's connection + upstream client without
 * touching its persisted config. `tenant.removeConnection` makes its tools
 * vanish from the root connection's manifest immediately (matches the
 * settled pause=disappear requirement) — the root Tenant itself is left in
 * place so describe_connection still sees it (with zero connections) and a
 * later resume/restart can reuse the same name.
 */
async function stopProxy(configId: string): Promise<void> {
  cancelReconnect(configId);
  const entry = running.get(configId);
  if (!entry) return;
  running.delete(configId);
  // entry.tenant, not a lookup by slug — see RunningProxy.tenant.
  entry.tenant?.removeConnection(entry.connectionId);
  try {
    await entry.client.close();
  } catch {
    // already gone
  }
}

/**
 * Closes every upstream client so stdio children exit with this process
 * instead of being orphaned. Bounded: a child that ignores its stdin closing
 * must not keep the server from exiting.
 */
export async function shutdownProxyManager(timeoutMs = 2_000): Promise<void> {
  shuttingDown = true;
  for (const id of [...reconnectState.keys()]) cancelReconnect(id);
  const stopAll = Promise.allSettled([...running.keys()].map((id) => stopProxy(id)));
  await Promise.race([stopAll, new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]);
}

export function initProxyManager(filePath: string, version?: string) {
  configPath = filePath;
  if (version) packageVersion = version;
  shuttingDown = false;
  configs = loadConfigs();
  for (const config of configs) {
    if (!isValidConnectionName(config.slug)) {
      const message = slugError(config.slug, configPath);
      console.error(`[proxy-manager] not starting proxy "${config.id}": ${message}`);
      invalidSlugErrors.set(config.id, message);
      continue;
    }
    if (!config.paused) startProxy(config);
  }
}

/** Full persisted config for one proxy — backs the admin UI's View/Edit panel, unlike listProxies()'s status-only summary. */
export function getProxyConfig(id: string): ProxyConfig | undefined {
  return configs.find((c) => c.id === id);
}

export function listProxies(): ProxyStatus[] {
  return configs.map((config) => {
    const entry = running.get(config.id);
    return {
      id: config.id,
      slug: config.slug,
      transport: config.transport,
      paused: config.paused,
      connected: !!entry?.connected,
      toolCount: entry?.toolCount ?? 0,
      skippedTools: entry?.skippedTools ?? [],
      lastError: entry?.lastError ?? invalidSlugErrors.get(config.id),
    };
  });
}

export async function addProxy(input: Omit<ProxyConfig, 'id' | 'paused'>): Promise<ProxyConfig> {
  validateProxyInput(input);
  const config: ProxyConfig = { ...input, id: randomUUID(), paused: false };
  configs.push(config);
  saveConfigs();
  await startProxy(config);
  return config;
}

/**
 * Replaces a proxy's editable fields (everything but id) and restarts it
 * under the new config — a config edit can change transport/command/url/
 * slug, all of which only take effect on a fresh connect, so there's no
 * meaningful "edit while running" short of a full stop+start anyway. `paused`
 * is deliberately NOT part of `input` — pause/resume already have their own
 * dedicated actions, so an edit (e.g. fixing a typo'd command) preserves
 * whichever paused state the proxy was already in rather than silently
 * resuming a proxy the user deliberately paused.
 *
 * `headers` and `callTimeoutMs` are kept from the existing config when the
 * key is absent from `input` (pass null to clear): neither the admin form
 * nor the admin MCP tools sent them at all before, so treating "absent" as
 * "clear" silently wiped a proxy's auth headers on every unrelated edit.
 */
export async function updateProxy(id: string, input: Omit<ProxyConfig, 'id' | 'paused'>): Promise<ProxyConfig | undefined> {
  const index = configs.findIndex((c) => c.id === id);
  if (index === -1) return undefined;
  const existing = configs[index]!;
  const merged = { ...input };
  if (!('headers' in input) && existing.headers !== undefined) merged.headers = existing.headers;
  if (!('callTimeoutMs' in input) && existing.callTimeoutMs !== undefined) merged.callTimeoutMs = existing.callTimeoutMs;
  validateProxyInput(merged);
  await stopProxy(id);
  const config: ProxyConfig = { ...merged, id, paused: existing.paused };
  configs[index] = config;
  saveConfigs();
  invalidSlugErrors.delete(id);
  if (!config.paused) await startProxy(config);
  return config;
}

export async function removeProxy(id: string): Promise<boolean> {
  const index = configs.findIndex((c) => c.id === id);
  if (index === -1) return false;
  await stopProxy(id);
  configs.splice(index, 1);
  invalidSlugErrors.delete(id);
  saveConfigs();
  return true;
}

export async function pauseProxy(id: string): Promise<boolean> {
  const config = configs.find((c) => c.id === id);
  if (!config) return false;
  config.paused = true;
  saveConfigs();
  await stopProxy(id);
  return true;
}

export async function resumeProxy(id: string): Promise<boolean> {
  const config = configs.find((c) => c.id === id);
  if (!config) return false;
  if (!isValidConnectionName(config.slug)) {
    invalidSlugErrors.set(id, slugError(config.slug, configPath));
    return false;
  }
  config.paused = false;
  saveConfigs();
  await startProxy(config);
  return true;
}

/** Stop then start under a fresh connection id — see RunningProxy's doc comment for why in-flight calls fail cleanly instead of needing explicit handling here. */
export async function restartProxy(id: string): Promise<boolean> {
  const config = configs.find((c) => c.id === id);
  if (!config) return false;
  if (!isValidConnectionName(config.slug)) {
    invalidSlugErrors.set(id, slugError(config.slug, configPath));
    return false;
  }
  await stopProxy(id);
  await startProxy(config);
  return true;
}

export type { ProxyConfig, ProxyStatus, ProxyTransport };
