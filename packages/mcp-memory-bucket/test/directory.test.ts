import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCache } from '../src/store/db.js';
import { memorySyncSpec, skillSyncSpec } from '../src/store/sync.js';
import { setCredential } from '../src/remote/credentials.js';
import { MemoryRepository } from '../src/memory/repository.js';
import { SkillRepository } from '../src/skills/repository.js';
import { IdentityTracker } from '../src/remote/identity.js';
import { importListing, importStatuses, lineDiff, previewListing, safeJoin, skillAddress } from '../src/remote/directory.js';
import type { RemoteDeps } from '../src/remote/connect.js';

// Public skills from the adopter's side: what matters is that nothing arrives active, an update is
// visible before it applies, and a listing cannot write outside its skill. Only global fetch is faked.

const SERVER = 'https://folderfoo.example.com';
const tmpDir = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const skillText = (body: string) => `---\nname: greeter\ndescription: says hello\n---\n${body}\n`;

type FakeFile = { path: string; kind: 'image' | 'text' | 'binary'; text: string };
interface FakeListing { version: number; content: string; files: FakeFile[] }

function fakeDirectory(listing: { current: FakeListing | null }) {
  const json = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: String(status), json: async () => body }) as Response;
  return async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.origin, SERVER);
    const current = listing.current;
    if (!current) return json({ error: 'Listing not found' }, 404);
    if (url.pathname.endsWith('/file')) {
      const file = current.files.find((f) => f.path === url.searchParams.get('path'));
      if (!file) return json({ error: 'File not found' }, 404);
      if (file.kind === 'binary' && !(init?.headers as Record<string, string> | undefined)?.authorization) return json({ error: 'Not authenticated' }, 401);
      const bytes = new TextEncoder().encode(file.text);
      return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer } as Response;
    }
    return json({
      id: 'L1', owner: 'bob', title: 'Greeter', description: 'says hello', license: 'MIT', version: current.version, content: current.content,
      files: current.files.map((f) => ({ path: f.path, size: f.text.length, contentType: 'text/plain', kind: f.kind })),
    });
  };
}

function setup(): RemoteDeps & { ownDir: string } {
  const baseDir = tmpDir('mb-directory-');
  const db = openCache(':memory:');
  const identity = new IdentityTracker('dev');
  const ownDir = tmpDir('mb-directory-own-');
  const memoryRepo = new MemoryRepository(db, [{ name: 'mine', path: ownDir }], [], baseDir, identity);
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'mine', path: ownDir }], [], baseDir, identity);
  return {
    db, identity, memoryRepo, skillRepo, skillSpec: skillSyncSpec([]), memorySpec: memorySyncSpec([]), appUrl: 'http://localhost:8767', ownDir,
    config: { baseDir, folderfooHost: SERVER, folderfooMode: 'cloud' } as unknown as RemoteDeps['config'],
  };
}

const isPaused = (deps: RemoteDeps, name: string) => (deps.db.prepare('SELECT paused FROM skills WHERE id = ?').get(name) as { paused: number }).paused === 1;

test('an import arrives paused and unreviewed, with its files', async (t) => {
  const deps = setup();
  t.mock.method(globalThis, 'fetch', fakeDirectory({ current: { version: 1, content: skillText('Say hello.'), files: [{ path: 'scripts/run.sh', kind: 'text', text: 'echo hi' }] } }));
  const result = await importListing(deps, 'L1');
  assert.equal(result.skill, 'greeter');
  assert.equal(isPaused(deps, 'greeter'), true);
  const doc = await deps.skillRepo.get('greeter');
  assert.equal(doc!.metadata?.status ?? (doc as unknown as { status?: string }).status, 'unreviewed');
  assert.equal(fs.readFileSync(path.join(path.dirname(doc!.source_path), 'scripts/run.sh'), 'utf-8'), 'echo hi');
});

test('an import never replaces a skill the user already has', async (t) => {
  const deps = setup();
  await deps.skillRepo.create({ name: 'greeter', description: 'mine' }, 'my own body', undefined, 'mine');
  t.mock.method(globalThis, 'fetch', fakeDirectory({ current: { version: 1, content: skillText('Hijack.'), files: [] } }));
  await assert.rejects(importListing(deps, 'L1'), /already have a skill/);
  assert.equal((await deps.skillRepo.get('greeter'))!.body, 'my own body');
});

test('a listing cannot write outside its skill', () => {
  assert.throws(() => safeJoin('/skills/a', '../../evil'), /unsafe file path/);
  assert.throws(() => safeJoin('/skills/a', '/etc/passwd'), /unsafe file path/);
  assert.throws(() => safeJoin('/skills/a', 'SKILL.md'), /unsafe file path/);
  assert.equal(safeJoin('/skills/a', 'scripts/run.sh'), path.resolve('/skills/a/scripts/run.sh'));
});

test('a traversal path in a listing fails the import and writes nothing outside', async (t) => {
  const deps = setup();
  t.mock.method(globalThis, 'fetch', fakeDirectory({ current: { version: 1, content: skillText('x'), files: [{ path: '../../escaped', kind: 'text', text: 'bad' }] } }));
  await assert.rejects(importListing(deps, 'L1'), /unsafe file path/);
  assert.equal(fs.existsSync(path.join(deps.ownDir, '..', 'escaped')), false);
  assert.equal(await deps.skillRepo.get('greeter').catch(() => null), null);
});

test('an update shows its diff, and applying it returns the skill to paused', async (t) => {
  const deps = setup();
  const listing: { current: FakeListing | null } = { current: { version: 1, content: skillText('Say hello.'), files: [{ path: 'old.txt', kind: 'text', text: 'a' }] } };
  t.mock.method(globalThis, 'fetch', fakeDirectory(listing));
  await importListing(deps, 'L1');
  await deps.skillRepo.setPaused(['greeter'], false);

  listing.current = { version: 2, content: skillText('Run rm -rf.'), files: [{ path: 'new.txt', kind: 'text', text: 'b' }] };
  const statuses = await importStatuses(deps);
  assert.equal(statuses[0]!.updateAvailable, true);
  assert.equal(isPaused(deps, 'greeter'), false, 'a pending update alone changes nothing');

  const preview = await previewListing(deps, 'L1');
  assert.equal(preview.updates, 'greeter');
  assert.ok(preview.contentDiff!.some((l) => l.type === 'added' && l.text === 'Run rm -rf.'));
  assert.deepEqual(preview.removedFiles, ['old.txt']);
  assert.equal(preview.files[0]!.change, 'new');

  await importListing(deps, 'L1');
  assert.equal(isPaused(deps, 'greeter'), true);
  const dir = path.dirname((await deps.skillRepo.get('greeter'))!.source_path);
  assert.equal(fs.existsSync(path.join(dir, 'old.txt')), false);
  assert.equal(fs.existsSync(path.join(dir, 'new.txt')), true);
  assert.equal((await importStatuses(deps))[0]!.updateAvailable, false);
});

test('a hidden or removed listing pauses the copy once, so the user can turn it back on', async (t) => {
  const deps = setup();
  const listing: { current: FakeListing | null } = { current: { version: 1, content: skillText('x'), files: [] } };
  t.mock.method(globalThis, 'fetch', fakeDirectory(listing));
  await importListing(deps, 'L1');
  await deps.skillRepo.setPaused(['greeter'], false);

  listing.current = null;
  assert.equal((await importStatuses(deps))[0]!.gone, true);
  assert.equal(isPaused(deps, 'greeter'), true);

  await deps.skillRepo.setPaused(['greeter'], false);
  await importStatuses(deps);
  assert.equal(isPaused(deps, 'greeter'), false);
});

test('a binary file needs a login: without one it is left out and named', async (t) => {
  const deps = setup();
  t.mock.method(globalThis, 'fetch', fakeDirectory({ current: { version: 1, content: skillText('x'), files: [{ path: 'tool', kind: 'binary', text: 'ELF' }] } }));
  assert.deepEqual((await importListing(deps, 'L1')).skippedFiles, ['tool']);
});

test('with a login a binary file comes along', async (t) => {
  const deps = setup();
  setCredential(deps.config.baseDir, SERVER, 'jwt-1');
  t.mock.method(globalThis, 'fetch', fakeDirectory({ current: { version: 1, content: skillText('x'), files: [{ path: 'tool', kind: 'binary', text: 'ELF' }] } }));
  assert.deepEqual((await importListing(deps, 'L1')).skippedFiles, []);
});

test('folderfoo integration off: nothing is fetched', async () => {
  const deps = setup();
  (deps.config as { folderfooHost: string | null }).folderfooHost = null;
  await assert.rejects(previewListing(deps, 'L1'), /folderfoo integration is off/);
});

test('lineDiff and skillAddress', () => {
  assert.deepEqual(lineDiff('a\nb', 'a\nc'), [{ type: 'same', text: 'a' }, { type: 'removed', text: 'b' }, { type: 'added', text: 'c' }]);
  assert.equal(skillAddress('skills/deploy'), 'skills/deploy:SKILL');
  assert.equal(skillAddress('deploy'), ':deploy:SKILL');
});
