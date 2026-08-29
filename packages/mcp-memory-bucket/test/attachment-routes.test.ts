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
import { AttachmentRepository } from '../src/attachments/repository.js';
import { buildWebRouter } from '../src/web/routes.js';
import { mirrorDirFor, type BucketConfig } from '../src/config.js';
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

async function startTestServer(withAttachments: boolean) {
  const credsDir = tmpDir('mb-attach-routes-creds-');
  const mirrorDir = mirrorDirFor(credsDir, 'dev', 'testuser', 'mem');
  fs.mkdirSync(mirrorDir, { recursive: true });
  const db = openCache(':memory:');
  const memoryRepo = new MemoryRepository(db, [{ name: 'mem', path: mirrorDir }], [], credsDir);
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }], [], credsDir);
  const attachRepo = withAttachments ? new AttachmentRepository(memoryRepo, skillRepo) : undefined;
  const memorySpec = memorySyncSpec([{ name: 'mem', path: mirrorDir }]);
  const skillSpec = skillSyncSpec([{ name: 'builtin', path: '/nonexistent' }]);
  const config = fakeConfig(credsDir);

  const app = express();
  app.use(express.json());
  app.use(buildWebRouter(db, config, skillRepo, memoryRepo, skillSpec, memorySpec, new IdentityTracker('dev'), undefined, attachRepo));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, baseUrl: `http://localhost:${port}`, db, memoryRepo, attachRepo, memorySpec, mirrorDir };
}

async function createMemoryDoc(memoryRepo: MemoryRepository, filename: string) {
  return memoryRepo.create({ filename, key: filename.toUpperCase(), key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
}

test('POST /api/entries/:table/:id/attachments: uploads a new attachment and returns its entry', async (t) => {
  const { server, baseUrl, memoryRepo, memorySpec, db } = await startTestServer(true);
  try {
    const doc = await createMemoryDoc(memoryRepo, 'test-upload');
    initialScan(db, memorySpec);
    const id = doc.source_path;

    const res = await fetch(`${baseUrl}/api/entries/memory_docs/${encodeURIComponent(id)}/attachments?filename=notes.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('{"a":1}'),
    });
    assert.equal(res.status, 200);
    const entry = await res.json();
    assert.equal(entry.filename, 'notes.json');

    const updated = await memoryRepo.get('mem', path.basename(id));
    assert.deepEqual(updated?.attachments, [entry]);
  } finally {
    server.close();
  }
});

test('POST /api/entries/:table/:id/attachments: 501s when no AttachmentRepository is wired', async (t) => {
  const { server, baseUrl, memoryRepo, memorySpec, db } = await startTestServer(false);
  try {
    const doc = await createMemoryDoc(memoryRepo, 'test-no-repo');
    initialScan(db, memorySpec);

    const res = await fetch(`${baseUrl}/api/entries/memory_docs/${encodeURIComponent(doc.source_path)}/attachments?filename=notes.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('{}'),
    });
    assert.equal(res.status, 501);
  } finally {
    server.close();
  }
});

test('POST /api/entries/:table/:id/attachments: 400s without a ?filename= query param', async (t) => {
  const { server, baseUrl, memoryRepo, memorySpec, db } = await startTestServer(true);
  try {
    const doc = await createMemoryDoc(memoryRepo, 'test-no-filename');
    initialScan(db, memorySpec);

    const res = await fetch(`${baseUrl}/api/entries/memory_docs/${encodeURIComponent(doc.source_path)}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('{}'),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('DELETE /api/entries/:table/:id/attachments/:filename: removes a declared attachment', async (t) => {
  const { server, baseUrl, memoryRepo, attachRepo, memorySpec, db } = await startTestServer(true);
  try {
    const doc = await createMemoryDoc(memoryRepo, 'test-delete');
    initialScan(db, memorySpec);
    const id = doc.source_path;

    await attachRepo!.add('memory', 'mem', path.basename(id), 'notes.json', Buffer.from('{}'));
    let updated = await memoryRepo.get('mem', path.basename(id));
    assert.equal(updated?.attachments?.length, 1);

    const res = await fetch(`${baseUrl}/api/entries/memory_docs/${encodeURIComponent(id)}/attachments/notes.json`, { method: 'DELETE' });
    assert.equal(res.status, 200);

    updated = await memoryRepo.get('mem', path.basename(id));
    assert.equal(updated?.attachments?.length ?? 0, 0);
  } finally {
    server.close();
  }
});

test('DELETE /api/entries/:table/:id/attachments/:filename: 501s when no AttachmentRepository is wired', async (t) => {
  const { server, baseUrl, memoryRepo, memorySpec, db } = await startTestServer(false);
  try {
    const doc = await createMemoryDoc(memoryRepo, 'test-delete-no-repo');
    initialScan(db, memorySpec);

    const res = await fetch(`${baseUrl}/api/entries/memory_docs/${encodeURIComponent(doc.source_path)}/attachments/notes.json`, { method: 'DELETE' });
    assert.equal(res.status, 501);
  } finally {
    server.close();
  }
});
