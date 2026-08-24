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
import { setCredential } from '../src/remote/credentials.js';
import { startRemotePolling, type RemotePollerHandle } from '../src/remote/remote-sync.js';
import { mirrorDirFor, type BucketConfig, type RemoteFolder } from '../src/config.js';
import type { TableSyncSpec } from '../src/store/sync.js';
import { IdentityTracker } from '../src/remote/identity.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

async function startTestServer(
  memoryRepo: MemoryRepository,
  skillRepo: SkillRepository,
  db: ReturnType<typeof openCache>,
  config: BucketConfig,
  memorySpec: TableSyncSpec<any>,
  skillSpec: TableSyncSpec<any>,
  remotePollers?: { skill?: RemotePollerHandle; memory?: RemotePollerHandle }
) {
  const app = express();
  app.use(express.json());
  app.use(buildWebRouter(db, config, skillRepo, memoryRepo, skillSpec, memorySpec, new IdentityTracker('dev'), remotePollers));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, baseUrl: `http://localhost:${port}` };
}

test('POST /api/remote-folders/resync-all: force-resyncs a memory remote source and reconciles a deletion without waiting for the watermark', async (t) => {
  const credsDir = tmpDir('mb-resync-all-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const memoryRepo = new MemoryRepository(db, [], [], credsDir);
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }], [], credsDir);

  const mirrorDir = mirrorDirFor(credsDir, 'dev', 'testuser', 'memz');
  const remote: RemoteFolder = { name: 'memz', server: 'https://folderfoo.example.com', tenantId: 'membkt', folderPath: 'memz', mirrorDir, mode: 'dev', username: 'testuser' };
  memoryRepo.registerRemoteFolder(remote);

  // Seed the mirror with a file already indexed, as if a prior poll had pulled it.
  fs.mkdirSync(mirrorDir, { recursive: true });
  const filePath = path.join(mirrorDir, 'doomed.md');
  fs.writeFileSync(filePath, '---\nid: doomed\nkey: doomed\ndescription: D\n---\nbody');
  const memorySpec = memorySyncSpec([{ name: 'memz', path: mirrorDir }]);
  const { initialScan } = await import('../src/store/sync.js');
  initialScan(db, memorySpec);
  assert.ok(fs.existsSync(filePath));

  // Mock fetch so the poller sees an empty remote listing (the file was deleted on folderfoo),
  // with last-changed reporting the SAME value the local watermark already has - the scenario
  // where a plain (non-forced) poll would cheap-skip and miss the deletion. Only intercepts
  // calls to the fake folderfoo origin - the test's own calls into the local test server (a
  // real localhost port) must pass through to the real fetch implementation.
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('/folders/last-changed')) return { ok: true, status: 200, json: async () => ({ lastChanged: 0 }) } as Response;
    if (url.includes('/folders/changed-since')) return { ok: true, status: 200, json: async () => ({ files: [], serverTime: Date.now() }) } as Response;
    return realFetch(url, init);
  });

  const skillSpec = skillSyncSpec([{ name: 'builtin', path: '/nonexistent' }]);
  const memoryPoller = startRemotePolling(db, memorySpec, [remote], credsDir);
  const config = fakeConfig(credsDir);
  const { server, baseUrl } = await startTestServer(memoryRepo, skillRepo, db, config, memorySpec, skillSpec, { memory: memoryPoller });
  try {
    const res = await fetch(`${baseUrl}/api/remote-folders/resync-all`, { method: 'POST' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.resynced, true);

    assert.ok(!fs.existsSync(filePath), 'the stale mirror file must be gone after a forced resync-all');
    const row = db.prepare(`SELECT * FROM memory_docs WHERE id = ?`).get('doomed');
    assert.equal(row, undefined);
  } finally {
    memoryPoller.stop();
    server.close();
  }
});

test('POST /api/remote-folders/resync-all: succeeds as a no-op when no remote pollers are configured', async () => {
  const credsDir = tmpDir('mb-resync-all-');
  const db = openCache(':memory:');
  const memoryRepo = new MemoryRepository(db, [], [], credsDir);
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }], [], credsDir);
  const config = fakeConfig(credsDir);
  const memorySpec = memorySyncSpec([]);
  const skillSpec = skillSyncSpec([{ name: 'builtin', path: '/nonexistent' }]);

  const { server, baseUrl } = await startTestServer(memoryRepo, skillRepo, db, config, memorySpec, skillSpec);
  try {
    const res = await fetch(`${baseUrl}/api/remote-folders/resync-all`, { method: 'POST' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.resynced, true);
  } finally {
    server.close();
  }
});
