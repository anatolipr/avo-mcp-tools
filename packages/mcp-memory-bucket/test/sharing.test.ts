import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCache } from '../src/store/db.js';
import { memorySyncSpec, skillSyncSpec } from '../src/store/sync.js';
import { setCredential } from '../src/remote/credentials.js';
import {
  addSharedItem,
  refreshSharedItems,
  listSharedItems,
  leaveSharedItem,
  sharedItemWriteTarget,
  sharedFolderName,
} from '../src/remote/shared-items.js';
import { sharedFolderRole, connectRemoteFolder, type RemoteDeps } from '../src/remote/connect.js';
import { acceptShare, forkSharedItem } from '../src/remote/sharing.js';
import { MemoryRepository } from '../src/memory/repository.js';
import { SkillRepository } from '../src/skills/repository.js';
import { IdentityTracker } from '../src/remote/identity.js';
import { ReadOnlyRemoteFolderError } from '../src/remote/folderfoo-client.js';
import type { BucketConfig, RemoteFolder } from '../src/config.js';

// Covers the second round of sharing: skills shared as whole folders (siblings and attachments
// included), memory docs with their attachments, editing an 'editor' share in place, leaving a
// share, public folder links, read-only connected shared folders, and accepting a folder invite.

const SERVER = 'https://folderfoo.example.com';
const TENANT = 't1';
const SKILL_ORIGIN = '44444444-4444-4444-8444-444444444444';
const DOC_ORIGIN = '55555555-5555-4555-8555-555555555555';
const PUBLIC_ORIGIN = '66666666-6666-4666-8666-666666666666';
const FOLDER_ORIGIN = '77777777-7777-4777-8777-777777777777';

const tmpDir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const skillDoc = (name: string, body: string) => `---\nname: ${name}\ndescription: shared skill\n---\n${body}\n`;
const memoryDoc = (body: string) => `---\nkey: PLAN\nkey_type: freeform\ndescription: a plan\ndoc_type: plan\ntags: []\nstatus: active\n---\n${body}\n`;

interface Share {
  owner: string;
  path: string;
  type: 'file' | 'folder';
  role: 'member' | 'editor';
  originId: string;
  kind: 'memory' | 'skill' | null;
}

/**
 * A small in-memory folderfoo: each owner's files by root-relative path, the shares granted to the
 * caller, and public links. Records writes and leaves. Only global fetch is faked.
 */
function fakeFolderfoo(state: {
  files: Record<string, Record<string, string>>;
  shares: Share[];
  publicLinks?: Record<string, { owner: string; path: string; type: 'file' | 'folder'; kind: 'memory' | 'skill' | null; originId: string }>;
  lastChanged?: number;
}) {
  const writes: Array<{ owner: string; path: string; body: string }> = [];
  const leaves: Array<{ owner: string; path: string; type: string }> = [];
  const json = (body: unknown, status = 200) =>
    ({ ok: status < 400, status, statusText: String(status), json: async () => body, text: async () => JSON.stringify(body) }) as Response;
  const content = (text: string) =>
    ({ ok: true, status: 200, text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer, json: async () => JSON.parse(text) }) as Response;
  const listUnder = (owner: string, folderPath: string) =>
    Object.keys(state.files[owner] ?? {})
      .filter((p) => p.startsWith(`${folderPath}/`))
      .map((p) => ({ name: p.slice(p.lastIndexOf('/') + 1), folderPath: p.slice(0, p.lastIndexOf('/')), mtime: 1000 }));
  const parseParam = (raw: string) => {
    const [owner, folder, name] = decodeURIComponent(raw).split(':');
    return { owner: owner!, path: folder ? `${folder}/${name}` : name! };
  };

  const fetchImpl = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const q = url.searchParams;
    if (url.pathname === '/shared-with-me') {
      return json(state.shares.map((s) => ({ name: s.path, owner: s.owner, type: s.type, role: s.role, originId: s.originId, kind: s.kind, size: 1, createdAt: 'x', modifiedAt: '2026-01-01T00:00:00.000Z' })));
    }
    if (url.pathname === '/shared-with-me/leave') {
      const body = JSON.parse(String(init!.body));
      leaves.push(body);
      state.shares = state.shares.filter((s) => !(s.owner === body.owner && s.path === body.path));
      return json({ message: 'left' });
    }
    if (url.pathname === '/folders/changed-since') {
      const files = listUnder(q.get('owner') ?? '', q.get('folderPath') ?? '');
      return files.length ? json({ files, serverTime: 0 }) : json({ error: 'You do not have access to this folder' }, 403);
    }
    if (url.pathname === '/folders/last-changed') return json({ lastChanged: state.lastChanged ?? 1 });
    if (url.pathname === '/folders') return json([]);
    if (url.pathname.startsWith('/data/')) {
      const { owner, path: p } = parseParam(url.pathname.slice('/data/'.length));
      const text = state.files[owner]?.[p];
      return text === undefined ? json({ error: 'nope' }, 403) : content(text);
    }
    if (url.pathname.startsWith('/save/')) {
      const { owner, path: p } = parseParam(url.pathname.slice('/save/'.length));
      const body = typeof init!.body === 'string' ? init!.body : Buffer.from(init!.body as ArrayBuffer).toString();
      writes.push({ owner, path: p, body });
      (state.files[owner] ??= {})[p] = body;
      return json({ message: 'saved' });
    }
    if (url.pathname.startsWith('/public/')) {
      const [token, sub] = url.pathname.slice('/public/'.length).split('/');
      const link = state.publicLinks?.[decodeURIComponent(token!)];
      if (!link) return json({ error: 'Invalid or expired link' }, 404);
      const meta = { owner: link.owner, path: link.path, type: link.type, originId: link.originId, kind: link.kind };
      if (sub === 'file') return content(state.files[link.owner]![`${link.path}/${q.get('path')}`]!);
      if (link.type === 'file') return json({ ...meta, content: state.files[link.owner]![link.path] });
      const files = listUnder(link.owner, link.path).map((f) => ({ ...f, folderPath: f.folderPath === link.path ? '' : f.folderPath.slice(link.path.length + 1), size: 1 }));
      return json({ ...meta, files });
    }
    throw new Error(`unexpected mocked fetch call: ${init?.method ?? 'GET'} ${input}`);
  };
  return { fetchImpl, writes, leaves };
}

function setup(username: string | null = 'alice') {
  const baseDir = tmpDir('mb-sharing-');
  setCredential(baseDir, SERVER, 'jwt-1');
  const db = openCache(':memory:');
  const identity = new IdentityTracker('dev');
  if (username) identity.setUsername(username);
  const ownDir = tmpDir('mb-sharing-own-');
  const memoryRepo = new MemoryRepository(db, [{ name: 'mine', path: ownDir }], [], baseDir, identity);
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'mine', path: ownDir }], [], baseDir, identity);
  return { baseDir, db, identity, memoryRepo, skillRepo, ownDir, skillSpec: skillSyncSpec([]), memorySpec: memorySyncSpec([]) };
}

const BOB_SKILL = {
  'skills/deploy/SKILL': skillDoc('deploy', 'run the script'),
  'skills/deploy/scripts/run.sh': 'echo deploy',
  'skills/deploy/attachments/diagram.txt': 'boxes',
};

test('a skill shared as a folder is discovered paused and mirrored whole: SKILL.md, siblings, attachments', async (t) => {
  const { baseDir, db, skillRepo, skillSpec, memorySpec } = setup();
  const state = { files: { bob: { ...BOB_SKILL } }, shares: [{ owner: 'bob', path: 'skills/deploy', type: 'folder' as const, role: 'member' as const, originId: SKILL_ORIGIN, kind: 'skill' as const }] };
  t.mock.method(globalThis, 'fetch', fakeFolderfoo(state).fetchImpl);

  const summary = await refreshSharedItems(db, baseDir, skillSpec, memorySpec, [{ server: SERVER, tenantId: TENANT }], 'alice');
  assert.equal(summary.added, 1);
  const [item] = listSharedItems(db, 'alice');
  assert.equal(item!.item_type, 'folder');
  assert.equal(item!.entryId, 'deploy');
  assert.equal(item!.paused, true);

  const skillDir = path.dirname((await skillRepo.get('deploy', sharedFolderName('bob')))!.source_path);
  assert.equal(fs.readFileSync(path.join(skillDir, 'scripts', 'run.sh'), 'utf-8'), 'echo deploy');
  assert.equal(fs.readFileSync(path.join(skillDir, 'attachments', 'diagram.txt'), 'utf-8'), 'boxes');

  // A sibling deleted on the owner's side disappears from the mirror on the next refresh.
  delete (state.files.bob as Record<string, string>)['skills/deploy/scripts/run.sh'];
  (state as { lastChanged?: number }).lastChanged = 2;
  await refreshSharedItems(db, baseDir, skillSpec, memorySpec, [{ server: SERVER, tenantId: TENANT }], 'alice');
  assert.equal(fs.existsSync(path.join(skillDir, 'scripts', 'run.sh')), false);
});

test("a folder of several skills is not filed as an item (it's connected as a source instead)", async (t) => {
  const { baseDir, db, skillSpec, memorySpec } = setup();
  const state = {
    files: { bob: { 'team/a/SKILL': skillDoc('a', 'x'), 'team/b/SKILL': skillDoc('b', 'y') } },
    shares: [{ owner: 'bob', path: 'team', type: 'folder' as const, role: 'member' as const, originId: FOLDER_ORIGIN, kind: 'skill' as const }],
  };
  t.mock.method(globalThis, 'fetch', fakeFolderfoo(state).fetchImpl);
  const summary = await refreshSharedItems(db, baseDir, skillSpec, memorySpec, [{ server: SERVER, tenantId: TENANT }], 'alice');
  assert.equal(summary.added, 0);
  assert.deepEqual(listSharedItems(db, 'alice'), []);
});

test('a shared memory doc brings its attachments along', async (t) => {
  const { baseDir, db, memoryRepo, skillSpec, memorySpec } = setup();
  const state = {
    files: { bob: { 'memz/plan.md': memoryDoc('v1'), 'memz/plan/attachments/sketch.txt': 'lines' } },
    shares: [{ owner: 'bob', path: 'memz/plan.md', type: 'file' as const, role: 'member' as const, originId: DOC_ORIGIN, kind: 'memory' as const }],
  };
  t.mock.method(globalThis, 'fetch', fakeFolderfoo(state).fetchImpl);
  await refreshSharedItems(db, baseDir, skillSpec, memorySpec, [{ server: SERVER, tenantId: TENANT }], 'alice');
  const doc = (await memoryRepo.get(sharedFolderName('bob'), 'plan'))!;
  assert.equal(fs.readFileSync(path.join(path.dirname(doc.source_path), 'plan', 'attachments', 'sketch.txt'), 'utf-8'), 'lines');
});

test("an 'editor' share is edited in place, writing to the owner's copy; a 'member' share stays read-only", async (t) => {
  const { baseDir, db, memoryRepo, skillRepo, skillSpec, memorySpec } = setup();
  const state = {
    files: { bob: { 'memz/plan.md': memoryDoc('v1'), ...BOB_SKILL } },
    shares: [
      { owner: 'bob', path: 'memz/plan.md', type: 'file' as const, role: 'editor' as const, originId: DOC_ORIGIN, kind: 'memory' as const },
      { owner: 'bob', path: 'skills/deploy', type: 'folder' as const, role: 'member' as const, originId: SKILL_ORIGIN, kind: 'skill' as const },
    ],
  };
  const fake = fakeFolderfoo(state);
  t.mock.method(globalThis, 'fetch', fake.fetchImpl);
  await refreshSharedItems(db, baseDir, skillSpec, memorySpec, [{ server: SERVER, tenantId: TENANT }], 'alice');
  const folder = sharedFolderName('bob');

  await memoryRepo.update(folder, 'plan', undefined, 'v2 from alice');
  assert.equal(fake.writes.length, 1);
  assert.equal(fake.writes[0]!.owner, 'bob');
  assert.equal(fake.writes[0]!.path, 'memz/plan.md');
  assert.match(fake.writes[0]!.body, /v2 from alice/);
  const after = (await memoryRepo.get(folder, 'plan'))!;
  assert.equal(after.folder, folder, 'the edited doc stays filed under its shared folder');
  assert.match(after.body, /v2 from alice/);

  // An attachment added to the editable doc goes to the owner's <stem>/attachments/.
  const mirror = path.dirname(after.source_path);
  assert.deepEqual(sharedItemWriteTarget(db, path.join(mirror, 'plan', 'attachments', 'new.txt'), 'alice'), {
    server: SERVER, tenantId: TENANT, owner: 'bob', folderPath: 'memz/plan/attachments', name: 'new.txt',
  });

  await assert.rejects(skillRepo.update('deploy', { description: 'x' }, undefined, undefined, folder), /read-only/);
  await assert.rejects(memoryRepo.delete(folder, 'plan'), /read-only/);
  assert.equal(fake.writes.length, 1);
});

test("an editable shared skill maps SKILL.md and its siblings onto the owner's skill directory", async (t) => {
  const { baseDir, db, skillRepo, skillSpec, memorySpec } = setup();
  const state = {
    files: { bob: { ...BOB_SKILL } },
    shares: [{ owner: 'bob', path: 'skills/deploy', type: 'folder' as const, role: 'editor' as const, originId: SKILL_ORIGIN, kind: 'skill' as const }],
  };
  const fake = fakeFolderfoo(state);
  t.mock.method(globalThis, 'fetch', fake.fetchImpl);
  await refreshSharedItems(db, baseDir, skillSpec, memorySpec, [{ server: SERVER, tenantId: TENANT }], 'alice');
  const folder = sharedFolderName('bob');
  await skillRepo.update('deploy', { description: 'improved' }, undefined, undefined, folder);
  assert.equal(fake.writes[0]!.path, 'skills/deploy/SKILL');
  const skillDir = path.dirname((await skillRepo.get('deploy', folder))!.source_path);
  assert.deepEqual(sharedItemWriteTarget(db, path.join(skillDir, 'scripts', 'run.sh'), 'alice'), {
    server: SERVER, tenantId: TENANT, owner: 'bob', folderPath: 'skills/deploy/scripts', name: 'run.sh',
  });
  // Another login never gets a write target for alice's share.
  assert.ok('error' in sharedItemWriteTarget(db, path.join(skillDir, 'SKILL.md'), 'carol'));
});

test('leaving a shared item tells folderfoo and drops the local copy', async (t) => {
  const { baseDir, db, skillSpec, memorySpec } = setup();
  const state = { files: { bob: { ...BOB_SKILL } }, shares: [{ owner: 'bob', path: 'skills/deploy', type: 'folder' as const, role: 'member' as const, originId: SKILL_ORIGIN, kind: 'skill' as const }] };
  const fake = fakeFolderfoo(state);
  t.mock.method(globalThis, 'fetch', fake.fetchImpl);
  await refreshSharedItems(db, baseDir, skillSpec, memorySpec, [{ server: SERVER, tenantId: TENANT }], 'alice');
  const mirror = listSharedItems(db, 'alice')[0]!.mirror_path;

  assert.deepEqual(await leaveSharedItem(db, baseDir, SKILL_ORIGIN, 'alice'), { left: true });
  assert.deepEqual(fake.leaves, [{ owner: 'bob', path: 'skills/deploy', type: 'folder' }]);
  assert.equal(fs.existsSync(mirror), false);
  assert.deepEqual(listSharedItems(db, 'alice'), []);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM skills`).get() as { n: number }).n, 0);
});

test('a public folder link is mirrored read-only, every doc indexed', async (t) => {
  const { baseDir, db, memoryRepo, skillSpec, memorySpec } = setup(null);
  const state = {
    files: { pat: { 'pub/one.md': memoryDoc('first'), 'pub/sub/two.md': memoryDoc('second') } },
    shares: [],
    publicLinks: { 'pub.t1.tok': { owner: 'pat', path: 'pub', type: 'folder' as const, kind: 'memory' as const, originId: PUBLIC_ORIGIN } },
  };
  t.mock.method(globalThis, 'fetch', fakeFolderfoo(state).fetchImpl);
  await addSharedItem(db, baseDir, skillSpec, memorySpec, {
    owner: 'pat', server: SERVER, tenantId: TENANT, path: 'pub', originId: PUBLIC_ORIGIN, kind: 'memory', itemType: 'folder', publicToken: 'pub.t1.tok',
  });
  const [item] = listSharedItems(db, null);
  assert.equal(item!.docCount, 2);
  assert.equal(item!.public, true);
  const folder = sharedFolderName('pat');
  assert.match((await memoryRepo.get(folder, 'two'))!.body, /second/);
  await assert.rejects(memoryRepo.update(folder, 'one', undefined, 'x'), /read-only/);

  // Unchanged on refresh; revoked once the link is gone.
  assert.equal((await refreshSharedItems(db, baseDir, skillSpec, memorySpec, [], null)).unchanged, 1);
  state.publicLinks = {} as typeof state.publicLinks;
  assert.equal((await refreshSharedItems(db, baseDir, skillSpec, memorySpec, [], null)).revoked, 1);
});

test('forking a shared skill copies its siblings and attachments too', async (t) => {
  const { baseDir, db, skillRepo, memoryRepo, identity, ownDir, skillSpec, memorySpec } = setup();
  const state = { files: { bob: { ...BOB_SKILL } }, shares: [{ owner: 'bob', path: 'skills/deploy', type: 'folder' as const, role: 'member' as const, originId: SKILL_ORIGIN, kind: 'skill' as const }] };
  t.mock.method(globalThis, 'fetch', fakeFolderfoo(state).fetchImpl);
  await refreshSharedItems(db, baseDir, skillSpec, memorySpec, [{ server: SERVER, tenantId: TENANT }], 'alice');
  const deps = { db, skillRepo, memoryRepo, identity, skillSpec, memorySpec, config: { baseDir } as BucketConfig, appUrl: 'http://localhost:1/' } as RemoteDeps;
  const result = await forkSharedItem(deps, SKILL_ORIGIN, 'mine');
  assert.deepEqual(result.ids, ['deploy']);
  assert.equal(fs.readFileSync(path.join(ownDir, 'deploy', 'scripts', 'run.sh'), 'utf-8'), 'echo deploy');
  assert.equal(fs.readFileSync(path.join(ownDir, 'deploy', 'attachments', 'diagram.txt'), 'utf-8'), 'boxes');
});

test('sharedFolderRole takes the strongest folder share covering a path', () => {
  const entry = (name: string, role: 'member' | 'editor') => ({ name, owner: 'bob', type: 'folder' as const, role, size: 0, createdAt: '', modifiedAt: '', originId: null, kind: null });
  assert.equal(sharedFolderRole([entry('team', 'member')], 'bob', 'team/sub'), 'member');
  assert.equal(sharedFolderRole([entry('team', 'member'), entry('team/sub', 'editor')], 'bob', 'team/sub'), 'editor');
  assert.equal(sharedFolderRole([entry('teamx', 'editor')], 'bob', 'team'), undefined);
});

test('a connected folder shared read-only refuses local writes before touching folderfoo', async () => {
  const { memoryRepo } = setup();
  const mirrorDir = tmpDir('mb-sharing-ro-');
  const remote: RemoteFolder = { name: 'bobs', server: SERVER, tenantId: TENANT, folderPath: 'memz', mirrorDir, mode: 'dev', username: 'alice', owner: 'bob', role: 'member' };
  memoryRepo.registerRemoteFolder(remote);
  await assert.rejects(
    memoryRepo.create({ filename: 'x.md', key: 'X', key_type: 'freeform', doc_type: 'plan', description: 'x', body: 'x', folder: 'bobs' }),
    ReadOnlyRemoteFolderError
  );
  assert.equal(memoryRepo.setRemoteRole('bobs', 'editor'), true);
});

test('accepting an invite to a folder of docs connects it as a source with its role', async (t) => {
  const { baseDir, db, identity, memoryRepo, skillRepo, skillSpec, memorySpec } = setup();
  const configPath = path.join(baseDir, 'memory-bucket.config.json');
  const config = { baseDir, configPath, folderfooHost: SERVER, folderfooMode: 'dev', skillFolders: [], memoryFolders: [], remoteSkillFolders: [], remoteMemoryFolders: [], cacheDbPath: ':memory:' } as BucketConfig;
  const state = {
    files: { bob: { 'team/notes.md': memoryDoc('team notes') } },
    shares: [{ owner: 'bob', path: 'team', type: 'folder' as const, role: 'editor' as const, originId: FOLDER_ORIGIN, kind: 'memory' as const }],
  };
  t.mock.method(globalThis, 'fetch', fakeFolderfoo(state).fetchImpl);
  const deps: RemoteDeps = { db, config, skillRepo, memoryRepo, skillSpec, memorySpec, identity, appUrl: 'http://localhost:1/' };

  const result = await acceptShare(deps, { owner: 'bob', path: 'team', type: 'folder', originId: FOLDER_ORIGIN, kind: 'memory', role: 'editor', server: SERVER, tenantId: TENANT });
  assert.ok('connected' in result);
  assert.equal(result.connected.role, 'editor');
  assert.equal(result.connected.owner, 'bob');
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  assert.equal(saved.memory_sources[0].remote.role, 'editor');
  assert.match((await memoryRepo.get(result.connected.name, 'notes'))!.body, /team notes/);

  // Connecting the same folder again is a no-op.
  const again = await connectRemoteFolder(deps, { kind: 'memory', server: SERVER, tenantId: TENANT, folderPath: 'team', owner: 'bob' });
  assert.equal(again.alreadyConnected, true);
});
