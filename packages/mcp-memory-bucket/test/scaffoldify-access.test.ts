import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { scaffoldifyAccess, loadUiToken, scaffoldifyUiUrl } from '../src/web/scaffoldify-access.js';

async function serve() {
  const app = express();
  app.use(scaffoldifyAccess('secret-token-0123456789abcdef0123456789'));
  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
  app.get('/', (_req, res) => { res.send('page'); });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

test('scaffoldify origin: preflight allowed, request needs the token', async () => {
  const s = await serve();
  try {
    const pre = await fetch(`${s.base}/api/health`, { method: 'OPTIONS', headers: { origin: 'https://scaffoldify.com', 'access-control-request-method': 'GET', 'access-control-request-private-network': 'true' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://scaffoldify.com');
    assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
    const noToken = await fetch(`${s.base}/api/health`, { headers: { origin: 'https://scaffoldify.com' } });
    assert.equal(noToken.status, 401);
    const wrong = await fetch(`${s.base}/api/health`, { headers: { origin: 'https://scaffoldify.com', 'x-bucket-token': 'nope' } });
    assert.equal(wrong.status, 401);
    const ok = await fetch(`${s.base}/api/health`, { headers: { origin: 'https://scaffoldify.com', 'x-bucket-token': 'secret-token-0123456789abcdef0123456789' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://scaffoldify.com');
  } finally {
    s.close();
  }
});

test('the local page and other origins are unchanged', async () => {
  const s = await serve();
  try {
    const local = await fetch(`${s.base}/api/health`);
    assert.equal(local.status, 200);
    const other = await fetch(`${s.base}/api/health`, { headers: { origin: 'https://evil.example' } });
    assert.equal(other.status, 200);
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  } finally {
    s.close();
  }
});

test('the UI token is created once, kept private, and goes in the URL fragment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-ui-token-'));
  const a = loadUiToken(dir);
  assert.equal(loadUiToken(dir), a);
  assert.equal(fs.statSync(path.join(dir, '.scaffoldify-ui-token')).mode & 0o777, 0o600);
  assert.equal(scaffoldifyUiUrl(8767, a), `https://scaffoldify.com/mcp#port=8767&token=${a}`);
});
