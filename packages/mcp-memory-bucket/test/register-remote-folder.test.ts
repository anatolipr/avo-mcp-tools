import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCache } from '../src/store/db.js';
import { memorySyncSpec } from '../src/store/sync.js';
import { MemoryRepository } from '../src/memory/repository.js';
import { SkillRepository } from '../src/skills/repository.js';
import { setCredential } from '../src/remote/credentials.js';
import { pollOne } from '../src/remote/remote-sync.js';
import { mirrorDirFor } from '../src/config.js';
import type { RemoteFolder } from '../src/config.js';
import { IdentityTracker } from '../src/remote/identity.js';

function loggedInIdentity(): IdentityTracker {
  const identity = new IdentityTracker('dev');
  identity.setUsername('testuser');
  return identity;
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mockFolderfoo(state: { lastChanged: number; files: Array<{ name: string; folderPath: string; mtime: number; content: string }> }) {
  return async (url: string) => {
    if (url.includes('/folders/last-changed')) {
      return { ok: true, status: 200, json: async () => ({ lastChanged: state.lastChanged }) } as Response;
    }
    if (url.includes('/folders/changed-since')) {
      const sinceMatch = url.match(/since=(\d+)/);
      const since = sinceMatch ? Number(sinceMatch[1]) : 0;
      const files = state.files.filter((f) => f.mtime > since).map((f) => ({ name: f.name, folderPath: f.folderPath, mtime: f.mtime }));
      return { ok: true, status: 200, json: async () => ({ files, serverTime: Date.now() }) } as Response;
    }
    if (url.includes('/data/')) {
      const found = state.files.find((f) => url.endsWith(`:${f.name}`) || url.endsWith(`/${f.name}`));
      return { ok: true, status: 200, text: async () => found?.content ?? '' } as Response;
    }
    throw new Error(`unexpected mocked fetch call: ${url}`);
  };
}

test('MemoryRepository.registerRemoteFolder: creates the mirror dir, registers it, and is findable via listFolders', async () => {
  const credsDir = tmpDir('mb-register-creds-');
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [], [], credsDir);

  const mirrorDir = mirrorDirFor(credsDir, 'dev', 'testuser', 'team-qa');
  const remote: RemoteFolder = { name: 'team-qa', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'plans', mirrorDir, mode: 'dev', username: 'testuser' };

  repo.registerRemoteFolder(remote);

  assert.ok(fs.existsSync(mirrorDir));
  assert.deepEqual(
    repo.listFolders().map((f) => f.name),
    ['team-qa']
  );
});

test('MemoryRepository.listFoldersWithRemoteInfo: flags remote folders true, local folders false', () => {
  const credsDir = tmpDir('mb-register-creds-');
  const localDir = tmpDir('mb-local-');
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'local-notes', path: localDir }], [], credsDir, loggedInIdentity());

  const remote: RemoteFolder = {
    name: 'team-qa',
    server: 'https://folderfoo.example.com',
    tenantId: 't1',
    folderPath: 'plans',
    mirrorDir: mirrorDirFor(credsDir, 'dev', 'testuser', 'team-qa'),
    mode: 'dev',
    username: 'testuser',
  };
  repo.registerRemoteFolder(remote);

  const withInfo = repo.listFoldersWithRemoteInfo();
  assert.deepEqual(
    withInfo.map((f) => ({ name: f.name, remote: f.remote })).sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: 'local-notes', remote: false },
      { name: 'team-qa', remote: true },
    ]
  );
});

test('MemoryRepository.listFoldersWithRemoteInfo: a remote folder disappears on logout and reappears when the same user logs back in - no re-registration needed, the config-persisted stamp is enough', () => {
  const credsDir = tmpDir('mb-register-creds-');
  const db = openCache(':memory:');
  const identity = loggedInIdentity(); // mode 'dev', username 'testuser'
  const repo = new MemoryRepository(db, [], [], credsDir, identity);

  const remote: RemoteFolder = {
    name: 'team-qa',
    server: 'https://folderfoo.example.com',
    tenantId: 't1',
    folderPath: 'plans',
    mirrorDir: mirrorDirFor(credsDir, 'dev', 'testuser', 'team-qa'),
    mode: 'dev',
    username: 'testuser',
  };
  repo.registerRemoteFolder(remote);

  assert.deepEqual(
    repo.listFoldersWithRemoteInfo().map((f) => f.name),
    ['team-qa']
  );

  identity.clearUsername(); // simulates POST /api/folderfoo/logout
  assert.deepEqual(repo.listFoldersWithRemoteInfo(), [], 'remote folder must be hidden while logged out');

  identity.setUsername('testuser'); // simulates POST /api/folderfoo/login with the SAME user
  assert.deepEqual(
    repo.listFoldersWithRemoteInfo().map((f) => f.name),
    ['team-qa'],
    'the same folder must reappear on re-login, with no re-registration call'
  );

  identity.setUsername('someone-else'); // a DIFFERENT user logs in on the same server/mode
  assert.deepEqual(repo.listFoldersWithRemoteInfo(), [], 'a different user must not see the first user\'s remote folder');
});

test('SkillRepository.listFoldersWithRemoteInfo: flags remote folders true, local folders false, excludes builtin', () => {
  const credsDir = tmpDir('mb-register-creds-');
  const localDir = tmpDir('mb-local-');
  const db = openCache(':memory:');
  const repo = new SkillRepository(
    db,
    [{ name: 'builtin', path: '/nonexistent' }, { name: 'local-skills', path: localDir }],
    [],
    credsDir,
    loggedInIdentity()
  );

  const remote: RemoteFolder = {
    name: 'team-qa',
    server: 'https://folderfoo.example.com',
    tenantId: 't1',
    folderPath: 'skills',
    mirrorDir: mirrorDirFor(credsDir, 'dev', 'testuser', 'team-qa'),
    mode: 'dev',
    username: 'testuser',
  };
  repo.registerRemoteFolder(remote);

  const withInfo = repo.listFoldersWithRemoteInfo();
  assert.deepEqual(
    withInfo.map((f) => ({ name: f.name, remote: f.remote })).sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: 'local-skills', remote: false },
      { name: 'team-qa', remote: true },
    ]
  );
  assert.ok(!withInfo.some((f) => f.name === 'builtin'));
});

test('MemoryRepository.registerRemoteFolder: rejects a duplicate name', () => {
  const credsDir = tmpDir('mb-register-creds-');
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'existing', path: tmpDir('mb-existing-') }], [], credsDir);

  const remote: RemoteFolder = {
    name: 'existing',
    server: 'https://folderfoo.example.com',
    tenantId: 't1',
    folderPath: 'x',
    mirrorDir: mirrorDirFor(credsDir, 'dev', 'testuser', 'existing'),
    mode: 'dev',
    username: 'testuser',
  };
  assert.throws(() => repo.registerRemoteFolder(remote), /already exists/);
});

test('registerRemoteFolder followed by pollOne pulls remote content into the newly-registered folder (route-level flow)', async (t) => {
  const credsDir = tmpDir('mb-register-creds-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [], [], credsDir);

  const mirrorDir = mirrorDirFor(credsDir, 'dev', 'testuser', 'team-qa');
  const remote: RemoteFolder = { name: 'team-qa', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'plans', mirrorDir, mode: 'dev', username: 'testuser' };
  repo.registerRemoteFolder(remote);

  t.mock.method(
    globalThis,
    'fetch',
    mockFolderfoo({ lastChanged: 100, files: [{ name: 'roadmap.md', folderPath: 'plans', mtime: 100, content: '---\nkey: roadmap\ndescription: The roadmap\n---\nBody.' }] })
  );

  // Mirrors what the POST /api/remote-folders route does right after
  // registerRemoteFolder: one immediate poll so content shows up without
  // waiting for the first interval tick.
  await pollOne(db, memorySyncSpec(repo.listFolders()), remote, credsDir);

  const row = db.prepare(`SELECT description FROM memory_docs WHERE source_path = ?`).get(path.join(mirrorDir, 'roadmap.md')) as { description: string } | undefined;
  assert.equal(row?.description, 'The roadmap');
});

test('MemoryRepository.removeFolder: on a remote folder, also drops the RemoteFolder entry and deletes its mirror dir - a same-named local folder added afterwards must not be mistaken for the old remote connection', () => {
  const credsDir = tmpDir('mb-register-creds-');
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [], [], credsDir);

  const mirrorDir = mirrorDirFor(credsDir, 'dev', 'testuser', 'team-qa');
  const remote: RemoteFolder = { name: 'team-qa', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'plans', mirrorDir, mode: 'dev', username: 'testuser' };
  repo.registerRemoteFolder(remote);
  assert.ok(fs.existsSync(mirrorDir));
  assert.equal(repo.listRemoteFolders().length, 1);

  repo.removeFolder('team-qa');

  assert.equal(repo.listRemoteFolders().length, 0, 'stale RemoteFolder entry must not survive removal');
  assert.ok(!fs.existsSync(mirrorDir), 'mirror cache dir must be deleted on removal');

  // Re-adding "team-qa" as a plain LOCAL folder must behave as local, not
  // silently inherit the removed remote's folderfoo coordinates.
  const localDir = tmpDir('mb-local-');
  repo.addFolder({ name: 'team-qa', path: localDir });
  assert.deepEqual(repo.listFoldersWithRemoteInfo().map((f) => ({ name: f.name, remote: f.remote })), [{ name: 'team-qa', remote: false }]);
});

test('SkillRepository.registerRemoteFolder: creates the mirror dir under builtin+remote folders', () => {
  const credsDir = tmpDir('mb-register-creds-');
  const db = openCache(':memory:');
  const repo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }], [], credsDir);

  const mirrorDir = mirrorDirFor(credsDir, 'dev', 'testuser', 'team-qa');
  const remote: RemoteFolder = { name: 'team-qa', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'skills', mirrorDir, mode: 'dev', username: 'testuser' };
  repo.registerRemoteFolder(remote);

  assert.ok(fs.existsSync(mirrorDir));
  assert.deepEqual(
    repo.listFolders().map((f) => f.name),
    ['team-qa']
  );
});
