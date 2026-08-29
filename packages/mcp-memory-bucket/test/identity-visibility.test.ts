import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { openCache } from '../src/store/db.js';
import { memorySyncSpec, skillSyncSpec, initialScan } from '../src/store/sync.js';
import { MemoryRepository } from '../src/memory/repository.js';
import { SkillRepository } from '../src/skills/repository.js';
import { buildWebRouter } from '../src/web/routes.js';
import { mirrorDirFor, type BucketConfig, type RemoteFolder } from '../src/config.js';
import { IdentityTracker } from '../src/remote/identity.js';

// Regression coverage for a real bug: MemoryRepository/SkillRepository's own get()/search()/
// getByKey() correctly hide a remote folder connected under a DIFFERENT identity than the one
// currently logged in (see remote/identity.ts's isFolderVisible) - but the web UI's list/detail/
// attachment routes in routes.ts query sqlite directly rather than going through those repository
// methods, so they never applied that filter. A remote folder connected under user A's login would
// stay visible in the web UI's list/detail/attachment-download views even after logging out or
// logging in as a different user B - a real cross-user data leak. Mutation routes (update/delete/
// rename/etc.) were already safe, since they all delegate to repository methods that call get()
// internally.

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
  memorySpec: ReturnType<typeof memorySyncSpec>,
  skillSpec: ReturnType<typeof skillSyncSpec>,
  identity: IdentityTracker
) {
  const app = express();
  app.use(express.json());
  app.use(buildWebRouter(db, config, skillRepo, memoryRepo, skillSpec, memorySpec, identity));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, baseUrl: `http://localhost:${port}` };
}

test('web UI list/detail/attachment routes hide a remote folder connected under a DIFFERENT identity than the one currently logged in', async () => {
  const credsDir = tmpDir('mb-identity-vis-');
  const db = openCache(':memory:');
  const identity = new IdentityTracker('dev');
  const memoryRepo = new MemoryRepository(db, [], [], credsDir, identity);
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }], [], credsDir, identity);

  // Register a remote folder as if user "alice" had connected it, then write+index a doc into its
  // mirror directly (no live network call needed for this test).
  const mirrorDir = mirrorDirFor(credsDir, 'dev', 'alice', 'alice-personal');
  const remote: RemoteFolder = {
    name: 'alice-personal',
    server: 'https://folderfoo.example.com',
    tenantId: 't1',
    folderPath: 'alice-personal',
    mirrorDir,
    mode: 'dev',
    username: 'alice',
  };
  memoryRepo.registerRemoteFolder(remote);

  fs.mkdirSync(mirrorDir, { recursive: true });
  const filePath = path.join(mirrorDir, 'alices-secret-plan.md');
  fs.writeFileSync(filePath, '---\nkey: ALICE-PLAN\ndescription: Alice private plan\n---\nSensitive body content.\n');
  const spec = memorySyncSpec([{ name: 'alice-personal', path: mirrorDir }]);
  initialScan(db, spec);

  const config = fakeConfig(credsDir);
  const skillSpec = skillSyncSpec([{ name: 'builtin', path: '/nonexistent' }]);
  const { server, baseUrl } = await startTestServer(memoryRepo, skillRepo, db, config, spec, skillSpec, identity);

  try {
    // Case 1: nobody logged in at all (fresh start / logged out) - Alice's folder must be invisible.
    identity.clearUsername();
    const listRes1 = await fetch(`${baseUrl}/api/entries?type=memory`);
    const list1 = (await listRes1.json()) as Array<{ id: string }>;
    assert.ok(!list1.some((e) => e.id === filePath), 'list must not include a doc from a folder connected under a different/no identity');

    const detailRes1 = await fetch(`${baseUrl}/api/entries/memory_docs/${encodeURIComponent(filePath)}`);
    assert.equal(detailRes1.status, 404, 'detail GET for a doc in an invisible folder must 404, not leak content');

    // Case 2: logged in as a DIFFERENT user ("bob") - still must not see alice's folder.
    identity.setUsername('bob');
    const listRes2 = await fetch(`${baseUrl}/api/entries?type=memory`);
    const list2 = (await listRes2.json()) as Array<{ id: string }>;
    assert.ok(!list2.some((e) => e.id === filePath), 'list must not include another user\'s folder even while a DIFFERENT user is logged in');

    const detailRes2 = await fetch(`${baseUrl}/api/entries/memory_docs/${encodeURIComponent(filePath)}`);
    assert.equal(detailRes2.status, 404, 'detail GET must 404 for a doc in another user\'s folder');

    // Case 3: logged in as the MATCHING user ("alice") - the folder becomes visible again.
    identity.setUsername('alice');
    const listRes3 = await fetch(`${baseUrl}/api/entries?type=memory`);
    const list3 = (await listRes3.json()) as Array<{ id: string }>;
    assert.ok(list3.some((e) => e.id === filePath), 'list must include the doc once the matching identity is logged in');

    const detailRes3 = await fetch(`${baseUrl}/api/entries/memory_docs/${encodeURIComponent(filePath)}`);
    assert.equal(detailRes3.status, 200, 'detail GET must succeed once the matching identity is logged in');
    const detail3 = await detailRes3.json();
    assert.equal(detail3.key, 'ALICE-PLAN');
  } finally {
    server.close();
  }
});
