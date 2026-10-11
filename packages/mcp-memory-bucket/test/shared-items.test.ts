import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openCache } from '../src/store/db.js';
import { memorySyncSpec, skillSyncSpec, initialScan } from '../src/store/sync.js';
import { setCredential } from '../src/remote/credentials.js';
import {
  addSharedItem,
  refreshSharedItems,
  syncSharedItemsIndex,
  listSharedItems,
  resolveShareTarget,
  getForkableSharedItem,
  sharedFolderName,
} from '../src/remote/shared-items.js';
import { MemoryRepository } from '../src/memory/repository.js';
import { SkillRepository } from '../src/skills/repository.js';
import type { RemoteFolder } from '../src/config.js';

const SERVER = 'https://folderfoo.example.com';
const TENANT = 't1';
const ORIGIN_A = '11111111-1111-4111-8111-111111111111';
const ORIGIN_B = '22222222-2222-4222-8222-222222222222';
const ORIGIN_PUBLIC = '33333333-3333-4333-8333-333333333333';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface SharedFile {
  name: string;
  owner: string;
  originId: string;
  kind: 'memory' | 'skill';
  role?: 'member' | 'editor';
  modifiedAt: string;
  content: string;
}

// Fakes the folderfoo endpoints shared-items.ts calls: GET /shared-with-me, the owner-addressed
// GET /data/<owner>:<folder>:<name>, and the login-free GET /public/<token>. The real
// folderfoo-client.ts and shared-items.ts run unmodified; only global fetch is faked.
function mockFolderfoo(state: { shared: SharedFile[]; publicLinks?: Record<string, string>; sharedWithMeStatus?: number }) {
  const dataReads: string[] = [];
  const fetchImpl = async (url: string) => {
    if (url.endsWith('/shared-with-me')) {
      if (state.sharedWithMeStatus) return { ok: false, status: state.sharedWithMeStatus, statusText: 'err', json: async () => ({}) } as Response;
      const body = state.shared.map(({ content: _content, ...entry }) => ({ type: 'file', size: 1, createdAt: entry.modifiedAt, role: 'member', ...entry }));
      return { ok: true, status: 200, json: async () => body } as Response;
    }
    if (url.includes('/public/')) {
      const token = decodeURIComponent(url.split('/public/')[1]!);
      const content = state.publicLinks?.[token];
      if (content === undefined) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({ error: 'Invalid or expired link' }) } as Response;
      return { ok: true, status: 200, json: async () => ({ content, owner: 'pat', path: 'memz/pub.md', type: 'file', originId: ORIGIN_PUBLIC, kind: 'memory' }) } as Response;
    }
    if (url.includes('/data/')) {
      dataReads.push(url);
      const [owner, folder, name] = decodeURIComponent(url.split('/data/')[1]!).split(':');
      const found = state.shared.find((f) => f.owner === owner && f.name === (folder ? `${folder}/${name}` : name));
      if (!found) return { ok: false, status: 403, statusText: 'Forbidden', json: async () => ({ error: 'You do not have access to this file' }) } as Response;
      return { ok: true, status: 200, text: async () => found.content } as Response;
    }
    throw new Error(`unexpected mocked fetch call: ${url}`);
  };
  return { fetchImpl, dataReads };
}

function setup() {
  const baseDir = tmpDir('mb-shared-items-');
  setCredential(baseDir, SERVER, 'jwt-1');
  const db = openCache(':memory:');
  return { baseDir, db, skillSpec: skillSyncSpec([]), memorySpec: memorySyncSpec([]) };
}

const memoryDoc = (body: string) => `---\nkey: SHARED\nkey_type: freeform\ndescription: shared doc\ndoc_type: plan\ntags: []\nstatus: active\n---\n${body}\n`;
const skillDoc = (name: string, body: string) => `---\nname: ${name}\ndescription: shared skill\n---\n${body}\n`;

function isIndexed(db: Database.Database, table: 'skills' | 'memory_docs', folder: string): boolean {
  return !!db.prepare(`SELECT 1 FROM ${table} WHERE folder = ?`).get(folder);
}

test('refresh discovers a direct share of a nested doc, reads it by folder+name, and files it paused under shared-by-<owner>', async (t) => {
  const { baseDir, db, skillSpec, memorySpec } = setup();
  const state = { shared: [{ name: 'memz/notes.md', owner: 'bob', originId: ORIGIN_A, kind: 'memory' as const, modifiedAt: '2026-01-01T00:00:00.000Z', content: memoryDoc('v1') }] };
  const { fetchImpl, dataReads } = mockFolderfoo(state);
  t.mock.method(globalThis, 'fetch', fetchImpl);

  const summary = await refreshSharedItems(db, baseDir, skillSpec, memorySpec, [{ server: SERVER, tenantId: TENANT }], 'alice');
  assert.deepEqual({ added: summary.added, errors: summary.errors }, { added: 1, errors: [] });
  assert.match(dataReads[0]!, /\/data\/bob:memz:notes\.md$/);

  const [item] = listSharedItems(db, 'alice');
  assert.equal(item!.folder, sharedFolderName('bob'));
  assert.equal(item!.paused, true);

  // Already current: a second refresh must not refetch the content.
  const again = await refreshSharedItems(db, baseDir, skillSpec, memorySpec, [{ server: SERVER, tenantId: TENANT }], 'alice');
  assert.equal(again.unchanged, 1);
  assert.equal(dataReads.length, 1);
});

test('refresh picks up a role change and an owner-side rename even when modifiedAt did not move', async (t) => {
  const { baseDir, db, skillSpec, memorySpec } = setup();
  const state = { shared: [{ name: 'memz/notes.md', owner: 'bob', originId: ORIGIN_A, kind: 'memory' as const, role: 'member' as const, modifiedAt: '2026-01-01T00:00:00.000Z', content: memoryDoc('v1') }] };
  t.mock.method(globalThis, 'fetch', mockFolderfoo(state).fetchImpl);
  const servers = [{ server: SERVER, tenantId: TENANT }];
  await refreshSharedItems(db, baseDir, skillSpec, memorySpec, servers, 'alice');

  state.shared[0]!.role = 'editor';
  state.shared[0]!.name = 'memz/renamed.md';
  const summary = await refreshSharedItems(db, baseDir, skillSpec, memorySpec, servers, 'alice');
  assert.equal(summary.unchanged, 1);
  const [item] = listSharedItems(db, 'alice');
  assert.equal(item!.role, 'editor');
  assert.equal(item!.remote_path, 'memz/renamed.md');
});

test("another login's refresh neither sees nor revokes the first login's shared items", async (t) => {
  const { baseDir, db, skillSpec, memorySpec } = setup();
  const state = { shared: [{ name: 'notes.md', owner: 'bob', originId: ORIGIN_A, kind: 'memory' as const, modifiedAt: '2026-01-01T00:00:00.000Z', content: memoryDoc('v1') }] };
  t.mock.method(globalThis, 'fetch', mockFolderfoo(state).fetchImpl);
  const servers = [{ server: SERVER, tenantId: TENANT }];
  await refreshSharedItems(db, baseDir, skillSpec, memorySpec, servers, 'alice');

  // carol logs in: nothing is shared with her.
  state.shared = [];
  syncSharedItemsIndex(db, skillSpec, memorySpec, 'carol');
  const carolSummary = await refreshSharedItems(db, baseDir, skillSpec, memorySpec, servers, 'carol');
  assert.equal(carolSummary.revoked, 0);
  assert.deepEqual(listSharedItems(db, 'carol'), []);
  assert.equal(isIndexed(db, 'memory_docs', sharedFolderName('bob')), false);

  // alice logs back in: her item is still active and indexed again.
  syncSharedItemsIndex(db, skillSpec, memorySpec, 'alice');
  assert.equal(listSharedItems(db, 'alice')[0]!.status, 'active');
  assert.equal(isIndexed(db, 'memory_docs', sharedFolderName('bob')), true);
});

test('a failed refresh reports the error instead of an empty "nothing new" summary, and revokes nothing', async (t) => {
  const { baseDir, db, skillSpec, memorySpec } = setup();
  const state: { shared: SharedFile[]; sharedWithMeStatus?: number } = {
    shared: [{ name: 'notes.md', owner: 'bob', originId: ORIGIN_A, kind: 'memory', modifiedAt: '2026-01-01T00:00:00.000Z', content: memoryDoc('v1') }],
  };
  t.mock.method(globalThis, 'fetch', mockFolderfoo(state).fetchImpl);
  const servers = [{ server: SERVER, tenantId: TENANT }];
  await refreshSharedItems(db, baseDir, skillSpec, memorySpec, servers, 'alice');

  state.sharedWithMeStatus = 500;
  const summary = await refreshSharedItems(db, baseDir, skillSpec, memorySpec, servers, 'alice');
  assert.equal(summary.errors.length, 1);
  assert.equal(summary.revoked, 0);
  assert.equal(listSharedItems(db, 'alice')[0]!.status, 'active');
});

test('a cache rebuild followed by syncSharedItemsIndex keeps shared items searchable', async (t) => {
  const { baseDir, db, skillSpec, memorySpec } = setup();
  const state = { shared: [{ name: 'notes.md', owner: 'bob', originId: ORIGIN_A, kind: 'memory' as const, modifiedAt: '2026-01-01T00:00:00.000Z', content: memoryDoc('v1') }] };
  t.mock.method(globalThis, 'fetch', mockFolderfoo(state).fetchImpl);
  await refreshSharedItems(db, baseDir, skillSpec, memorySpec, [{ server: SERVER, tenantId: TENANT }], 'alice');

  db.exec(`DELETE FROM skills; DELETE FROM memory_docs; DELETE FROM search_index; DELETE FROM doc_dates;`);
  initialScan(db, memorySpec);
  syncSharedItemsIndex(db, skillSpec, memorySpec, 'alice');
  assert.equal(isIndexed(db, 'memory_docs', sharedFolderName('bob')), true);
});

test('two shared skills with the same name from different owners are both indexed', async (t) => {
  const { baseDir, db, skillSpec, memorySpec } = setup();
  const state = {
    shared: [
      { name: 'skills/deploy/SKILL', owner: 'bob', originId: ORIGIN_A, kind: 'skill' as const, modifiedAt: '2026-01-01T00:00:00.000Z', content: skillDoc('deploy', 'bob version') },
      { name: 'skills/deploy/SKILL', owner: 'dana', originId: ORIGIN_B, kind: 'skill' as const, modifiedAt: '2026-01-01T00:00:00.000Z', content: skillDoc('deploy', 'dana version') },
    ],
  };
  t.mock.method(globalThis, 'fetch', mockFolderfoo(state).fetchImpl);
  const summary = await refreshSharedItems(db, baseDir, skillSpec, memorySpec, [{ server: SERVER, tenantId: TENANT }], 'alice');
  assert.equal(summary.added, 2);
  const folders = (db.prepare(`SELECT folder FROM skills WHERE id = 'deploy' ORDER BY folder`).all() as Array<{ folder: string }>).map((r) => r.folder);
  assert.deepEqual(folders, [sharedFolderName('bob'), sharedFolderName('dana')]);
});

test('a public-link item is read through its link, survives a refresh, and is revoked once the link 404s', async (t) => {
  const { baseDir, db, skillSpec, memorySpec } = setup();
  const state: { shared: SharedFile[]; publicLinks: Record<string, string> } = { shared: [], publicLinks: { 'pub.t1.tok': memoryDoc('public v1') } };
  const { fetchImpl, dataReads } = mockFolderfoo(state);
  t.mock.method(globalThis, 'fetch', fetchImpl);

  await addSharedItem(db, baseDir, skillSpec, memorySpec, {
    owner: 'pat', server: SERVER, tenantId: TENANT, path: 'memz/pub.md', originId: ORIGIN_PUBLIC, kind: 'memory', publicToken: 'pub.t1.tok',
  });
  assert.equal(dataReads.length, 0);

  // Visible with no login at all, and never exposes the token.
  const [item] = listSharedItems(db, null);
  assert.equal(item!.public, true);
  assert.equal('public_token' in item!, false);

  const servers = [{ server: SERVER, tenantId: TENANT }];
  assert.equal((await refreshSharedItems(db, baseDir, skillSpec, memorySpec, servers, 'alice')).unchanged, 1);

  state.publicLinks['pub.t1.tok'] = memoryDoc('public v2');
  assert.equal((await refreshSharedItems(db, baseDir, skillSpec, memorySpec, servers, null)).updated, 1);

  delete state.publicLinks['pub.t1.tok'];
  assert.equal((await refreshSharedItems(db, baseDir, skillSpec, memorySpec, servers, null)).revoked, 1);
  assert.equal(listSharedItems(db, null)[0]!.status, 'revoked');
  assert.ok('error' in getForkableSharedItem(db, ORIGIN_PUBLIC, null));
});

test('addSharedItem rejects an originId that is not a uuid', async (t) => {
  const { baseDir, db, skillSpec, memorySpec } = setup();
  t.mock.method(globalThis, 'fetch', mockFolderfoo({ shared: [] }).fetchImpl);
  await assert.rejects(
    addSharedItem(db, baseDir, skillSpec, memorySpec, { owner: 'bob', server: SERVER, tenantId: TENANT, path: 'notes.md', originId: '../../escape', kind: 'memory', username: 'alice' }),
    /invalid originId/
  );
});

test('a shared item is readable by its shared folder and rejects every write', async (t) => {
  const { baseDir, db, skillSpec, memorySpec } = setup();
  const state = {
    shared: [
      { name: 'memz/notes.md', owner: 'bob', originId: ORIGIN_A, kind: 'memory' as const, modifiedAt: '2026-01-01T00:00:00.000Z', content: memoryDoc('v1') },
      { name: 'skills/deploy/SKILL', owner: 'bob', originId: ORIGIN_B, kind: 'skill' as const, modifiedAt: '2026-01-01T00:00:00.000Z', content: skillDoc('deploy', 'body') },
    ],
  };
  t.mock.method(globalThis, 'fetch', mockFolderfoo(state).fetchImpl);
  await refreshSharedItems(db, baseDir, skillSpec, memorySpec, [{ server: SERVER, tenantId: TENANT }], 'alice');

  const ownDir = tmpDir('mb-shared-own-');
  const memoryRepo = new MemoryRepository(db, [{ name: 'mine', path: ownDir }]);
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'mine', path: ownDir }]);
  const folder = sharedFolderName('bob');

  assert.match((await memoryRepo.get(folder, 'notes'))!.body, /v1/);
  assert.equal(memoryRepo.splitSourcePath(listSharedItems(db, 'alice').find((i) => i.kind === 'memory')!.mirror_path)!.folder, folder);
  await assert.rejects(memoryRepo.update(folder, 'notes', { description: 'x' }), /read-only/);
  await assert.rejects(memoryRepo.delete(folder, 'notes'), /read-only/);
  await assert.rejects(memoryRepo.rename(folder, 'notes', 'other'), /read-only/);

  assert.equal((await skillRepo.get('deploy', folder))!.folder, folder);
  await assert.rejects(skillRepo.update('deploy', { description: 'x' }, undefined, undefined, folder), /read-only/);
  await assert.rejects(skillRepo.delete('deploy', folder), /read-only/);
  await assert.rejects(skillRepo.rename('deploy', 'deploy-2', folder), /read-only/);
});

test('resolveShareTarget is folder-scoped for skills and refuses items the caller does not own', () => {
  const db = openCache(':memory:');
  const mirrorA = tmpDir('mb-share-target-a-');
  const mirrorB = tmpDir('mb-share-target-b-');
  const mirrorTheirs = tmpDir('mb-share-target-theirs-');
  for (const dir of [mirrorA, mirrorB, mirrorTheirs]) {
    fs.mkdirSync(path.join(dir, 'deploy'));
    fs.writeFileSync(path.join(dir, 'deploy', 'SKILL.md'), skillDoc('deploy', 'body'));
  }
  const folders = [{ name: 'a', path: mirrorA }, { name: 'b', path: mirrorB }, { name: 'theirs', path: mirrorTheirs }];
  initialScan(db, skillSyncSpec(folders));
  const remote = (name: string, mirrorDir: string, folderPath: string, owner?: string): RemoteFolder => ({
    name, server: SERVER, tenantId: TENANT, folderPath, mirrorDir, mode: 'dev', username: 'alice', owner,
  });
  const repos = {
    skill: { listRemoteFolders: () => [remote('a', mirrorA, 'skills-a'), remote('b', mirrorB, 'skills-b'), remote('theirs', mirrorTheirs, 'team', 'bob')] },
    memory: { listRemoteFolders: () => [] },
  };

  assert.match((resolveShareTarget(db, repos, 'skills', 'deploy') as { error: string }).error, /more than one folder/);
  assert.deepEqual(resolveShareTarget(db, repos, 'skills', 'deploy', 'b'), {
    server: SERVER, tenantId: TENANT, folderPath: 'skills-b/deploy', name: 'SKILL', kind: 'skill',
  });
  assert.match((resolveShareTarget(db, repos, 'skills', 'deploy', 'theirs') as { error: string }).error, /only bob can share it/);
});
