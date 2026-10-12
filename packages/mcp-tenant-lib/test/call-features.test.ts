import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Tenant, tenants, setDynamicToolStore } from '../src/tenant.js';
import { createManifestToolRegistry, toToolResult } from '../src/manifest-tools.js';
import { createFileDynamicToolStore } from '../src/dynamic-tool-store.js';
import {
  recordToolCall, getToolCallLog, listToolCallSessions, clearToolCallLog, setToolCallLogConfig, buildToolCallReport,
} from '../src/call-log.js';
import type { ToolManifestEntry } from '../src/types.js';

function fakeSocket(onMessage: (msg: any) => void) {
  return { readyState: 1, OPEN: 1, send: (raw: string) => onMessage(JSON.parse(raw)) } as any;
}

function registryFor(t: Tenant<any, any>) {
  const mcp = new McpServer({ name: 'test', version: '0.0.0' });
  const registry = createManifestToolRegistry(mcp, () => t);
  registry.sync();
  return { mcp, registry };
}

beforeEach(() => {
  clearToolCallLog();
  setToolCallLogConfig({ limit: 200, ttlMs: 60 * 60 * 1000 });
  setDynamicToolStore(undefined);
});

// ---- result passthrough ----

test('toToolResult passes a real MCP tool result through, keeping image content and isError', () => {
  const upstream = { content: [{ type: 'text', text: 'boom' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }], isError: true };
  assert.deepEqual(toToolResult(upstream), upstream);
});

test('toToolResult still returns plain data as JSON text, including page data that merely has a "content" field', () => {
  assert.deepEqual(toToolResult('hi'), { content: [{ type: 'text', text: 'hi' }] });
  assert.deepEqual(toToolResult({ ok: true }), { content: [{ type: 'text', text: '{"ok":true}' }] });
  // extra key -> not a tool result
  const doc = { title: 'x', content: [{ type: 'text', text: 'para' }] };
  assert.equal(toToolResult(doc).content[0].text, JSON.stringify(doc));
  // malformed blocks -> not a tool result
  const nodes = { content: [{ type: 'paragraph', text: 'para' }] };
  assert.equal(toToolResult(nodes).content[0].text, JSON.stringify(nodes));
  // empty content -> not a tool result
  assert.equal(toToolResult({ content: [] }).content[0].text, '{"content":[]}');
});

test('toToolResult never throws: undefined becomes empty text, a circular value becomes an error result', () => {
  assert.deepEqual(toToolResult(undefined), { content: [{ type: 'text', text: '' }] });
  const circular: any = {};
  circular.self = circular;
  const result = toToolResult(circular);
  assert.equal(result.isError, true);
});

test('a proxied (directCall) tool error reaches the MCP client as isError, not as a successful JSON blob', async () => {
  const t = new Tenant('t-pass', undefined, {});
  t.registerDirectConnection('p', async () => ({ content: [{ type: 'text', text: 'upstream failed' }], isError: true }), 'up');
  t.updateConnectionManifest('p', [{ name: 'q', description: 'd', params: {} }]);
  const { registry } = registryFor(t);
  const result: any = await (registry.handles.get('up__q') as any).handler({}, {});
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, 'upstream failed');
});

// ---- annotations ----

test('annotations on a manifest entry reach the registered tool; malformed fields are dropped', () => {
  const t = new Tenant('t-ann', undefined, {});
  t.registerConnection('a', fakeSocket(() => {}), 'a');
  t.updateConnectionManifest('a', [
    { name: 'read', description: 'd', params: {}, annotations: { readOnlyHint: true, title: 'Read', destructiveHint: 'yes' as any } },
    { name: 'plain', description: 'd', params: {} },
  ]);
  const { registry } = registryFor(t);
  assert.deepEqual((registry.handles.get('a__read') as any).annotations, { title: 'Read', readOnlyHint: true });
  assert.equal((registry.handles.get('a__plain') as any).annotations, undefined);
});

// ---- cancellation and progress ----

test('aborting the signal rejects the call and sends cancel_call to the page that got it', async () => {
  const t = new Tenant('t-cancel', undefined, {});
  const sent: any[] = [];
  t.registerConnection('a', fakeSocket((msg) => sent.push(msg)), 'a');
  const controller = new AbortController();
  const pending = t.call('a', 'slow', {}, 10_000, undefined, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /was cancelled/);
  assert.deepEqual(sent.map((m) => m.type), ['call', 'cancel_call']);
  assert.equal(sent[1].id, sent[0].id);
  assert.equal(t.pendingCalls.size, 0);
});

test('a call whose signal is already aborted is rejected without being sent', async () => {
  const t = new Tenant('t-cancel2', undefined, {});
  const sent: any[] = [];
  t.registerConnection('a', fakeSocket((msg) => sent.push(msg)), 'a');
  await assert.rejects(t.call('a', 'slow', {}, 10_000, undefined, { signal: AbortSignal.abort() }), /was cancelled/);
  assert.equal(sent.length, 0);
});

test('aborting after the call resolved does nothing', async () => {
  const t = new Tenant('t-cancel3', undefined, {});
  const sent: any[] = [];
  t.registerConnection('a', fakeSocket((msg) => sent.push(msg)), 'a');
  const controller = new AbortController();
  const pending = t.call('a', 'fast', {}, 10_000, undefined, { signal: controller.signal });
  t.resolveCall(sent[0].id, 'done');
  assert.equal(await pending, 'done');
  controller.abort();
  assert.deepEqual(sent.map((m) => m.type), ['call']);
});

test('progress reaches onProgress while the call is in flight, is ignored afterwards, and a throwing listener is contained', async () => {
  const t = new Tenant('t-prog', undefined, {});
  const sent: any[] = [];
  t.registerConnection('a', fakeSocket((msg) => sent.push(msg)), 'a');
  const seen: any[] = [];
  const pending = t.call('a', 'work', {}, 10_000, undefined, { onProgress: (p) => { seen.push(p); throw new Error('listener bug'); } });
  t.progressCall(sent[0].id, { progress: 1, total: 2 });
  t.resolveCall(sent[0].id, 'ok');
  t.progressCall(sent[0].id, { progress: 2, total: 2 });
  assert.equal(await pending, 'ok');
  assert.deepEqual(seen, [{ progress: 1, total: 2 }]);
});

test('a directCall target receives the signal, session id and a working progress reporter', async () => {
  const t = new Tenant('t-direct', undefined, {});
  let received: any;
  t.registerDirectConnection('p', async (_name, _args, context) => {
    received = context;
    context?.onProgress?.({ progress: 5 });
    return 'ok';
  }, 'up');
  const controller = new AbortController();
  const seen: any[] = [];
  assert.equal(await t.call('p', 'x', {}, 1000, undefined, { signal: controller.signal, sessionId: 's1', onProgress: (p) => seen.push(p) }), 'ok');
  assert.equal(received.signal, controller.signal);
  assert.equal(received.sessionId, 's1');
  assert.deepEqual(seen, [{ progress: 5 }]);
});

test('a directCall that throws synchronously becomes a rejected call, and one given no context still works', async () => {
  const t = new Tenant('t-direct2', undefined, {});
  t.registerDirectConnection('p', (() => { throw new Error('sync boom'); }) as any, 'up');
  await assert.rejects(t.call('p', 'x', {}), /sync boom/);
  const t2 = new Tenant('t-direct3', undefined, {});
  t2.registerDirectConnection('p', async (name) => `ran ${name}`, 'up');
  assert.equal(await t2.call('p', 'x', {}), 'ran x');
});

test('an MCP progressToken turns page progress into notifications/progress', async () => {
  const t = new Tenant('t-prog2', undefined, {});
  const sent: any[] = [];
  t.registerConnection('a', fakeSocket((msg) => sent.push(msg)), 'a');
  t.updateConnectionManifest('a', [{ name: 'work', description: 'd', params: {} }]);
  const { registry } = registryFor(t);
  const notifications: any[] = [];
  const extra = { _meta: { progressToken: 'tok' }, sendNotification: async (n: any) => { notifications.push(n); }, sessionId: 's9' };
  const pending = (registry.handles.get('a__work') as any).handler({}, extra);
  const call = sent.find((m) => m.type === 'call');
  t.progressCall(call.id, { progress: 3, total: 10, message: 'step' });
  t.resolveCall(call.id, 'ok');
  await pending;
  assert.deepEqual(notifications, [{ method: 'notifications/progress', params: { progressToken: 'tok', progress: 3, total: 10, message: 'step' } }]);
});

// ---- call log ----

test('every dispatched tool call is logged with its session, arguments and outcome', async () => {
  const t = new Tenant('t-log', undefined, {});
  const sent: any[] = [];
  t.registerConnection('a', fakeSocket((msg) => sent.push(msg)), 'app');
  t.updateConnectionManifest('a', [{ name: 'find', description: 'finds things', params: { q: { type: 'string' }, limit: { type: 'number', optional: true } } }]);
  const { registry } = registryFor(t);
  const handler = (registry.handles.get('app__find') as any).handler;

  const ok = handler({ q: 'x' }, { sessionId: 's1' });
  t.resolveCall(sent.at(-1).id, 'found 3');
  await ok;
  const bad = handler({ query: 'x' }, { sessionId: 's2' });
  t.rejectCall(sent.at(-1).id, 'q is required');
  const badResult = await bad;
  assert.equal(badResult.isError, true);

  const log = getToolCallLog();
  assert.equal(log.length, 2);
  assert.deepEqual(log.map((e) => [e.sessionId, e.connection, e.tool, e.ok]), [['s1', 'app', 'find', true], ['s2', 'app', 'find', false]]);
  assert.equal(log[0]!.args, '{"q":"x"}');
  assert.equal(log[0]!.result, 'found 3');
  assert.equal(log[1]!.error, 'q is required');

  assert.equal(getToolCallLog({ sessionId: 's2' }).length, 1);
  assert.equal(getToolCallLog({ status: 'error' }).length, 1);
  assert.deepEqual(listToolCallSessions().map((s) => [s.sessionId, s.calls, s.errors]).sort(), [['s1', 1, 0], ['s2', 1, 1]]);
});

test('a dispatcher tool is logged under the tool it dispatched to', async () => {
  const t = new Tenant('t-log2', undefined, {});
  t.registerDirectConnection('p', async () => 'ok', 'lazy');
  t.updateConnectionManifest('p', [{ name: 'call_tool', description: 'd', params: { tool: { type: 'string' }, args: { type: 'any', optional: true } }, innerToolParam: 'tool' }]);
  const { registry } = registryFor(t);
  await (registry.handles.get('lazy__call_tool') as any).handler({ tool: 'query', args: { sql: 'select 1' } }, {});
  assert.equal(getToolCallLog()[0]!.tool, 'query');
});

test('the log keeps only the last N calls, drops entries past the TTL, and limit 0 turns it off', () => {
  const base = { durationMs: 1, tenantId: 't', connection: 'c', kind: 'browser' as const, tool: 'x', args: {}, ok: true };
  setToolCallLogConfig({ limit: 3 });
  for (let i = 0; i < 5; i++) recordToolCall({ ...base, at: Date.now() + i, args: { i } });
  assert.deepEqual(getToolCallLog().map((e) => e.args), ['{"i":2}', '{"i":3}', '{"i":4}']);

  setToolCallLogConfig({ limit: 200, ttlMs: 60_000 });
  recordToolCall({ ...base, at: Date.now() - 5 * 60_000, tool: 'old' });
  assert.ok(!getToolCallLog().some((e) => e.tool === 'old'));

  clearToolCallLog();
  setToolCallLogConfig({ limit: 0 });
  recordToolCall({ ...base, at: Date.now() });
  assert.equal(getToolCallLog().length, 0);
});

test('config values are clamped, and long arguments are cut while their keys are kept', () => {
  assert.equal(setToolCallLogConfig({ limit: 1e9 }).limit, 5000);
  assert.equal(setToolCallLogConfig({ limit: -4 }).limit, 0);
  assert.equal(setToolCallLogConfig({ ttlMs: 1 }).ttlMs, 60_000);
  assert.equal(setToolCallLogConfig({ limit: Number.NaN }).limit, 0);
  setToolCallLogConfig({ limit: 10 });
  recordToolCall({ at: Date.now(), durationMs: 1, tenantId: 't', connection: 'c', kind: 'browser', tool: 'x', args: { big: 'y'.repeat(10_000), other: 1 }, ok: true });
  const entry = getToolCallLog()[0]!;
  assert.equal(entry.argsTruncated, true);
  assert.equal(entry.args.length, 4000);
  assert.deepEqual(entry.argKeys, ['big', 'other']);
});

test('recordToolCall never throws, even on unserializable arguments', () => {
  const circular: any = {};
  circular.self = circular;
  assert.doesNotThrow(() => recordToolCall({ at: Date.now(), durationMs: 1, tenantId: 't', connection: 'c', kind: 'browser', tool: 'x', args: circular, ok: true }));
  assert.doesNotThrow(() => recordToolCall({ at: Date.now(), durationMs: 1, tenantId: 't', connection: 'c', kind: 'browser', tool: 'x', args: { n: 1n } as any, ok: true }));
});

test('the report sets declared parameters against passed ones, groups errors, and counts retries after an error', () => {
  const base = { durationMs: 10, tenantId: 't', connection: 'app', kind: 'browser' as const, tool: 'find', sessionId: 's1' };
  const now = Date.now();
  recordToolCall({ ...base, at: now, args: { query: 'a' }, ok: false, error: 'q is required' });
  recordToolCall({ ...base, at: now + 1, args: { query: 'b' }, ok: false, error: 'q is required' });
  recordToolCall({ ...base, at: now + 2, args: { q: 'a' }, ok: true, resultText: 'found 3' });
  const report = buildToolCallReport(getToolCallLog(), () => ({
    description: 'finds things',
    params: { q: { type: 'string' }, limit: { type: 'number', optional: true } },
  }));
  assert.match(report, /3 call\(s\) to 1 tool\(s\) across 1 MCP session/);
  assert.match(report, /\| app__find \| 3 \| 2 \| 2 \|/);
  assert.match(report, /`query`: passed in 2 of 3 call\(s\) — NOT DECLARED/);
  assert.match(report, /`limit`: passed in 0 of 3 call\(s\) — optional/);
  assert.match(report, /2× q is required/);
  assert.match(buildToolCallReport([]), /No tool calls/);
});

// ---- persisted dynamic tools ----

const dynamicTool: ToolManifestEntry = {
  name: 'save_note', description: 'saves', params: { text: { type: 'string' } }, source: 'dynamic', origin: { kind: 'code', code: 'return 1;' },
};
const hostTool: ToolManifestEntry = { name: 'host', description: 'host tool', params: {} };

function tempStorePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-lib-dyn-')), 'tools.json');
}

test('with a store set, dynamic tools survive a brand-new Tenant (server restart) and are replayed with their params', async () => {
  const file = tempStorePath();
  setDynamicToolStore(createFileDynamicToolStore(file));
  const first = new Tenant('root:myapp', undefined, {});
  first.registerConnection('a', fakeSocket(() => {}), 'myapp');
  first.updateConnectionManifest('a', [hostTool], undefined, 'myapp');
  first.updateConnectionManifest('a', [hostTool, dynamicTool], undefined, 'myapp');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // "Restart": a fresh store read from the same file, a fresh Tenant.
  setDynamicToolStore(createFileDynamicToolStore(file));
  const second = new Tenant('root:myapp', undefined, {});
  const calls: any[] = [];
  second.registerConnection('b', fakeSocket((msg) => { if (msg.type === 'call') calls.push(msg); }), 'myapp');
  second.updateConnectionManifest('b', [hostTool], undefined, 'myapp');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, '__register_tool_by_code__');
  assert.deepEqual(calls[0].args, { name: 'save_note', description: 'saves', code: 'return 1;', params: { text: { type: 'string' } } });

  // The half-filled manifest must not overwrite the store while the replay is still running.
  assert.equal(createFileDynamicToolStore(file).get('root:myapp|myapp')?.length, 1);
});

test('unregistering a dynamic tool removes it from the store; without a store nothing is written', async () => {
  const file = tempStorePath();
  setDynamicToolStore(createFileDynamicToolStore(file));
  const t = new Tenant('root:app2', undefined, {});
  t.registerConnection('a', fakeSocket(() => {}), 'app2');
  t.updateConnectionManifest('a', [hostTool], undefined, 'app2');
  t.updateConnectionManifest('a', [hostTool, dynamicTool], undefined, 'app2');
  assert.equal(createFileDynamicToolStore(file).get('root:app2|app2')?.length, 1);
  t.updateConnectionManifest('a', [hostTool], undefined, 'app2');
  assert.equal(createFileDynamicToolStore(file).get('root:app2|app2'), undefined);

  setDynamicToolStore(undefined);
  const other = tempStorePath();
  const t2 = new Tenant('root:app3', undefined, {});
  t2.registerConnection('a', fakeSocket(() => {}), 'app3');
  t2.updateConnectionManifest('a', [hostTool, dynamicTool], undefined, 'app3');
  assert.equal(fs.existsSync(other), false);
});

test('a proxy (directCall) connection is never stashed, persisted or replayed', () => {
  const file = tempStorePath();
  setDynamicToolStore(createFileDynamicToolStore(file));
  const t = new Tenant('root:px', undefined, {});
  const upstreamCalls: string[] = [];
  const proxyTool: ToolManifestEntry = { name: 'q', description: 'd', params: {}, source: 'dynamic', origin: { kind: 'path', path: 'px:q' } };
  t.registerDirectConnection('p1', async (name) => { upstreamCalls.push(name); return 'ok'; }, 'px');
  t.updateConnectionManifest('p1', [proxyTool], undefined, 'px');
  t.removeConnection('p1');
  t.registerDirectConnection('p2', async (name) => { upstreamCalls.push(name); return 'ok'; }, 'px');
  t.updateConnectionManifest('p2', [proxyTool], undefined, 'px');
  assert.deepEqual(upstreamCalls, []);
  assert.equal(fs.existsSync(file), false);
});

test('a corrupt store file starts empty instead of throwing', () => {
  const file = tempStorePath();
  fs.writeFileSync(file, '{not json');
  const store = createFileDynamicToolStore(file);
  assert.equal(store.get('x'), undefined);
  store.set('x', [dynamicTool]);
  assert.equal(createFileDynamicToolStore(file).get('x')?.length, 1);
});

test.after(() => { tenants.clear(); });
