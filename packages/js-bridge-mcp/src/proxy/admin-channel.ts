import { randomUUID } from 'node:crypto';
import { buildToolCallReport, currentToolSpec, getOrCreateRootTenant, getToolCallLog, type CallContext, type ToolManifestEntry, type ToolParamSpec } from 'mcp-tenant-lib';
import { addProxy, getProxyConfig, listProxies, pauseProxy, removeProxy, restartProxy, resumeProxy, updateProxy } from './proxy-manager.js';
import type { ProxyConfig, ProxyTransport } from './types.js';

const ADMIN_ROOT_NAME = 'admin';

/**
 * Args/env are plain strings here (not arrays/objects) so this tool's
 * contract exactly matches admin/index.html's window.__mcpTools, which a
 * human/LLM already knows how to use via Human MCP Relay — same quoting
 * rules apply (only quote an arg containing whitespace; KEY=VALUE, one per
 * line, for env).
 */
export function parseArgs(text: string): string[] {
  const args: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    args.push((match[1] ?? match[2] ?? match[3])!);
  }
  return args;
}

export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return env;
}

/** HTTP headers as "Name: Value", one per line — split on the first colon only, since a value (a URL, a "Bearer a:b" token) may contain more. */
export function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim();
    if (name) headers[name] = line.slice(colon + 1).trim();
  }
  return headers;
}

function resolveIdBySlug(slug: string): string {
  const match = listProxies().find((p) => p.slug === slug);
  if (!match) throw new Error(`no proxy with slug "${slug}" — call list_mcp_proxies to see what's configured`);
  return match.id;
}

/**
 * `headers`/`callTimeoutMs` are only present in the result when the caller
 * actually passed them: updateProxy keeps a proxy's existing value for a key
 * that is absent, so an edit that doesn't mention them leaves them alone. An
 * empty `headers` string or a `timeoutSeconds` of 0 clears the stored value.
 */
function configFromArgs(args: {
  transport: ProxyTransport;
  command?: string;
  args?: string;
  env?: string;
  url?: string;
  headers?: string;
  timeoutSeconds?: number;
  description?: string;
  oauth?: boolean;
  lazy?: boolean;
}): Omit<ProxyConfig, 'id' | 'paused' | 'slug'> {
  const config: Omit<ProxyConfig, 'id' | 'paused' | 'slug'> = {
    transport: args.transport,
    description: args.description || undefined,
    command: args.command,
    args: args.args ? parseArgs(args.args) : undefined,
    env: args.env ? parseEnv(args.env) : undefined,
    url: args.url,
  };
  if (typeof args.headers === 'string') config.headers = args.headers.trim() ? parseHeaders(args.headers) : undefined;
  if (typeof args.timeoutSeconds === 'number') config.callTimeoutMs = args.timeoutSeconds > 0 ? args.timeoutSeconds * 1000 : undefined;
  // Same keep-when-absent rule: only a caller that names these changes them.
  if (typeof args.oauth === 'boolean') config.oauth = args.oauth;
  if (typeof args.lazy === 'boolean') config.lazy = args.lazy;
  return config;
}

const stdioArgsParam: ToolParamSpec = { type: 'string', description: 'Space-separated command-line args (stdio only), e.g. -y some-mcp-server --dsn "mysql://user:pass@host/db". Only quote an arg if it itself contains a space — quotes are stripped, not passed through to the process.', optional: true };
const envParam: ToolParamSpec = { type: 'string', description: 'Environment variables to set on the spawned process (stdio only), as KEY=VALUE — one per line for multiple, e.g. "DSN=mysql://root:@127.0.0.1:3306/iram\\nLOG_LEVEL=debug".', optional: true };
const commandParam: ToolParamSpec = { type: 'string', description: 'Executable to spawn (stdio only), e.g. "npx".', optional: true };
const urlParam: ToolParamSpec = { type: 'string', description: 'Upstream server URL (sse/streamableHttp only).', optional: true };
const headersParam: ToolParamSpec = { type: 'string', description: 'HTTP headers sent to the upstream (sse/streamableHttp only), as "Name: Value" — one per line, e.g. "Authorization: Bearer abc".', optional: true };
const timeoutParam: ToolParamSpec = { type: 'number', description: 'Per-call timeout for this proxy\'s tools, in seconds (default 60).', optional: true };
const oauthParam: ToolParamSpec = { type: 'boolean', description: 'Authorize with OAuth (sse/streamableHttp only). The proxy then reports an authUrl a human must open once.', optional: true };
const lazyParam: ToolParamSpec = { type: 'boolean', description: 'Expose only list_tools and call_tool instead of one tool per upstream tool — use for a large server.', optional: true };
const descriptionParam: ToolParamSpec = { type: 'string', description: 'Optional human-readable note about this proxy.', optional: true };
const slugParam: ToolParamSpec = { type: 'string', description: 'The proxy\'s slug.' };
const transportParam: ToolParamSpec = { type: 'string', description: '"stdio", "sse", or "streamableHttp".' };

const manifest: ToolManifestEntry[] = [
  {
    name: 'list_mcp_proxies',
    description: 'Lists every configured MCP-server proxy with its live status (connected, paused, tool count, last error).',
    params: {},
    source: 'host',
  },
  {
    name: 'view_mcp_proxy',
    description: 'Returns one proxy\'s full config (transport, command/args/env or url/headers, description) plus its live status, by slug.',
    params: { slug: slugParam },
    source: 'host',
  },
  {
    name: 'add_mcp_proxy',
    description:
      'Adds and starts a new MCP-server proxy. For transport "stdio", pass command (and optionally args as a space-separated string — wrap any single arg containing spaces in double quotes, e.g. --dsn "mysql://user:pass@host/db", NOT needed for a value with no spaces even if it contains other punctuation like : or @; and optionally env as newline-separated KEY=VALUE pairs, one per line, for multiple vars). For "sse" or "streamableHttp", pass url instead. The proxy\'s tools then appear as a root connection named after slug, prefixed "<slug>__", directly addressable with no channel needed.',
    params: {
      slug: { type: 'string', description: 'URL-safe name for this proxy, e.g. "atlassian" — also its root connection name and tool-name prefix.' },
      transport: transportParam,
      command: commandParam,
      args: stdioArgsParam,
      env: envParam,
      url: urlParam,
      headers: headersParam,
      timeoutSeconds: timeoutParam,
      oauth: oauthParam,
      lazy: lazyParam,
      description: descriptionParam,
    },
    source: 'host',
  },
  {
    name: 'edit_mcp_proxy',
    description:
      'Replaces an existing proxy\'s config (same fields and quoting rules as add_mcp_proxy) and restarts it under the new config. Its current paused/running state is preserved. Fields not given fall back to empty, so pass the full desired config (view_mcp_proxy returns it), not just what changed — except headers, timeoutSeconds, oauth and lazy, which keep their current value when omitted (pass "", 0 or false to clear).',
    params: {
      slug: { type: 'string', description: 'The EXISTING proxy\'s current slug, to find it.' },
      newSlug: { type: 'string', description: 'The slug to rename it to — same as slug if not renaming.' },
      transport: transportParam,
      command: commandParam,
      args: stdioArgsParam,
      env: envParam,
      url: urlParam,
      headers: headersParam,
      timeoutSeconds: timeoutParam,
      oauth: oauthParam,
      lazy: lazyParam,
      description: descriptionParam,
    },
    source: 'host',
  },
  {
    name: 'pause_mcp_proxy',
    description: 'Pauses a proxy — its tools disappear from its root connection and the hub page immediately, but its config is kept for resume_mcp_proxy.',
    params: { slug: slugParam },
    source: 'host',
  },
  {
    name: 'resume_mcp_proxy',
    description: 'Resumes a previously paused proxy — reconnects it and its tools reappear.',
    params: { slug: slugParam },
    source: 'host',
  },
  {
    name: 'restart_mcp_proxy',
    description: 'Restarts a proxy\'s connection to its upstream server — useful if it\'s stuck in an error state. Any call in flight against it at the moment of restart fails cleanly rather than hanging.',
    params: { slug: slugParam },
    source: 'host',
  },
  {
    name: 'remove_mcp_proxy',
    description: 'Permanently removes a proxy and its config — this cannot be undone; add_mcp_proxy would be needed to recreate it.',
    params: { slug: slugParam },
    source: 'host',
  },
  {
    name: 'tool_call_report',
    description:
      'Returns a Markdown report of the recent tool calls made through this server — per tool: call and error counts, the error messages with the arguments that caused them, which parameters callers passed against which are declared, retries after an error, durations and result sizes. Use it to find tools whose description or parameters need improving. Covers only calls still in the rolling log.',
    params: {
      session: { type: 'string', description: 'Limit to one MCP session id, or "current" for this session. Omit for all sessions.', optional: true },
      tool: { type: 'string', description: 'Limit to tool names containing this text.', optional: true },
      connection: { type: 'string', description: 'Limit to one connection prefix, e.g. "htmlpaint".', optional: true },
    },
    source: 'host',
    annotations: { readOnlyHint: true },
  },
];

async function dispatchAdminCall(name: string, args: unknown, context?: CallContext): Promise<unknown> {
  const a = (args ?? {}) as Record<string, any>;
  switch (name) {
    case 'list_mcp_proxies':
      return listProxies();
    case 'view_mcp_proxy': {
      // Status AND config: this used to return only the status summary
      // (the same thing list_mcp_proxies gives), so an agent had no way to
      // read the command/args/env it must resend in full to edit_mcp_proxy.
      const id = resolveIdBySlug(a.slug);
      return { ...listProxies().find((p) => p.id === id), ...getProxyConfig(id) };
    }
    case 'add_mcp_proxy':
      return addProxy({ slug: a.slug, ...configFromArgs(a as Parameters<typeof configFromArgs>[0]) });
    case 'edit_mcp_proxy': {
      const id = resolveIdBySlug(a.slug);
      return updateProxy(id, { slug: a.newSlug || a.slug, ...configFromArgs(a as Parameters<typeof configFromArgs>[0]) });
    }
    case 'pause_mcp_proxy':
      return { ok: await pauseProxy(resolveIdBySlug(a.slug)) };
    case 'resume_mcp_proxy':
      return { ok: await resumeProxy(resolveIdBySlug(a.slug)) };
    case 'restart_mcp_proxy':
      return { ok: await restartProxy(resolveIdBySlug(a.slug)) };
    case 'remove_mcp_proxy':
      return { ok: await removeProxy(resolveIdBySlug(a.slug)) };
    case 'tool_call_report': {
      const sessionId = a.session === 'current' ? (context?.sessionId ?? 'no-session') : (a.session || undefined);
      return buildToolCallReport(getToolCallLog({ sessionId, tool: a.tool || undefined, connection: a.connection || undefined }), currentToolSpec);
    }
    default:
      throw new Error(`unknown admin tool "${name}"`);
  }
}

/** Registers the "admin" root connection's server-owned direct connection so its tools (admin__add_mcp_proxy etc.) are always visible in tools/list, independent of any browser tab and with no join_channel needed. Tool set is static (the proxy ops plus tool_call_report), so unlike a proxy's own manifest there's no resync hook needed here. */
export function initAdminChannel(): void {
  const connectionId = randomUUID();
  const { tenant } = getOrCreateRootTenant(ADMIN_ROOT_NAME, undefined, {});
  tenant.registerDirectConnection(connectionId, dispatchAdminCall, ADMIN_ROOT_NAME, 'admin');
  tenant.updateConnectionManifest(
    connectionId,
    manifest,
    'Manage MCP-server proxies for js-bridge-mcp: add/view/edit/pause/resume/restart/remove, and read the tool call report. See the hub page separately to actually USE a proxy\'s tools once it\'s added here.',
  );
}
