import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getOrCreateTenant, isValidChannelName, type ToolManifestEntry, type ToolParamSpec } from 'mcp-tenant-lib';
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
  toolCount: number;
  /**
   * Names of upstream tools connect succeeded but couldn't be registered
   * (unsupported param schema — see translateTools). Distinct from
   * lastError: a proxy can be fully "connected" with toolCount > 0 and
   * still have some tools silently missing, which previously only ever
   * showed up as a console.error a human watching server stderr might miss
   * — surfaced here so "0 tools, no error" (or "fewer tools than expected")
   * has a visible explanation in ProxyStatus instead.
   */
  skippedTools: string[];
  lastError?: string;
}

const running = new Map<string, RunningProxy>(); // keyed by ProxyConfig.id

let configPath: string;
let configs: ProxyConfig[] = [];

function loadConfigs(): ProxyConfig[] {
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw);
  } catch (err: any) {
    if (err.code !== 'ENOENT') console.error(`[proxy-manager] failed to read ${configPath}: ${err.message}`);
    return [];
  }
}

/**
 * Per-id error for a config entry whose slug fails isValidChannelName —
 * populated at load time (see initProxyManager) for entries that predate
 * isValidChannelName being enforced on the write path (addProxy/updateProxy),
 * e.g. hand-edited JSON or a file written by an older build. Without this
 * check, such an entry starts normally and produces a channel that
 * list_channels/describe_channel can see but join_channel can never accept
 * (the tenant id IS the raw slug), leaving it permanently unusable with no
 * indication why. Kept separate from RunningProxy.lastError since an invalid
 * slug is never actually started — listProxies() merges the two so the admin
 * UI shows one error either way.
 */
const invalidSlugErrors = new Map<string, string>(); // keyed by ProxyConfig.id

function slugError(slug: string, configPath: string): string {
  return `"${slug}" is not a valid channel slug (use only letters, digits, underscore, and hyphen) — ` +
    `fix it in ${configPath} and restart, or delete/re-add the proxy.`;
}

function saveConfigs() {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(configs, null, 2));
  } catch (err: any) {
    console.error(`[proxy-manager] failed to write ${configPath}: ${err.message}`);
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
 * Best-effort JSON-Schema -> ToolParamSpec translation, recursing into
 * `array`/`object` (ToolParamSpec nests these — see types.ts) so e.g.
 * @modelcontextprotocol/server-filesystem's `paths: string[]` (read_multiple_files)
 * or `edits: {oldText,newText}[]` (edit_file) translate instead of being
 * dropped. Anything ToolParamSpec still can't express (enum, oneOf/anyOf/
 * allOf, tuple-style array `items`, an object with no `properties`, ...)
 * makes the WHOLE tool ineligible rather than being silently omitted or
 * mistranslated — manifest-tools.ts's own sync() already skips a tool
 * entirely if ANY of its params end up unsupported, so a partial params
 * object here would just register that same tool with a subtly wrong
 * signature instead.
 */
function translateSchemaNode(prop: any): ToolParamSpec | undefined {
  // JSON Schema's "integer" is a distinct valid primitive type from
  // "number" (a whole-number-only number) — ToolParamSpec only has
  // 'number', so both map to it. Missing this dropped every dbhub
  // search_objects-style tool with an integer `limit`/`offset` param.
  const mappedType = prop?.type === 'integer' ? 'number' : prop?.type;
  if (mappedType === 'string' || mappedType === 'number' || mappedType === 'boolean') {
    return { type: mappedType, description: prop.description };
  }
  if (mappedType === 'array') {
    const items = translateSchemaNode(prop.items);
    if (!items) return undefined;
    return { type: 'array', items, description: prop.description };
  }
  if (mappedType === 'object') {
    const { params, unsupported } = translateSchemaProperties(prop);
    if (unsupported) return undefined;
    return { type: 'object', properties: params, description: prop.description };
  }
  return undefined;
}

function translateSchemaProperties(schema: unknown): { params: Record<string, ToolParamSpec>; unsupported: boolean } {
  const params: Record<string, ToolParamSpec> = {};
  const obj = schema as { type?: string; properties?: Record<string, any>; required?: string[] } | undefined;
  if (!obj || obj.type !== 'object' || !obj.properties) return { params, unsupported: Object.keys(obj?.properties ?? {}).length > 0 };
  const required = new Set(obj.required ?? []);
  for (const [key, prop] of Object.entries(obj.properties)) {
    const node = translateSchemaNode(prop);
    if (!node) return { params: {}, unsupported: true };
    params[key] = { ...node, optional: !required.has(key) } as ToolParamSpec;
  }
  return { params, unsupported: false };
}

/**
 * Builds this proxy's manifest with every tool name pre-baked as
 * `${slug}__${upstreamName}` — satisfies the "always prefixed, unconditionally"
 * requirement without any mcp-tenant-lib change: a proxy's dedicated
 * single-connection channel never hits computeSlugs' collision-only
 * prefixing (manifest-tools.ts), so the name has to already be correct going
 * in. A tool whose schema doesn't fit what ToolParamSpec can express (see
 * translateSchemaNode) is skipped with a warning rather than registered
 * with a wrong/empty schema.
 */
function translateTools(slug: string, upstreamTools: { name: string; description?: string; inputSchema?: unknown }[]): { entries: ToolManifestEntry[]; skipped: string[] } {
  const entries: ToolManifestEntry[] = [];
  const skipped: string[] = [];
  for (const tool of upstreamTools) {
    const { params, unsupported } = translateSchemaProperties(tool.inputSchema);
    if (unsupported) {
      console.error(`[proxy-manager] skipping "${slug}__${tool.name}": param schema has a field unsupported by ToolParamSpec (e.g. enum, oneOf/anyOf/allOf, or a tuple-style array)`);
      skipped.push(tool.name);
      continue;
    }
    entries.push({
      name: `${slug}__${tool.name}`,
      description: tool.description ?? '',
      params,
      source: 'dynamic',
      origin: { kind: 'path', path: `${slug}:${tool.name}` },
    });
  }
  return { entries, skipped };
}

async function startProxy(config: ProxyConfig): Promise<void> {
  const tenant = getOrCreateTenant(config.slug, undefined, {});
  const client = new Client({ name: `js-bridge-mcp-proxy-${config.slug}`, version: '0.1.0' });
  const connectionId = randomUUID();
  const entry: RunningProxy = { config, connectionId, client, toolCount: 0, skippedTools: [] };
  running.set(config.id, entry);

  const { transport, readStderr } = buildTransport(config);
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const { entries: manifest, skipped } = translateTools(config.slug, tools);
    tenant.registerDirectConnection(connectionId, (name, args) =>
      client.callTool({ name: name.slice(config.slug.length + 2), arguments: args as Record<string, unknown> | undefined }),
    );
    tenant.updateConnectionManifest(connectionId, manifest, config.description, config.slug);
    entry.toolCount = manifest.length;
    entry.skippedTools = skipped;
  } catch (err: any) {
    // The SDK's own error (e.g. "MCP error -32000: Connection closed") just
    // means the child exited/pipe closed before a session was established —
    // it says nothing about WHY. readStderr() recovers that for a stdio
    // proxy (e.g. an npm/npx 404 for a mistyped package name), which
    // previously only ever reached this server's own stderr (see
    // buildTransport's 'pipe' comment) and never the admin UI at all.
    const stderr = readStderr();
    entry.lastError = stderr ? `${err?.message ?? String(err)}\n${stderr}` : (err?.message ?? String(err));
    console.error(`[proxy-manager] failed to start proxy "${config.slug}": ${entry.lastError}`);
    // Channel still exists (visible via list_channels) with zero connections
    // — e.g. the upstream server needs an auth flow the admin UI has to
    // surface separately (see plan). Not a hard failure of proxy-manager.
  }
}

/**
 * Tears down a running proxy's connection + upstream client without
 * touching its persisted config. `tenant.removeConnection` makes its tools
 * vanish from the channel's manifest immediately (matches the settled
 * pause=disappear requirement) — the channel/Tenant itself is left in place
 * so list_channels/describe_channel still see it (with zero connections)
 * and a later resume/restart can reuse the same channel.
 */
async function stopProxy(configId: string): Promise<void> {
  const entry = running.get(configId);
  if (!entry) return;
  running.delete(configId);
  getOrCreateTenant(entry.config.slug, undefined, {}).removeConnection(entry.connectionId);
  try {
    await entry.client.close();
  } catch {
    // already gone
  }
}

export function initProxyManager(filePath: string) {
  configPath = filePath;
  configs = loadConfigs();
  for (const config of configs) {
    if (!isValidChannelName(config.slug)) {
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
      connected: !!entry && !entry.lastError,
      toolCount: entry?.toolCount ?? 0,
      skippedTools: entry?.skippedTools ?? [],
      lastError: entry?.lastError ?? invalidSlugErrors.get(config.id),
    };
  });
}

export async function addProxy(input: Omit<ProxyConfig, 'id' | 'paused'>): Promise<ProxyConfig> {
  if (!isValidChannelName(input.slug)) {
    throw new Error(slugError(input.slug, configPath));
  }
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
 */
export async function updateProxy(id: string, input: Omit<ProxyConfig, 'id' | 'paused'>): Promise<ProxyConfig | undefined> {
  const index = configs.findIndex((c) => c.id === id);
  if (index === -1) return undefined;
  if (!isValidChannelName(input.slug)) {
    throw new Error(slugError(input.slug, configPath));
  }
  const paused = configs[index]!.paused;
  await stopProxy(id);
  const config: ProxyConfig = { ...input, id, paused };
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
  if (!isValidChannelName(config.slug)) {
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
  if (!isValidChannelName(config.slug)) {
    invalidSlugErrors.set(id, slugError(config.slug, configPath));
    return false;
  }
  await stopProxy(id);
  await startProxy(config);
  return true;
}

export type { ProxyConfig, ProxyStatus, ProxyTransport };
