import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { openCache } from '../src/store/db.js';
import {
  initialScan,
  upsertFile,
  removeFile,
  unregisterFolder,
  pruneMissingFiles,
  rebuildDocTables,
  skillSyncSpec,
  memorySyncSpec,
  walkMarkdownFiles,
  walkSkillSiblingFiles,
} from '../src/store/sync.js';
import { writeFileAtomic, ATOMIC_TMP_SUFFIX } from '../src/store/atomic-write.js';
import { trashDirFor, pruneTrash, TRASH_DIRNAME } from '../src/store/trash.js';
import { recall, formatRecall } from '../src/store/recall.js';
import { searchCombined } from '../src/store/search.js';
import { SkillRepository } from '../src/skills/repository.js';
import { MemoryRepository } from '../src/memory/repository.js';
import { buildWebRouter } from '../src/web/routes.js';
import { IdentityTracker } from '../src/remote/identity.js';
import type { BucketConfig } from '../src/config.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bucket-hardening-'));
}

function writeSkill(root: string, dirName: string, name: string, body: string, extra = ''): string {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, `---\nname: "${name}"\ndescription: "Skill ${name}. Use when testing."\n${extra}---\n${body}\n`);
  return file;
}

function writeDoc(root: string, filename: string, key: string, body: string, extra = ''): string {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, filename);
  fs.writeFileSync(file, `---\nkey: "${key}"\ndescription: "Doc ${key}"\n${extra}---\n${body}\n`);
  return file;
}

const count = (db: ReturnType<typeof openCache>, sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;

/** Silences the console.error a deliberately failing code path logs, for the duration of `fn`. */
function quietly<T>(fn: () => T): T {
  const original = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = original;
  }
}

function trashEntries(baseDir: string): string[] {
  const dir = trashDirFor(baseDir);
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

// --- startup prune ---------------------------------------------------------------------------

test('pruneMissingFiles drops the row, search entry, dates and chunks of a file deleted while the server was down', () => {
  const dir = tmpDir();
  const db = openCache(':memory:');
  const spec = memorySyncSpec([{ name: 'folder', path: dir }]);
  writeDoc(dir, 'keep.md', 'KEEP', 'keeper body 2026-02-03');
  const gone = writeDoc(dir, 'gone.md', 'GONE', 'vanishing body 2026-02-04');
  initialScan(db, spec);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM memory_docs`), 2);

  fs.rmSync(gone);
  initialScan(db, spec); // a rescan alone never removes anything
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM memory_docs`), 2);

  assert.equal(pruneMissingFiles(db, spec), 1);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM memory_docs`), 1);
  assert.equal(searchCombined(db, 'vanishing').length, 0);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM doc_dates WHERE ref_id = ?`, gone), 0);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM chunks WHERE ref_id = ?`, gone), 0);
  assert.equal(searchCombined(db, 'keeper').length, 1);
  assert.equal(pruneMissingFiles(db, spec), 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pruneMissingFiles leaves a folder alone when its root is missing or empty (an unmounted volume)', () => {
  const missingRoot = tmpDir();
  const emptyRoot = tmpDir();
  const db = openCache(':memory:');
  const spec = memorySyncSpec([
    { name: 'missing', path: missingRoot },
    { name: 'empty', path: emptyRoot },
  ]);
  writeDoc(missingRoot, 'a.md', 'A', 'body a');
  const b = writeDoc(emptyRoot, 'b.md', 'B', 'body b');
  initialScan(db, spec);

  fs.rmSync(missingRoot, { recursive: true, force: true });
  fs.rmSync(b);
  assert.equal(pruneMissingFiles(db, spec), 0);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM memory_docs`), 2);
  db.close();
  fs.rmSync(emptyRoot, { recursive: true, force: true });
});

// --- unregisterFolder ------------------------------------------------------------------------

test('unregisterFolder removes only its own folder\'s rows when another folder has a skill of the same name', () => {
  const dirA = tmpDir();
  const dirB = tmpDir();
  const db = openCache(':memory:');
  const spec = skillSyncSpec([
    { name: 'a', path: dirA },
    { name: 'b', path: dirB },
  ]);
  writeSkill(dirA, 'dup', 'dup', 'alphaword body 2026-03-01');
  writeSkill(dirB, 'dup', 'dup', 'betaword body 2026-03-02');
  initialScan(db, spec);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM skills`), 2);

  unregisterFolder(db, 'skills', 'a');

  assert.equal(count(db, `SELECT COUNT(*) AS n FROM skills`), 1);
  assert.equal(searchCombined(db, 'betaword').length, 1, "the other folder's same-named skill stays searchable");
  assert.equal(searchCombined(db, 'alphaword').length, 0);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM doc_dates WHERE ref_folder = 'a'`), 0, 'no orphaned doc_dates');
  assert.ok(count(db, `SELECT COUNT(*) AS n FROM doc_dates WHERE ref_folder = 'b'`) > 0);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM chunks WHERE ref_folder = 'a'`), 0);
  assert.ok(count(db, `SELECT COUNT(*) AS n FROM chunks WHERE ref_folder = 'b'`) > 0);
  db.close();
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});

// --- cache rebuild ---------------------------------------------------------------------------

test('rebuildDocTables keeps paused flags, and rolls back to the previous cache when the rescan throws', async () => {
  const skillDir = tmpDir();
  const memDir = tmpDir();
  const db = openCache(':memory:');
  const skillFolders = [{ name: 'builtin', path: '/nonexistent' }, { name: 'folder', path: skillDir }];
  const memFolders = [{ name: 'folder', path: memDir }];
  const skillSpec = skillSyncSpec(skillFolders);
  const memorySpec = memorySyncSpec(memFolders);
  const skillRepo = new SkillRepository(db, skillFolders);
  const memoryRepo = new MemoryRepository(db, memFolders);
  writeSkill(skillDir, 'paused-skill', 'paused-skill', 'body');
  writeSkill(skillDir, 'live-skill', 'live-skill', 'body');
  writeDoc(memDir, 'paused.md', 'PAUSED', 'body');
  writeDoc(memDir, 'live.md', 'LIVE', 'body');
  initialScan(db, skillSpec);
  initialScan(db, memorySpec);
  await skillRepo.setPaused(['paused-skill'], true);
  await memoryRepo.setPaused([{ filename: 'paused.md' }], true);

  rebuildDocTables(db, () => {
    initialScan(db, skillSpec);
    initialScan(db, memorySpec);
  });
  assert.equal((await skillRepo.get('paused-skill'))?.paused, true);
  assert.equal((await skillRepo.get('live-skill'))?.paused, false);
  assert.equal((await memoryRepo.get(undefined, 'paused.md'))?.paused, true);
  assert.equal((await memoryRepo.get(undefined, 'live.md'))?.paused, false);
  assert.equal(searchCombined(db, 'body').length, 4, 'search index is repopulated');

  assert.throws(() =>
    rebuildDocTables(db, () => {
      throw new Error('scan exploded');
    })
  );
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM skills`), 2, 'previous cache survives a failed rebuild');
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM memory_docs`), 2);
  assert.equal((await memoryRepo.get(undefined, 'paused.md'))?.paused, true);
  db.close();
  fs.rmSync(skillDir, { recursive: true, force: true });
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('POST /api/rebuild-cache keeps a paused doc paused', async (t) => {
  const baseDir = tmpDir();
  const memDir = tmpDir();
  const db = openCache(':memory:');
  const memFolders = [{ name: 'folder', path: memDir }];
  const skillFolders = [{ name: 'builtin', path: '/nonexistent' }];
  const memorySpec = memorySyncSpec(memFolders);
  const skillSpec = skillSyncSpec(skillFolders);
  const memoryRepo = new MemoryRepository(db, memFolders);
  const skillRepo = new SkillRepository(db, skillFolders);
  writeDoc(memDir, 'paused.md', 'PAUSED', 'body');
  initialScan(db, memorySpec);
  await memoryRepo.setPaused([{ filename: 'paused.md' }], true);

  const config: BucketConfig = {
    skillFolders: [],
    memoryFolders: memFolders,
    remoteSkillFolders: [],
    remoteMemoryFolders: [],
    cacheDbPath: path.join(baseDir, 'cache.sqlite'),
    configPath: path.join(baseDir, 'memory-bucket.config.json'),
    baseDir,
    folderfooMode: 'off',
    folderfooHost: undefined,
  } as BucketConfig;
  const app = express();
  app.use(express.json());
  app.use(buildWebRouter(db, config, skillRepo, memoryRepo, skillSpec, memorySpec, new IdentityTracker('off')));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => {
    server.close();
    db.close();
    fs.rmSync(baseDir, { recursive: true, force: true });
    fs.rmSync(memDir, { recursive: true, force: true });
  });
  const { port } = server.address() as { port: number };

  const res = await fetch(`http://localhost:${port}/api/rebuild-cache`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { skillCount: 0, memoryCount: 1 });
  assert.equal((await memoryRepo.get(undefined, 'paused.md'))?.paused, true);
});

// --- upsertFile / scan -----------------------------------------------------------------------

test('upsertFile is all-or-nothing: a failure while indexing leaves no half-written row', () => {
  const dir = tmpDir();
  const db = openCache(':memory:');
  const spec = skillSyncSpec([{ name: 'folder', path: dir }]);
  const file = writeSkill(dir, 'broken', 'broken', 'body');
  db.exec(`DROP TABLE chunk_fts`); // makes the chunk-writing step, late in upsertFile, throw

  assert.throws(() => upsertFile(db, spec, file));
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM skills`), 0, 'the row insert was rolled back with the rest');
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM search_index`), 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('initialScan indexes every good file when one file in the batch cannot be parsed', () => {
  const dir = tmpDir();
  const db = openCache(':memory:');
  const spec = skillSyncSpec([{ name: 'folder', path: dir }]);
  writeSkill(dir, 'good-one', 'good-one', 'body');
  writeSkill(dir, 'good-two', 'good-two', 'body');
  fs.mkdirSync(path.join(dir, 'bad'));
  fs.writeFileSync(path.join(dir, 'bad', 'SKILL.md'), `---\nname: [unclosed\n---\nbody\n`);

  quietly(() => initialScan(db, spec));
  const names = (db.prepare(`SELECT id FROM skills ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id);
  assert.deepEqual(names, ['good-one', 'good-two']);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('upsertFile refuses a second file claiming a name already used in the same folder', () => {
  const dir = tmpDir();
  const db = openCache(':memory:');
  const spec = skillSyncSpec([{ name: 'folder', path: dir }]);
  const first = writeSkill(dir, 'first', 'same-name', 'first body');
  const second = writeSkill(dir, 'second', 'same-name', 'second body');
  upsertFile(db, spec, first);
  quietly(() => upsertFile(db, spec, second));

  const rows = db.prepare(`SELECT source_path, body FROM skills`).all() as Array<{ source_path: string; body: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source_path, first, 'the first-indexed file keeps the name');
  assert.equal(rows[0]!.body, 'first body');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('upsertFile re-keys a skill whose frontmatter name changed, leaving nothing under the old name', () => {
  const dir = tmpDir();
  const db = openCache(':memory:');
  const spec = skillSyncSpec([{ name: 'folder', path: dir }]);
  const file = writeSkill(dir, 'thing', 'old-name', 'oldmarker body');
  upsertFile(db, spec, file);

  writeSkill(dir, 'thing', 'new-name', 'newmarker body');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later); // a rewrite within the same millisecond must not look unchanged
  upsertFile(db, spec, file);

  const names = (db.prepare(`SELECT id FROM skills`).all() as Array<{ id: string }>).map((r) => r.id);
  assert.deepEqual(names, ['new-name']);
  assert.equal(searchCombined(db, 'oldmarker').length, 0);
  assert.equal(searchCombined(db, 'newmarker').length, 1);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM chunks WHERE ref_id = 'old-name'`), 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('upsertFile skips an unchanged file and files a doc under its longest matching folder', () => {
  const outer = tmpDir();
  const inner = path.join(outer, 'nested');
  const db = openCache(':memory:');
  const spec = memorySyncSpec([
    { name: 'outer', path: outer },
    { name: 'inner', path: inner },
  ]);
  const file = writeDoc(inner, 'doc.md', 'DOC', 'body');
  upsertFile(db, spec, file);
  assert.equal((db.prepare(`SELECT folder FROM memory_docs`).get() as { folder: string }).folder, 'inner');

  db.prepare(`UPDATE memory_docs SET description = 'edited in cache'`).run();
  upsertFile(db, spec, file); // same mtime: not reprocessed
  assert.equal((db.prepare(`SELECT description FROM memory_docs`).get() as { description: string }).description, 'edited in cache');

  removeFile(db, 'memory_docs', file);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM memory_docs`), 0);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM search_index`), 0);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM chunks`), 0);
  db.close();
  fs.rmSync(outer, { recursive: true, force: true });
});

// --- atomic writes ---------------------------------------------------------------------------

test('writeFileAtomic replaces content and leaves no temp file behind', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'doc.md');
  writeFileAtomic(file, 'first');
  assert.equal(fs.readFileSync(file, 'utf-8'), 'first');
  writeFileAtomic(file, Buffer.from('second'));
  assert.equal(fs.readFileSync(file, 'utf-8'), 'second');
  assert.deepEqual(fs.readdirSync(dir), ['doc.md']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomic keeps an existing file\'s permissions, and applies an explicit mode', { skip: process.platform === 'win32' }, () => {
  const dir = tmpDir();
  const file = path.join(dir, 'doc.md');
  fs.writeFileSync(file, 'x');
  fs.chmodSync(file, 0o640);
  writeFileAtomic(file, 'y');
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);

  const secret = path.join(dir, 'secret.json');
  writeFileAtomic(secret, '{}', { mode: 0o600 });
  assert.equal(fs.statSync(secret).mode & 0o777, 0o600);
  fs.chmodSync(secret, 0o644);
  writeFileAtomic(secret, '{"a":1}', { mode: 0o600 });
  assert.equal(fs.statSync(secret).mode & 0o777, 0o600, 'an explicit mode is re-applied to an existing file');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomic writes through a symlink and keeps hard links attached', { skip: process.platform === 'win32' }, () => {
  const dir = tmpDir();
  const real = path.join(dir, 'real.md');
  const link = path.join(dir, 'link.md');
  fs.writeFileSync(real, 'old');
  fs.symlinkSync(real, link);
  writeFileAtomic(link, 'via link');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the symlink is not replaced by a regular file');
  assert.equal(fs.readFileSync(real, 'utf-8'), 'via link');

  const hard = path.join(dir, 'hard.md');
  fs.linkSync(real, hard);
  writeFileAtomic(real, 'both names');
  assert.equal(fs.readFileSync(hard, 'utf-8'), 'both names', 'the other hard link sees the new content');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomic fails exactly like a plain write when the directory does not exist', () => {
  const dir = tmpDir();
  assert.throws(() => writeFileAtomic(path.join(dir, 'missing', 'doc.md'), 'x'), /ENOENT/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a leftover atomic temp file and the trash directory are never indexed or treated as skill content', () => {
  const dir = tmpDir();
  const skillDir = path.join(dir, 'skill');
  writeSkill(dir, 'skill', 'skill', 'body');
  fs.writeFileSync(path.join(skillDir, `.SKILL.md.1.0${ATOMIC_TMP_SUFFIX}`), 'partial');
  fs.writeFileSync(path.join(skillDir, 'reference.md'), 'real sibling');
  fs.mkdirSync(path.join(dir, TRASH_DIRNAME, 'entry'), { recursive: true });
  fs.writeFileSync(path.join(dir, TRASH_DIRNAME, 'entry', 'old.md'), 'trashed');

  assert.deepEqual([...walkSkillSiblingFiles(skillDir)], [path.join(skillDir, 'reference.md')]);
  const walked = [...walkMarkdownFiles(dir)].map((f) => path.relative(dir, f)).sort();
  assert.deepEqual(walked, [path.join('skill', 'SKILL.md'), path.join('skill', 'reference.md')]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- trash -----------------------------------------------------------------------------------

test('memory update and delete leave recoverable copies in the trash', async () => {
  const baseDir = tmpDir();
  const memDir = tmpDir();
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'folder', path: memDir }], [], baseDir);
  const doc = await repo.create({ filename: 'note.md', key: 'NOTE', key_type: 'freeform', doc_type: 'other', description: 'A note', body: 'version one' });

  await repo.update(undefined, 'note.md', undefined, 'version two');
  await repo.update(undefined, 'note.md', undefined, 'version three'); // within the burst window: no second snapshot
  let entries = trashEntries(baseDir);
  assert.equal(entries.length, 1);
  assert.match(entries[0]!, /-update-note\.md$/);
  assert.match(fs.readFileSync(path.join(trashDirFor(baseDir), entries[0]!, 'note.md'), 'utf-8'), /version one/);
  assert.equal(fs.readFileSync(path.join(trashDirFor(baseDir), entries[0]!, 'origin.txt'), 'utf-8').trim(), doc.source_path);

  await repo.delete(undefined, 'note.md');
  assert.equal(fs.existsSync(doc.source_path), false);
  assert.equal(await repo.get(undefined, 'note.md'), null);
  entries = trashEntries(baseDir);
  const deleted = entries.find((e) => /-delete-note\.md$/.test(e));
  assert.ok(deleted, 'delete produced a trash entry');
  assert.match(fs.readFileSync(path.join(trashDirFor(baseDir), deleted!, 'note.md'), 'utf-8'), /version three/);
  db.close();
  fs.rmSync(baseDir, { recursive: true, force: true });
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('skill delete moves the whole skill directory, sibling files included, to the trash', async () => {
  const baseDir = tmpDir();
  const skillDir = tmpDir();
  const db = openCache(':memory:');
  const repo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'folder', path: skillDir }], [], baseDir);
  const created = await repo.create({ name: 'doomed', description: 'Doomed skill. Use when testing.' }, 'skill body');
  const dir = path.dirname(created.source_path);
  fs.mkdirSync(path.join(dir, 'references'));
  fs.writeFileSync(path.join(dir, 'references', 'notes.md'), 'reference notes');

  await repo.delete('doomed');
  assert.equal(fs.existsSync(dir), false);
  assert.equal(await repo.get('doomed'), null);
  const entries = trashEntries(baseDir);
  assert.equal(entries.length, 1);
  assert.match(entries[0]!, /-delete-doomed$/);
  const saved = path.join(trashDirFor(baseDir), entries[0]!, 'doomed');
  assert.match(fs.readFileSync(path.join(saved, 'SKILL.md'), 'utf-8'), /skill body/);
  assert.equal(fs.readFileSync(path.join(saved, 'references', 'notes.md'), 'utf-8'), 'reference notes');
  db.close();
  fs.rmSync(baseDir, { recursive: true, force: true });
  fs.rmSync(skillDir, { recursive: true, force: true });
});

test('deletes and updates work unchanged with the trash turned off, or with no base directory', async () => {
  const baseDir = tmpDir();
  const memDir = tmpDir();
  const db = openCache(':memory:');
  const previous = process.env.MEMORY_BUCKET_TRASH_DAYS;
  process.env.MEMORY_BUCKET_TRASH_DAYS = '0';
  try {
    const repo = new MemoryRepository(db, [{ name: 'folder', path: memDir }], [], baseDir);
    await repo.create({ filename: 'off.md', key: 'OFF', key_type: 'freeform', doc_type: 'other', description: 'd', body: 'one' });
    await repo.update(undefined, 'off.md', undefined, 'two');
    await repo.delete(undefined, 'off.md');
    assert.deepEqual(trashEntries(baseDir), []);
    assert.equal(fs.existsSync(path.join(memDir, 'off.md')), false);
  } finally {
    if (previous === undefined) delete process.env.MEMORY_BUCKET_TRASH_DAYS;
    else process.env.MEMORY_BUCKET_TRASH_DAYS = previous;
  }

  const bare = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);
  await bare.create({ filename: 'bare.md', key: 'BARE', key_type: 'freeform', doc_type: 'other', description: 'd', body: 'one' });
  await bare.delete(undefined, 'bare.md');
  assert.equal(fs.existsSync(path.join(memDir, 'bare.md')), false);
  db.close();
  fs.rmSync(baseDir, { recursive: true, force: true });
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('pruneTrash removes only entries older than the retention window', () => {
  const baseDir = tmpDir();
  const makeEntry = (name: string, ageDays: number) => {
    const dir = path.join(trashDirFor(baseDir), name);
    fs.mkdirSync(dir, { recursive: true });
    const origin = path.join(dir, 'origin.txt');
    fs.writeFileSync(origin, '/somewhere\n');
    const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    fs.utimesSync(origin, when, when);
  };
  makeEntry('old-entry', 40);
  makeEntry('fresh-entry', 2);
  pruneTrash(baseDir, true);
  assert.deepEqual(trashEntries(baseDir), ['fresh-entry']);
  fs.rmSync(baseDir, { recursive: true, force: true });
});

// --- recall ----------------------------------------------------------------------------------

test('recall: paused and hidden docs do not use up the candidate slots of visible matches', async () => {
  const memDir = tmpDir();
  const hiddenDir = tmpDir();
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [
    { name: 'folder', path: memDir },
    { name: 'secret', path: hiddenDir },
  ]);
  // 40 docs that match "zebra" far better than the one visible doc — more than a ranked list keeps.
  const strong = 'zebra zebra zebra zebra';
  const refs = [];
  for (let i = 0; i < 20; i++) {
    await repo.create({ filename: `paused-${i}.md`, key: `P-${i}`, key_type: 'freeform', doc_type: 'other', description: `zebra ${i}`, body: strong, folder: 'folder' });
    refs.push({ folder: 'folder', filename: `paused-${i}.md` });
    await repo.create({ filename: `hidden-${i}.md`, key: `H-${i}`, key_type: 'freeform', doc_type: 'other', description: `zebra ${i}`, body: strong, folder: 'secret' });
  }
  await repo.setPaused(refs, true);
  await repo.create({
    filename: 'visible.md',
    key: 'VISIBLE',
    key_type: 'freeform',
    doc_type: 'other',
    description: 'Field notes',
    body: 'A long page about savanna wildlife, grass, water holes, weather and the one zebra seen at dusk.',
    folder: 'folder',
  });

  const result = await recall(db, 'zebra', { hidden: { skills: [], memory_docs: ['secret'] } });
  assert.deepEqual(result.chunks.map((c) => c.id), ['visible.md']);
  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
  fs.rmSync(hiddenDir, { recursive: true, force: true });
});

test('recall: an abandoned or deprecated doc ranks below an equally matching live doc, and is labelled', async () => {
  const memDir = tmpDir();
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);
  const body = 'Rollout plan for the checkout service migration.';
  // Created first, so on a tie it would otherwise come first.
  await repo.create({ filename: 'abandoned.md', key: 'OLD', key_type: 'freeform', doc_type: 'plan', description: 'Checkout migration', body, status: 'abandoned' });
  await repo.create({ filename: 'deprecated.md', key: 'DEP', key_type: 'freeform', doc_type: 'plan', description: 'Checkout migration', body });
  await repo.update(undefined, 'deprecated.md', { deprecated: true });
  await repo.create({ filename: 'active.md', key: 'NEW', key_type: 'freeform', doc_type: 'plan', description: 'Checkout migration', body });

  const result = await recall(db, 'checkout migration rollout');
  assert.equal(result.chunks[0]!.id, 'active.md');
  assert.equal(result.chunks[0]!.stale, undefined);
  const byId = new Map(result.chunks.map((c) => [c.id, c]));
  assert.equal(byId.get('abandoned.md')?.stale, 'abandoned', 'still returned, just lower');
  assert.equal(byId.get('deprecated.md')?.stale, 'deprecated');
  const text = formatRecall(result);
  assert.match(text, /## memory abandoned\.md \(folder: folder, key: OLD, abandoned\)/);
  assert.match(text, /## memory active\.md \(folder: folder, key: NEW\)/);
  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});

// --- related_to / extends ----------------------------------------------------------------------

test('memory getRelated follows related_to in both directions, skipping paused docs', async () => {
  const memDir = tmpDir();
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);
  await repo.create({ filename: 'plan.md', key: 'RMXS-14', key_type: 'ticket', doc_type: 'plan', description: 'Plan', body: 'plan body' });
  // related_to typed loosely — it is matched against the normalized key.
  await repo.create({ filename: 'spec.md', key: 'RMXS-14-SPEC', key_type: 'freeform', doc_type: 'spec', description: 'Spec', body: 'spec body', related_to: 'rmxs-14' });
  await repo.create({ filename: 'notes.md', key: 'RMXS-14-NOTES', key_type: 'freeform', doc_type: 'other', description: 'Notes', body: 'notes body', related_to: 'RMXS-14' });
  await repo.create({ filename: 'unrelated.md', key: 'OTHER', key_type: 'freeform', doc_type: 'other', description: 'Other', body: 'x' });

  const fromSpec = repo.getRelated(repo.getByKey('RMXS-14-SPEC'));
  assert.deepEqual(fromSpec.map((d) => [path.basename(d.source_path), d.related_via]), [['plan.md', 'related_to']]);

  const fromPlan = repo.getRelated(repo.getByKey('RMXS-14'));
  assert.deepEqual(fromPlan.map((d) => [path.basename(d.source_path), d.related_via]).sort(), [
    ['notes.md', 'referenced_by'],
    ['spec.md', 'referenced_by'],
  ]);

  await repo.setPaused([{ filename: 'notes.md' }], true);
  assert.deepEqual(repo.getRelated(repo.getByKey('RMXS-14')).map((d) => path.basename(d.source_path)), ['spec.md']);
  assert.equal(repo.getRelated(repo.getByKey('RMXS-14'), { includePaused: true }).length, 2);
  assert.deepEqual(repo.getRelated(repo.getByKey('OTHER')), []);
  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('skill getExtendsChain walks base skills nearest first and stops at a cycle or a missing base', async () => {
  const skillDir = tmpDir();
  const db = openCache(':memory:');
  const repo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'folder', path: skillDir }]);
  const describe = (n: string) => `${n} skill. Use when testing.`;
  await repo.create({ name: 'base', description: describe('base') }, 'base body');
  await repo.create({ name: 'middle', description: describe('middle'), extends: 'base' }, 'middle body');
  await repo.create({ name: 'leaf', description: describe('leaf'), extends: 'middle' }, 'leaf body');
  await repo.create({ name: 'orphan', description: describe('orphan'), extends: 'no-such-skill' }, 'orphan body');
  await repo.create({ name: 'loop-a', description: describe('loop-a'), extends: 'loop-b' }, 'a');
  await repo.create({ name: 'loop-b', description: describe('loop-b'), extends: 'loop-a' }, 'b');

  const chainOf = async (name: string) => (await repo.getExtendsChain((await repo.get(name))!)).map((s) => s.name);
  assert.deepEqual(await chainOf('leaf'), ['middle', 'base']);
  assert.deepEqual(await chainOf('base'), []);
  assert.deepEqual(await chainOf('orphan'), []);
  assert.deepEqual(await chainOf('loop-a'), ['loop-b']);
  db.close();
  fs.rmSync(skillDir, { recursive: true, force: true });
});
