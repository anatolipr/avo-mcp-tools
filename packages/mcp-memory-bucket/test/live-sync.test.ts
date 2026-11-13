import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setCredential } from '../src/remote/credentials.js';
import { watchFolderChanges, FolderfooRequestError } from '../src/remote/folderfoo-client.js';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

test('watchFolderChanges: parses SSE events split across chunks and skips pings', async (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-live-sync-test-'));
  setCredential(baseDir, 'https://ff.example.com', 'jwt-1');
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    calls.push(url);
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer jwt-1');
    return {
      ok: true,
      status: 200,
      statusText: '200',
      body: streamOf(['data: {"folderPath":"skills","lastChanged":5}\n\n: ping\n\nda', 'ta: {"lastChanged":9,"changedPath":"skills/x"}\n\n']),
    } as unknown as Response;
  });
  const seen: number[] = [];
  await watchFolderChanges('https://ff.example.com', baseDir, 'membkt', 'skills', '@acme', (n) => seen.push(n), new AbortController().signal);
  assert.deepEqual(seen, [5, 9]);
  assert.match(calls[0], /\/folders\/changes\?folderPath=skills&owner=%40acme$/);
});

test('watchFolderChanges: a server without the stream rejects with 404', async (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-live-sync-test-'));
  setCredential(baseDir, 'https://ff.example.com', 'jwt-1');
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({ error: 'Not Found' }) }) as unknown as Response);
  await assert.rejects(
    watchFolderChanges('https://ff.example.com', baseDir, 'membkt', 'skills', undefined, () => {}, new AbortController().signal),
    (err: unknown) => err instanceof FolderfooRequestError && err.status === 404
  );
});
