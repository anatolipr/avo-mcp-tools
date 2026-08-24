import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { openCache } from '../src/store/db.js';
import { memorySyncSpec, skillSyncSpec } from '../src/store/sync.js';
import { MemoryRepository } from '../src/memory/repository.js';
import { SkillRepository } from '../src/skills/repository.js';
import { buildWebRouter } from '../src/web/routes.js';
import { mirrorDirFor, type BucketConfig, type RemoteFolder } from '../src/config.js';
import type { TableSyncSpec } from '../src/store/sync.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startTestServer(memoryRepo: MemoryRepository, skillRepo: SkillRepository, db: ReturnType<typeof openCache>, config: BucketConfig, memorySpec: TableSyncSpec<any>, skillSpec: TableSyncSpec<any>) {
  const app = express();
  app.use(express.json());
  app.use(buildWebRouter(db, config, skillRepo, memoryRepo, skillSpec, memorySpec));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, baseUrl: `http://localhost:${port}` };
}

function fakeConfig(baseDir: string): BucketConfig {
  return {
    skillFolders: [],
    memoryFolders: [],
    remoteSkillFolders: [],
    remoteMemoryFolders: [],
    cacheDbPath: path.join(baseDir, '.memory-bucket-cache.sqlite'),
    configPath: path.join(baseDir, 'memory-bucket.config.json'),
    baseDir,
    folderfooMode: 'dev',
    folderfooHost: 'https://folderfoo.example.com',
  };
}

test('POST /api/folderfoo/resolve-open: finds a memory doc opened from the root of a connected remote folder', async () => {
  const credsDir = tmpDir('mb-resolve-open-');
  const db = openCache(':memory:');
  const memoryRepo = new MemoryRepository(db, [], [], credsDir);
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }], [], credsDir);

  const mirrorDir = mirrorDirFor(credsDir, 'memz');
  const remote: RemoteFolder = { name: 'memz', server: 'https://folderfoo.example.com', tenantId: 'membkt', folderPath: 'memz', mirrorDir };
  memoryRepo.registerRemoteFolder(remote);

  // Write the mirror file directly + index it (no live network call needed for this test).
  fs.mkdirSync(mirrorDir, { recursive: true });
  const filePath = path.join(mirrorDir, 'ideaz-ideas-list-abc123.md');
  fs.writeFileSync(filePath, '---\nid: ideaz-ideas-list-abc123\nkey: IDEAZ\ndescription: Ideas\n---\nBody.\n');
  const spec = memorySyncSpec([{ name: 'memz', path: mirrorDir }]);
  const { initialScan } = await import('../src/store/sync.js');
  initialScan(db, spec);

  const config = fakeConfig(credsDir);
  const skillSpec = skillSyncSpec([{ name: 'builtin', path: '/nonexistent' }]);
  const { server, baseUrl } = await startTestServer(memoryRepo, skillRepo, db, config, spec, skillSpec);
  try {
    const res = await fetch(`${baseUrl}/api/folderfoo/resolve-open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server: 'https://folderfoo.example.com', tenantId: 'membkt', folderPath: 'memz', name: 'ideaz-ideas-list-abc123' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.table, 'memory_docs');
    assert.equal(data.id, 'ideaz-ideas-list-abc123');
  } finally {
    server.close();
  }
});

test('POST /api/folderfoo/resolve-open: finds a doc opened from a subfolder nested inside the connected remote folder', async () => {
  const credsDir = tmpDir('mb-resolve-open-');
  const db = openCache(':memory:');
  const memoryRepo = new MemoryRepository(db, [], [], credsDir);
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }], [], credsDir);

  const mirrorDir = mirrorDirFor(credsDir, 'memz');
  const remote: RemoteFolder = { name: 'memz', server: 'https://folderfoo.example.com', tenantId: 'membkt', folderPath: 'memz', mirrorDir };
  memoryRepo.registerRemoteFolder(remote);

  fs.mkdirSync(path.join(mirrorDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(mirrorDir, 'sub', 'nested-doc.md'), '---\nid: nested-doc\nkey: NESTED\ndescription: Nested\n---\nBody.\n');
  const spec = memorySyncSpec([{ name: 'memz', path: mirrorDir }]);
  const { initialScan } = await import('../src/store/sync.js');
  initialScan(db, spec);

  const config = fakeConfig(credsDir);
  const skillSpec = skillSyncSpec([{ name: 'builtin', path: '/nonexistent' }]);
  const { server, baseUrl } = await startTestServer(memoryRepo, skillRepo, db, config, spec, skillSpec);
  try {
    // folderfoo's own File Open would report the folder as "memz/sub" (its
    // absolute-from-tenant-root path), not just "sub".
    const res = await fetch(`${baseUrl}/api/folderfoo/resolve-open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server: 'https://folderfoo.example.com', tenantId: 'membkt', folderPath: 'memz/sub', name: 'nested-doc' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.id, 'nested-doc');
  } finally {
    server.close();
  }
});

test('POST /api/folderfoo/resolve-open: 404s clearly when the folder is not connected as a remote source', async () => {
  const credsDir = tmpDir('mb-resolve-open-');
  const db = openCache(':memory:');
  const memoryRepo = new MemoryRepository(db, [], [], credsDir);
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }], [], credsDir);

  const config = fakeConfig(credsDir);
  const memorySpec = memorySyncSpec([]);
  const skillSpec = skillSyncSpec([{ name: 'builtin', path: '/nonexistent' }]);
  const { server, baseUrl } = await startTestServer(memoryRepo, skillRepo, db, config, memorySpec, skillSpec);
  try {
    const res = await fetch(`${baseUrl}/api/folderfoo/resolve-open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server: 'https://folderfoo.example.com', tenantId: 'membkt', folderPath: 'unconnected-folder', name: 'whatever' }),
    });
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.match(data.error, /isn't connected/);
  } finally {
    server.close();
  }
});

test('POST /api/folderfoo/resolve-open: matches the connected source but no cache row yet reports a distinct message', async () => {
  const credsDir = tmpDir('mb-resolve-open-');
  const db = openCache(':memory:');
  const memoryRepo = new MemoryRepository(db, [], [], credsDir);
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }], [], credsDir);

  const mirrorDir = mirrorDirFor(credsDir, 'memz');
  const remote: RemoteFolder = { name: 'memz', server: 'https://folderfoo.example.com', tenantId: 'membkt', folderPath: 'memz', mirrorDir };
  memoryRepo.registerRemoteFolder(remote);
  // No file written/indexed - simulates the poller not having caught up yet.

  const config = fakeConfig(credsDir);
  const spec = memorySyncSpec([{ name: 'memz', path: mirrorDir }]);
  const skillSpec = skillSyncSpec([{ name: 'builtin', path: '/nonexistent' }]);
  const { server, baseUrl } = await startTestServer(memoryRepo, skillRepo, db, config, spec, skillSpec);
  try {
    const res = await fetch(`${baseUrl}/api/folderfoo/resolve-open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server: 'https://folderfoo.example.com', tenantId: 'membkt', folderPath: 'memz', name: 'not-yet-cached' }),
    });
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.match(data.error, /no cached doc found/);
  } finally {
    server.close();
  }
});
