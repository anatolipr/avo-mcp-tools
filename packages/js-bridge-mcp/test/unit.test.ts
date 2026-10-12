import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRequest, isGuardedPath, isLoopbackAddress, isLoopbackHostname, resolveSecurityOptions } from '../src/security.js';
import { translateSchemaProperties, validateProxyInput } from '../src/proxy/proxy-manager.js';
import { parseArgs, parseEnv, parseHeaders } from '../src/proxy/admin-channel.js';
// @ts-expect-error — connect.js is hand-written vanilla JS with no type declarations in the source tree
import { parseChannelInput, sanitizeToValidChannelName, VALID_CHANNEL_NAME } from '../src/client/connect.js';

const local = { allowRemote: false, allowedOrigins: [] as string[] };
const req = (host: string | undefined, origin?: string) => ({ headers: { ...(host ? { host } : {}), ...(origin ? { origin } : {}) } });

test('checkRequest: requests with no Origin (MCP clients, curl, same-origin GETs) pass on any loopback Host', () => {
  for (const host of ['localhost:8766', '127.0.0.1:8766', '[::1]:8766', 'LOCALHOST:8766', 'app.localhost:8766']) {
    assert.deepEqual(checkRequest(req(host), local), { ok: true }, host);
  }
});

test('checkRequest: a non-loopback or missing Host is rejected unless allowRemote', () => {
  for (const host of ['evil.example:8766', '192.168.1.5:8766', 'localhost.evil.example:8766', undefined]) {
    assert.equal(checkRequest(req(host), local).ok, false, String(host));
  }
  assert.equal(checkRequest(req('192.168.1.5:8766'), { ...local, allowRemote: true }).ok, true);
});

test('checkRequest: loopback pages and browser extensions are trusted origins; foreign sites and "null" are not', () => {
  const host = 'localhost:8766';
  for (const origin of ['http://localhost:8766', 'http://localhost:5173', 'https://localhost', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'chrome-extension://abc', 'moz-extension://abc']) {
    assert.equal(checkRequest(req(host, origin), local).ok, true, origin);
  }
  for (const origin of ['https://evil.example', 'http://localhost.evil.example', 'null', 'file://', 'https://htmlpaint.com']) {
    assert.equal(checkRequest(req(host, origin), local).ok, false, origin);
  }
});

test('checkRequest: --allow-origin admits exactly the listed origin', () => {
  const options = { allowRemote: false, allowedOrigins: ['https://htmlpaint.com'] };
  assert.equal(checkRequest(req('localhost:8766', 'https://htmlpaint.com'), options).ok, true);
  assert.equal(checkRequest(req('localhost:8766', 'https://HTMLPaint.com'), options).ok, true);
  assert.equal(checkRequest(req('localhost:8766', 'https://evil.example'), options).ok, false);
  assert.equal(checkRequest(req('localhost:8766', 'null'), { allowRemote: false, allowedOrigins: ['null'] }).ok, true);
});

test('checkRequest: under allowRemote a same-origin page on a LAN host passes, a foreign origin still does not', () => {
  const remote = { allowRemote: true, allowedOrigins: [] };
  assert.equal(checkRequest(req('192.168.1.5:8766', 'http://192.168.1.5:8766'), remote).ok, true);
  assert.equal(checkRequest(req('192.168.1.5:8766', 'https://evil.example'), remote).ok, false);
});

test('resolveSecurityOptions: flags and env vars, off by default', () => {
  assert.deepEqual(resolveSecurityOptions(['node', 'x'], {}), { allowRemote: false, allowedOrigins: [] });
  assert.equal(resolveSecurityOptions(['node', 'x', '--allow-remote'], {}).allowRemote, true);
  assert.equal(resolveSecurityOptions(['node', 'x'], { JS_BRIDGE_MCP_ALLOW_REMOTE: '1' }).allowRemote, true);
  assert.equal(resolveSecurityOptions(['node', 'x'], { JS_BRIDGE_MCP_ALLOW_REMOTE: '0' }).allowRemote, false);
  assert.deepEqual(
    resolveSecurityOptions(['node', 'x', '--allow-origin', 'https://a.example/', '--allow-origin=https://b.example'], { JS_BRIDGE_MCP_ALLOWED_ORIGINS: 'https://c.example, https://a.example' }).allowedOrigins,
    ['https://a.example', 'https://b.example', 'https://c.example'],
  );
});

test('isGuardedPath: API, MCP and upload are guarded; the bridge socket and static assets are not', () => {
  for (const p of ['/mcp', '/upload', '/api/proxies', '/api/dashboard/stream', '/api/identity']) assert.equal(isGuardedPath(p), true, p);
  for (const p of ['/', '/ws', '/main.js', '/connect.js', '/tool-bus.js', '/admin', '/hub/foo', '/apiary']) assert.equal(isGuardedPath(p), false, p);
});

test('isLoopbackAddress / isLoopbackHostname', () => {
  for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(a), true, a);
  for (const a of ['192.168.1.5', '::ffff:192.168.1.5', 'fe80::1', '', undefined]) assert.equal(isLoopbackAddress(a), false, String(a));
  assert.equal(isLoopbackHostname('127.0.0.1.evil.example'), false);
  assert.equal(isLoopbackHostname('[::1]'), true);
});

test('translateSchemaProperties: scalars, integer, nullable, nested arrays/objects keep their shape', () => {
  const { params, unsupported } = translateSchemaProperties({
    type: 'object',
    required: ['q'],
    properties: {
      q: { type: 'string', description: 'query' },
      limit: { type: 'integer' },
      note: { type: ['string', 'null'] },
      edits: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' } }, required: ['field'] } },
    },
  });
  assert.equal(unsupported, false);
  assert.deepEqual(params.q, { type: 'string', description: 'query', optional: false });
  assert.deepEqual(params.limit, { type: 'number', description: undefined, optional: true });
  assert.deepEqual(params.note, { type: 'string', description: undefined, nullable: true, optional: true });
  assert.deepEqual(params.edits, {
    type: 'array',
    description: undefined,
    optional: true,
    items: { type: 'object', description: undefined, properties: { field: { type: 'string', description: undefined, optional: false } } },
  });
});

test('translateSchemaProperties: enum/const become a string enum; anything inexpressible becomes "any" with the schema in its description — never an unsupported tool', () => {
  const { params, unsupported } = translateSchemaProperties({
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['fast', 'deep'], description: 'm' },
      kind: { const: 'ticket' },
      level: { type: 'number', enum: [1, 2, 3] },
      idOrName: { anyOf: [{ type: 'string' }, { type: 'number' }], description: 'id or name' },
      ref: { $ref: '#/$defs/Thing' },
      meta: { type: 'object', additionalProperties: true },
      open: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'string' } },
      pair: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] },
      list: { type: 'array' },
      anything: {},
    },
  });
  assert.equal(unsupported, false);
  assert.deepEqual(params.mode, { type: 'string', enum: ['fast', 'deep'], description: 'm', optional: true });
  assert.deepEqual((params.kind as any).enum, ['ticket']);
  for (const key of ['level', 'idOrName', 'ref', 'meta', 'open', 'pair', 'anything']) assert.equal(params[key]!.type, 'any', key);
  assert.match(params.idOrName!.description!, /^id or name \(JSON Schema: \{"anyOf"/);
  assert.equal(params.anything!.description, undefined);
  assert.equal(params.list!.type, 'array');
  assert.equal((params.list as any).items.type, 'any');
});

test('translateSchemaProperties: a missing, propertyless or non-object schema yields no params rather than throwing', () => {
  for (const schema of [undefined, null, {}, { type: 'object' }, { type: 'string' }, 'nope']) {
    assert.deepEqual(translateSchemaProperties(schema), { params: {}, unsupported: false });
  }
});

test('translateSchemaProperties: a huge inexpressible schema is truncated in the description', () => {
  const big = { oneOf: Array.from({ length: 200 }, (_, i) => ({ type: 'object', properties: { [`field${i}`]: { type: 'string' } } })) };
  const { params } = translateSchemaProperties({ type: 'object', properties: { big } });
  assert.ok(params.big!.description!.length < 340, `description is ${params.big!.description!.length} chars`);
});

test('validateProxyInput accepts what the admin form and admin tools send, rejects configs that cannot start', () => {
  validateProxyInput({ slug: 'a', transport: 'stdio', command: 'npx', args: [], env: {} });
  validateProxyInput({ slug: 'a', transport: 'stdio', command: 'npx', args: undefined, env: undefined, url: undefined, description: undefined });
  validateProxyInput({ slug: 'a-b_1', transport: 'sse', url: 'https://example.com/sse', headers: { Authorization: 'x' }, callTimeoutMs: 5000 });
  validateProxyInput({ slug: 'a', transport: 'streamableHttp', url: 'http://localhost:1234', headers: null as any });
  assert.throws(() => validateProxyInput({ slug: 'has spaces', transport: 'stdio', command: 'npx' }), /not a valid proxy slug/);
  assert.throws(() => validateProxyInput({ slug: 'a', transport: 'stdio' }), /requires "command"/);
  assert.throws(() => validateProxyInput({ slug: 'a', transport: 'stdio', command: '  ' }), /requires "command"/);
  assert.throws(() => validateProxyInput({ slug: 'a', transport: 'sse' }), /http\(s\) "url"/);
  assert.throws(() => validateProxyInput({ slug: 'a', transport: 'sse', url: 'ftp://x' }), /http\(s\) "url"/);
  assert.throws(() => validateProxyInput({ slug: 'a', transport: 'ws' as any, url: 'http://x' }), /not a valid transport/);
  assert.throws(() => validateProxyInput({ slug: 'a', transport: 'stdio', command: 'npx', env: { A: 1 } as any }), /"env"/);
  assert.throws(() => validateProxyInput({ slug: 'a', transport: 'stdio', command: 'npx', callTimeoutMs: -1 }), /"callTimeoutMs"/);
});

test('parseArgs / parseEnv / parseHeaders', () => {
  assert.deepEqual(parseArgs('-y some-server --dsn "mysql://u:p@h/db name" \'single quoted\''), ['-y', 'some-server', '--dsn', 'mysql://u:p@h/db name', 'single quoted']);
  assert.deepEqual(parseArgs(''), []);
  assert.deepEqual(parseEnv('DSN=mysql://root:@127.0.0.1/x?a=b\n\n LOG = debug\nnoequals'), { DSN: 'mysql://root:@127.0.0.1/x?a=b', LOG: ' debug' });
  assert.deepEqual(parseHeaders('Authorization: Bearer a:b\nX-Team:core\n\n: novalue\nnocolon'), { Authorization: 'Bearer a:b', 'X-Team': 'core' });
});

test('connect.js parseChannelInput: bare name is a root connection, "channel:name" splits on the first colon', () => {
  assert.deepEqual(parseChannelInput('htmlpaint'), { channel: undefined, appLabel: 'htmlpaint' });
  assert.deepEqual(parseChannelInput('  '), { channel: undefined, appLabel: undefined });
  assert.deepEqual(parseChannelInput('bug123:htmlpaint'), { channel: 'bug123', appLabel: 'htmlpaint' });
  assert.deepEqual(parseChannelInput('bug123:a:b'), { channel: 'bug123', appLabel: 'a:b' });
  assert.deepEqual(parseChannelInput('bug123:'), { channel: 'bug123', appLabel: undefined });
  assert.equal(VALID_CHANNEL_NAME.test('bug 123'), false);
  assert.equal(sanitizeToValidChannelName('bug 123!'), 'bug-123-');
});
