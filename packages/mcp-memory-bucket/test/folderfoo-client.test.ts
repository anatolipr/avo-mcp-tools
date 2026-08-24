import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setCredential, getCredential } from '../src/remote/credentials.js';
import { login, getLastChanged, getChangedSince, readFile, writeFile, FolderfooAuthError } from '../src/remote/folderfoo-client.js';

function tmpBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mb-folderfoo-client-test-'));
}

// Records every call made to the mocked fetch, and lets each test script a
// queue of responses to return in order - mirrors how a real 401-then-retry
// sequence unfolds without needing a real folderfoo server.
function mockFetch(responses: Array<{ status: number; body: unknown; isText?: boolean }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: String(r.status),
      json: async () => r.body,
      text: async () => (r.isText ? (r.body as string) : JSON.stringify(r.body)),
    } as Response;
  };
  return { fn, calls };
}

test('login: POSTs credentials and returns the token as jwt', async (t) => {
  const { fn, calls } = mockFetch([{ status: 200, body: { username: 'alice', fullname: 'Alice', token: 'jwt-1' } }]);
  t.mock.method(globalThis, 'fetch', fn);

  const result = await login('https://folderfoo.example.com', 'alice', 'pw');
  assert.equal(result.jwt, 'jwt-1');
  assert.equal(calls[0].url, 'https://folderfoo.example.com/login');
  assert.equal(calls[0].init?.method, 'POST');
});

test('login: throws with the server error message on a 401', async (t) => {
  const { fn } = mockFetch([{ status: 401, body: { error: 'Invalid username or password' } }]);
  t.mock.method(globalThis, 'fetch', fn);

  await assert.rejects(() => login('https://folderfoo.example.com', 'alice', 'wrong'), /Invalid username or password/);
});

test('getLastChanged: sends the stored jwt as a bearer token and the tenant header', async (t) => {
  const baseDir = tmpBaseDir();
  setCredential(baseDir, 'https://folderfoo.example.com', 'jwt-1');
  const { fn, calls } = mockFetch([{ status: 200, body: { lastChanged: 12345 } }]);
  t.mock.method(globalThis, 'fetch', fn);

  const result = await getLastChanged('https://folderfoo.example.com', baseDir, 't1', 'work');
  assert.equal(result, 12345);
  assert.equal((calls[0].init?.headers as Record<string, string>).authorization, 'Bearer jwt-1');
  assert.equal((calls[0].init?.headers as Record<string, string>)['x-tenant-id'], 't1');
  assert.ok(calls[0].url.includes('/folders/last-changed'));
  assert.ok(calls[0].url.includes('folderPath=work'));
});

test('getLastChanged: throws FolderfooAuthError immediately when no credential is stored', async () => {
  const baseDir = tmpBaseDir();
  await assert.rejects(() => getLastChanged('https://folderfoo.example.com', baseDir, 't1', 'work'), FolderfooAuthError);
});

test('a 401 triggers exactly one refresh-and-retry, and the refreshed token is persisted', async (t) => {
  const baseDir = tmpBaseDir();
  setCredential(baseDir, 'https://folderfoo.example.com', 'jwt-expired');
  const { fn, calls } = mockFetch([
    { status: 401, body: { error: 'Invalid or expired session' } }, // first getLastChanged call
    { status: 200, body: { username: 'alice', fullname: 'Alice', token: 'jwt-fresh' } }, // /refresh
    { status: 200, body: { lastChanged: 999 } }, // retried getLastChanged call
  ]);
  t.mock.method(globalThis, 'fetch', fn);

  const result = await getLastChanged('https://folderfoo.example.com', baseDir, 't1', 'work');
  assert.equal(result, 999);
  assert.equal(calls.length, 3);
  assert.ok(calls[1].url.endsWith('/refresh'));
  assert.equal(getCredential(baseDir, 'https://folderfoo.example.com')?.jwt, 'jwt-fresh');
});

test('a 401 after a failed refresh clears the credential and throws FolderfooAuthError', async (t) => {
  const baseDir = tmpBaseDir();
  setCredential(baseDir, 'https://folderfoo.example.com', 'jwt-expired');
  const { fn } = mockFetch([
    { status: 401, body: { error: 'Invalid or expired session' } }, // first call
    { status: 401, body: { error: 'Session too old, please log in again' } }, // /refresh also fails
  ]);
  t.mock.method(globalThis, 'fetch', fn);

  await assert.rejects(() => getLastChanged('https://folderfoo.example.com', baseDir, 't1', 'work'), FolderfooAuthError);
  assert.equal(getCredential(baseDir, 'https://folderfoo.example.com'), undefined);
});

test('a 401 on the RETRY (after a successful refresh) also clears the credential and throws', async (t) => {
  const baseDir = tmpBaseDir();
  setCredential(baseDir, 'https://folderfoo.example.com', 'jwt-expired');
  const { fn } = mockFetch([
    { status: 401, body: { error: 'expired' } },
    { status: 200, body: { username: 'alice', fullname: 'Alice', token: 'jwt-fresh' } },
    { status: 401, body: { error: 'still rejected' } },
  ]);
  t.mock.method(globalThis, 'fetch', fn);

  await assert.rejects(() => getLastChanged('https://folderfoo.example.com', baseDir, 't1', 'work'), FolderfooAuthError);
  assert.equal(getCredential(baseDir, 'https://folderfoo.example.com'), undefined);
});

test('getChangedSince: returns the files array and passes since as a query param', async (t) => {
  const baseDir = tmpBaseDir();
  setCredential(baseDir, 'https://folderfoo.example.com', 'jwt-1');
  const files = [{ name: 'notes', folderPath: 'work', mtime: 123 }];
  const { fn, calls } = mockFetch([{ status: 200, body: { files, serverTime: 456 } }]);
  t.mock.method(globalThis, 'fetch', fn);

  const result = await getChangedSince('https://folderfoo.example.com', baseDir, 't1', 'work', 100);
  assert.deepEqual(result, files);
  assert.ok(calls[0].url.includes('since=100'));
});

test('readFile: uses the unambiguous 3-part filename grammar for a folder path', async (t) => {
  const baseDir = tmpBaseDir();
  setCredential(baseDir, 'https://folderfoo.example.com', 'jwt-1');
  const { fn, calls } = mockFetch([{ status: 200, body: 'file content', isText: true }]);
  t.mock.method(globalThis, 'fetch', fn);

  const content = await readFile('https://folderfoo.example.com', baseDir, 't1', 'work', 'notes.md');
  assert.equal(content, 'file content');
  assert.ok(calls[0].url.endsWith('/data/:work:notes.md'), calls[0].url);
});

test('readFile: no folder path addresses the bare filename directly', async (t) => {
  const baseDir = tmpBaseDir();
  setCredential(baseDir, 'https://folderfoo.example.com', 'jwt-1');
  const { fn, calls } = mockFetch([{ status: 200, body: 'root content', isText: true }]);
  t.mock.method(globalThis, 'fetch', fn);

  await readFile('https://folderfoo.example.com', baseDir, 't1', '', 'notes.md');
  assert.ok(calls[0].url.endsWith('/data/notes.md'));
});

test('writeFile: POSTs the content as the request body with a markdown content-type', async (t) => {
  const baseDir = tmpBaseDir();
  setCredential(baseDir, 'https://folderfoo.example.com', 'jwt-1');
  const { fn, calls } = mockFetch([{ status: 200, body: { message: 'saved' } }]);
  t.mock.method(globalThis, 'fetch', fn);

  await writeFile('https://folderfoo.example.com', baseDir, 't1', 'work', 'notes.md', '# hello');
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(calls[0].init?.body, '# hello');
  assert.equal((calls[0].init?.headers as Record<string, string>)['content-type'], 'text/markdown');
});
