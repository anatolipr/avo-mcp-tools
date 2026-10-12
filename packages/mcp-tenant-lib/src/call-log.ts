import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ToolParamSpec } from './types.js';

/**
 * Rolling, in-memory log of tool calls dispatched through
 * createManifestToolRegistry (manifest-tools.ts) — what was called, by
 * which MCP session, with which arguments, and how it ended. Two uses: a
 * human watching the dashboard, and buildToolCallReport below, which
 * condenses it for an LLM asked to improve the tools' descriptions and
 * parameters. Bounded twice (entry count and age) and never written to
 * disk: arguments can hold anything an agent was given.
 */
export interface ToolCallLogEntry {
  id: string;
  /** When the call started (Date.now()). */
  at: number;
  durationMs: number;
  /** MCP session that made the call — the grouping key when several agents share this server. */
  sessionId: string;
  /** That session's MCP client, "name version", when it reported one. */
  client?: string;
  /** Tenant id of the connection that answered ("root:<name>" for a root connection). */
  tenantId: string;
  /** The answering connection's tool-name prefix. */
  connection: string;
  kind: 'browser' | 'proxy' | 'admin';
  /** Tool name without the connection prefix. */
  tool: string;
  /** Arguments as JSON, cut to ARGS_PREVIEW_CHARS. */
  args: string;
  argsTruncated: boolean;
  /** Top-level argument names — kept whole even when `args` is cut, for parameter-usage counts. */
  argKeys: string[];
  ok: boolean;
  error?: string;
  /** Start of the result text, cut to RESULT_PREVIEW_CHARS. Absent for an error. */
  result?: string;
  /** Full size of the result text in characters, before cutting. */
  resultChars: number;
}

export interface ToolCallLogConfig {
  /** Most entries kept; the oldest are dropped first. 0 turns logging off. */
  limit: number;
  /** Entries older than this are dropped. */
  ttlMs: number;
}

export interface ToolCallLogFilter {
  sessionId?: string;
  /** Exact connection prefix. */
  connection?: string;
  /** Case-insensitive substring of the tool name. */
  tool?: string;
  status?: 'ok' | 'error';
}

export interface ToolCallSession {
  sessionId: string;
  client?: string;
  calls: number;
  errors: number;
  firstAt: number;
  lastAt: number;
}

/** A tool's current definition, for the report to set against how it was actually called. */
export interface ToolCallSpec {
  description: string;
  params: Record<string, ToolParamSpec>;
}

const MAX_LIMIT = 5000;
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ARGS_PREVIEW_CHARS = 4000;
const RESULT_PREVIEW_CHARS = 600;
const ERROR_CHARS = 1000;

let config: ToolCallLogConfig = { limit: 200, ttlMs: 60 * 60 * 1000 };
let entries: ToolCallLogEntry[] = [];

/** Fires 'change' after the log's contents or config change. Separate from dashboardEvents: that one makes every MCP session re-sync its tool list, far too heavy to fire per call. */
export const toolCallLogEvents = new EventEmitter();
toolCallLogEvents.setMaxListeners(0);

function prune(now = Date.now()) {
  const cutoff = now - config.ttlMs;
  // Entries are appended in completion order, so start times are only
  // roughly sorted — filter rather than assume a sorted prefix.
  if (entries.some((e) => e.at < cutoff)) entries = entries.filter((e) => e.at >= cutoff);
  if (entries.length > config.limit) entries = entries.slice(entries.length - config.limit);
}

export function getToolCallLogConfig(): ToolCallLogConfig {
  return { ...config };
}

/** Out-of-range or non-numeric values are clamped/ignored rather than rejected, so a bad UI input can never leave the log unbounded. */
export function setToolCallLogConfig(next: Partial<ToolCallLogConfig>): ToolCallLogConfig {
  if (typeof next.limit === 'number' && Number.isFinite(next.limit)) {
    config.limit = Math.min(MAX_LIMIT, Math.max(0, Math.floor(next.limit)));
  }
  if (typeof next.ttlMs === 'number' && Number.isFinite(next.ttlMs)) {
    config.ttlMs = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.floor(next.ttlMs)));
  }
  prune();
  toolCallLogEvents.emit('change');
  return getToolCallLogConfig();
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '[unserializable]';
  }
}

export interface RecordToolCallInput {
  at: number;
  durationMs: number;
  sessionId?: string;
  client?: string;
  tenantId: string;
  connection: string;
  kind: 'browser' | 'proxy' | 'admin';
  tool: string;
  args: unknown;
  ok: boolean;
  error?: string;
  /** Full result text; only its start is kept. */
  resultText?: string;
}

/** Never throws — logging must not be able to fail the tool call it describes. */
export function recordToolCall(input: RecordToolCallInput): void {
  try {
    if (config.limit <= 0) return;
    const argsJson = input.args === undefined ? '{}' : safeJson(input.args);
    const resultText = input.resultText ?? '';
    entries.push({
      id: randomUUID(),
      at: input.at,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      sessionId: input.sessionId || 'no-session',
      client: input.client,
      tenantId: input.tenantId,
      connection: input.connection,
      kind: input.kind,
      tool: input.tool,
      args: argsJson.length > ARGS_PREVIEW_CHARS ? argsJson.slice(0, ARGS_PREVIEW_CHARS) : argsJson,
      argsTruncated: argsJson.length > ARGS_PREVIEW_CHARS,
      argKeys: input.args && typeof input.args === 'object' && !Array.isArray(input.args) ? Object.keys(input.args) : [],
      ok: input.ok,
      error: input.ok ? undefined : (input.error ?? resultText).slice(0, ERROR_CHARS),
      result: input.ok ? resultText.slice(0, RESULT_PREVIEW_CHARS) : undefined,
      resultChars: resultText.length,
    });
    prune();
    toolCallLogEvents.emit('change');
  } catch (err) {
    console.error(`[mcp-tenant-lib] failed to record a tool call: ${(err as Error)?.message ?? err}`);
  }
}

function matches(entry: ToolCallLogEntry, filter: ToolCallLogFilter): boolean {
  if (filter.sessionId && entry.sessionId !== filter.sessionId) return false;
  if (filter.connection && entry.connection !== filter.connection) return false;
  if (filter.tool && !entry.tool.toLowerCase().includes(filter.tool.toLowerCase())) return false;
  if (filter.status === 'ok' && !entry.ok) return false;
  if (filter.status === 'error' && entry.ok) return false;
  return true;
}

/** Oldest first. */
export function getToolCallLog(filter: ToolCallLogFilter = {}): ToolCallLogEntry[] {
  prune();
  return entries.filter((e) => matches(e, filter)).sort((a, b) => a.at - b.at);
}

/** Every session still present in the log, most recently active first — unfiltered, so a UI can offer them all as filter choices. */
export function listToolCallSessions(): ToolCallSession[] {
  prune();
  const bySession = new Map<string, ToolCallSession>();
  for (const e of entries) {
    const s = bySession.get(e.sessionId) ?? { sessionId: e.sessionId, client: e.client, calls: 0, errors: 0, firstAt: e.at, lastAt: e.at };
    s.calls++;
    if (!e.ok) s.errors++;
    s.firstAt = Math.min(s.firstAt, e.at);
    s.lastAt = Math.max(s.lastAt, e.at);
    s.client ??= e.client;
    bySession.set(e.sessionId, s);
  }
  return [...bySession.values()].sort((a, b) => b.lastAt - a.lastAt);
}

/** Removes the matching entries (everything, with no filter). Returns how many were removed. */
export function clearToolCallLog(filter: ToolCallLogFilter = {}): number {
  const before = entries.length;
  entries = entries.filter((e) => !matches(e, filter));
  toolCallLogEvents.emit('change');
  return before - entries.length;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Condenses log entries into a Markdown report written for an LLM asked to
 * improve the tools: per tool, how often it was called and failed, which
 * parameters callers actually passed against which it declares, the
 * distinct error messages with the arguments that caused them, and calls
 * repeated straight after an error (a caller guessing). `specFor` supplies
 * a tool's current definition when its connection is still live; a tool
 * without one is still reported, just without the declared-versus-used
 * comparison.
 */
export function buildToolCallReport(
  log: ToolCallLogEntry[],
  specFor: (entry: ToolCallLogEntry) => ToolCallSpec | undefined = () => undefined,
): string {
  if (log.length === 0) return '# Tool call report\n\nNo tool calls in the log for this filter.\n';

  const sorted = [...log].sort((a, b) => a.at - b.at);
  const sessions = new Set(sorted.map((e) => e.sessionId));
  const byTool = new Map<string, ToolCallLogEntry[]>();
  for (const e of sorted) {
    const key = `${e.connection}__${e.tool}`;
    byTool.set(key, [...(byTool.get(key) ?? []), e]);
  }

  // A call to the same tool directly after that tool failed, within one
  // session: the caller is retrying with changed arguments.
  const retriesAfterError = new Map<string, number>();
  const lastByTool = new Map<string, ToolCallLogEntry>();
  for (const e of sorted) {
    const key = `${e.sessionId}|${e.connection}__${e.tool}`;
    const previous = lastByTool.get(key);
    if (previous && !previous.ok) {
      const toolKey = `${e.connection}__${e.tool}`;
      retriesAfterError.set(toolKey, (retriesAfterError.get(toolKey) ?? 0) + 1);
    }
    lastByTool.set(key, e);
  }

  const lines: string[] = [];
  lines.push('# Tool call report');
  lines.push('');
  lines.push(
    `${sorted.length} call(s) to ${byTool.size} tool(s) across ${sessions.size} MCP session(s), ` +
    `${new Date(sorted[0]!.at).toISOString()} to ${new Date(sorted[sorted.length - 1]!.at).toISOString()}.`,
  );
  lines.push('');
  lines.push(
    'Use this to improve the tools. Look for: errors a clearer description or parameter description would have prevented; ' +
    'parameters callers never pass, or pass under a wrong name; calls repeated after an error (the caller was guessing); ' +
    'results large enough to need a limit or filter parameter; slow tools. Argument and result text is cut short.',
  );
  lines.push('');
  lines.push('| Tool | Calls | Errors | Retries after error | Avg ms | p95 ms | Avg result chars |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  const ranked = [...byTool.entries()].sort((a, b) => b[1].filter((e) => !e.ok).length - a[1].filter((e) => !e.ok).length || b[1].length - a[1].length);
  for (const [name, calls] of ranked) {
    const durations = calls.map((e) => e.durationMs).sort((a, b) => a - b);
    const avg = Math.round(durations.reduce((sum, d) => sum + d, 0) / calls.length);
    const okCalls = calls.filter((e) => e.ok);
    const avgResult = okCalls.length ? Math.round(okCalls.reduce((sum, e) => sum + e.resultChars, 0) / okCalls.length) : 0;
    lines.push(`| ${name} | ${calls.length} | ${calls.length - okCalls.length} | ${retriesAfterError.get(name) ?? 0} | ${avg} | ${percentile(durations, 0.95)} | ${avgResult} |`);
  }

  for (const [name, calls] of ranked) {
    lines.push('');
    lines.push(`## ${name}`);
    const spec = specFor(calls[calls.length - 1]!);
    if (spec) lines.push(`Description: ${oneLine(spec.description, 600) || '(empty)'}`);
    else lines.push('Description: not available (connection no longer live, or a tool reached through a lazy proxy).');

    const used = new Map<string, number>();
    for (const e of calls) for (const key of e.argKeys) used.set(key, (used.get(key) ?? 0) + 1);
    const declared = spec ? Object.keys(spec.params) : [];
    const paramNames = [...new Set([...declared, ...used.keys()])];
    if (paramNames.length > 0) {
      lines.push('');
      lines.push('Parameters (declared against passed):');
      for (const param of paramNames) {
        const count = used.get(param) ?? 0;
        const declaredSpec = spec?.params[param];
        const status = !spec ? '' : !declaredSpec ? ' — NOT DECLARED, callers pass it anyway' : declaredSpec.optional ? ' — optional' : ' — required';
        lines.push(`- \`${param}\`: passed in ${count} of ${calls.length} call(s)${status}`);
      }
    }

    const errors = new Map<string, { count: number; sample: ToolCallLogEntry }>();
    for (const e of calls) {
      if (e.ok) continue;
      const message = oneLine(e.error ?? '', 300);
      const group = errors.get(message) ?? { count: 0, sample: e };
      group.count++;
      errors.set(message, group);
    }
    if (errors.size > 0) {
      lines.push('');
      lines.push('Errors:');
      for (const [message, { count, sample }] of [...errors.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 8)) {
        lines.push(`- ${count}× ${message || '(no message)'}`);
        lines.push(`  - args: \`${oneLine(sample.args, 400)}\``);
      }
    }

    const okSample = calls.find((e) => e.ok);
    if (okSample) {
      lines.push('');
      lines.push(`Sample successful call: \`${oneLine(okSample.args, 400)}\` → \`${oneLine(okSample.result ?? '', 200)}\``);
    }
  }
  lines.push('');
  return lines.join('\n');
}
