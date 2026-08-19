import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openCache } from '../src/store/db.js';
import { initialScan, skillSyncSpec, memorySyncSpec } from '../src/store/sync.js';
import { SkillRepository } from '../src/skills/repository.js';
import { MemoryRepository } from '../src/memory/repository.js';
import { relocate, relocateMany, inferMemoryFrontmatter } from '../src/shared/relocate.js';
import { isValidSkillName } from '../src/store/skill-name.js';
import { searchCombined, searchByDate, SearchQueryError } from '../src/store/search.js';
import { toLocalDate } from '../src/store/date-extract.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bucket-test-'));
}

test('skill create/get/list/update/delete round-trip, including nested subdirectories', () => {
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const roots = [{ name: 'builtin', path: '/nonexistent' }, { name: 'root', path: skillDir }];
  const spec = skillSyncSpec(roots);
  const repo = new SkillRepository(db, roots);

  const created = repo.create(
    { name: 'demo-skill', description: 'Demo skill. Use when testing.', owner: null, status: 'unreviewed', tags: ['demo'], trigger_phrases: ['demo'] },
    'Body text.'
  );
  initialScan(db, spec);
  assert.equal(repo.get('demo-skill')?.description, 'Demo skill. Use when testing.');
  assert.equal(created.source_path, path.join(skillDir, 'demo-skill', 'SKILL.md'));
  assert.equal(created.deprecated, false);
  assert.ok(created.created_at && !Number.isNaN(Date.parse(created.created_at)));

  // nested subdirectory: written directly (simulating an authored folder placed by hand),
  // per the agentskills.io spec: one folder per skill, name === folder name.
  const nestedSkillDir = path.join(skillDir, 'frontend', 'nested-skill');
  fs.mkdirSync(nestedSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(nestedSkillDir, 'SKILL.md'),
    `---\nname: "nested-skill"\ndescription: "Nested skill. Use when testing nesting."\ntags: []\ntrigger_phrases: []\n---\nNested body.\n`
  );
  initialScan(db, spec);
  const nested = repo.get('nested-skill');
  assert.equal(nested?.description, 'Nested skill. Use when testing nesting.');

  const listed = repo.list('demo');
  assert.ok(listed.some((s) => s.name === 'demo-skill'));

  const updated = repo.update('demo-skill', { status: 'stable' });
  assert.equal(updated.metadata.status, 'stable');

  repo.delete('demo-skill');
  assert.equal(repo.get('demo-skill'), null);
  assert.equal(fs.existsSync(path.join(skillDir, 'demo-skill')), false); // whole folder removed

  db.close();
  fs.rmSync(skillDir, { recursive: true, force: true });
});

test('memory create with folder param + getByKey exact match', () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'root', path: memDir }]);

  const doc = repo.create({
    key: 'rmxs-14',
    key_type: 'ticket',
    doc_type: 'plan',
    description: 'bulk edit plan',
    body: 'Plan body.',
    folder: 'rmxs',
  });
  assert.equal(doc.key, 'RMXS-14');
  assert.ok(doc.source_path.includes(path.join('rmxs', '')));
  assert.equal(doc.deprecated, false);
  assert.ok(doc.created_at && !Number.isNaN(Date.parse(doc.created_at)));

  const spec = memorySyncSpec([{ name: 'root', path: memDir }]);
  initialScan(db, spec);

  const found = repo.getByKey('rmxs-14');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.description, 'bulk edit plan');

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('resolveWithinBase rejects folder traversal', () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'root', path: memDir }]);

  assert.throws(() =>
    repo.create({
      key: 'ESCAPE-1',
      key_type: 'ticket',
      doc_type: 'other',
      description: 'attempt',
      body: 'x',
      folder: '../../etc',
    })
  );

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('inferMemoryFrontmatter parses the documented plan/spec naming convention', () => {
  const inferred = inferMemoryFrontmatter('/repo/docs/plans/2026-08-12-pde-433-partner-configuration-management-v3.md');
  assert.deepEqual(inferred, {
    key: 'PDE-433',
    key_type: 'ticket',
    doc_type: 'plan',
    description: 'partner configuration management v3',
  });
});

test('inferMemoryFrontmatter returns null on a weak/ambiguous filename', () => {
  assert.equal(inferMemoryFrontmatter('/repo/docs/plans/notes.md'), null);
});

test('relocate moves a file into memory and skips a repeat bulk relocate', () => {
  const memDir = makeTmpDir();
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const memoryRepo = new MemoryRepository(db, [{ name: 'root', path: memDir }]);
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'root', path: skillDir }]);

  const srcDir = makeTmpDir();
  const srcFile = path.join(srcDir, '2026-08-12-pde-433-partner-configuration-management-v3.md');
  fs.writeFileSync(srcFile, 'Some plan content.');

  const result = relocate({ path: srcFile, target: 'memory' }, skillRepo, memoryRepo);
  assert.equal(result.moved, true);
  assert.equal(fs.existsSync(srcFile), false); // moved, not copied

  // simulate a second bulk pass hitting the same logical doc again (e.g. re-created locally)
  fs.writeFileSync(srcFile, 'Some plan content.');
  const second = relocate({ path: srcFile, target: 'memory' }, skillRepo, memoryRepo);
  assert.equal(second.moved, false);
  assert.match(second.reason ?? '', /already relocated/);

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
  fs.rmSync(skillDir, { recursive: true, force: true });
  fs.rmSync(srcDir, { recursive: true, force: true });
});

test('relocate to skill requires an explicit description, but infers a valid name', () => {
  const memDir = makeTmpDir();
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const memoryRepo = new MemoryRepository(db, [{ name: 'root', path: memDir }]);
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'root', path: skillDir }]);

  const srcDir = makeTmpDir();
  const srcFile = path.join(srcDir, 'Lit Dropdown Pattern.md');
  fs.writeFileSync(srcFile, 'Skill body content.');

  const withoutDescription = relocate({ path: srcFile, target: 'skill' }, skillRepo, memoryRepo);
  assert.equal(withoutDescription.moved, false);
  assert.match(withoutDescription.reason ?? '', /description/);
  assert.equal(fs.existsSync(srcFile), true); // untouched — no partial write

  const withDescription = relocate(
    { path: srcFile, target: 'skill', overrides: { description: 'Lit dropdown pattern. Use when building a dropdown in Lit.' } },
    skillRepo,
    memoryRepo
  );
  assert.equal(withDescription.moved, true);
  assert.equal(withDescription.id, 'lit-dropdown-pattern');
  assert.equal(fs.existsSync(path.join(skillDir, 'lit-dropdown-pattern', 'SKILL.md')), true);

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
  fs.rmSync(skillDir, { recursive: true, force: true });
  fs.rmSync(srcDir, { recursive: true, force: true });
});

test('skill search finds body text via FTS5 and bulkUpdate merges/subtracts tags across a batch', () => {
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const roots = [{ name: 'builtin', path: '/nonexistent' }, { name: 'root', path: skillDir }];
  const repo = new SkillRepository(db, roots);

  repo.create(
    { name: 'blue-green-deploy', description: 'Deploy pattern.', tags: ['ops'], trigger_phrases: [] },
    'Explains how to roll back a blue green deployment safely.'
  );
  repo.create(
    { name: 'unrelated-skill', description: 'Something else.', tags: ['misc'], trigger_phrases: [] },
    'Nothing to do with the topic at hand.'
  );

  const hits = repo.search('deployment');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.name, 'blue-green-deploy');
  assert.match(hits[0]?.snippet ?? '', /deployment/);

  const results = repo.bulkUpdate(['blue-green-deploy', 'unrelated-skill', 'missing-skill'], {
    add_tags: ['reviewed'],
    remove_tags: ['misc'],
  });
  assert.deepEqual(
    results.map((r) => r.ok),
    [true, true, false]
  );
  assert.deepEqual(repo.get('blue-green-deploy')?.tags.sort(), ['ops', 'reviewed']);
  assert.deepEqual(repo.get('unrelated-skill')?.tags, ['reviewed']);

  db.close();
  fs.rmSync(skillDir, { recursive: true, force: true });
});

test('memory search finds body text via FTS5 and bulkUpdate flips status across a batch', () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'root', path: memDir }]);

  const doc1 = repo.create({ key: 'RMXS-1', key_type: 'ticket', doc_type: 'plan', description: 'first plan', body: 'Migrate the widget schema.' });
  const doc2 = repo.create({ key: 'RMXS-2', key_type: 'ticket', doc_type: 'plan', description: 'second plan', body: 'Totally unrelated notes.' });

  const hits = repo.search('migrate');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.id, doc1.id);

  const results = repo.bulkUpdate([doc1.id, doc2.id, 'missing-id'], { status: 'shipped' });
  assert.deepEqual(
    results.map((r) => r.ok),
    [true, true, false]
  );
  assert.equal(repo.get(doc1.id)?.status, 'shipped');
  assert.equal(repo.get(doc2.id)?.status, 'shipped');

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('skill search: status/tag filters and offset paginate correctly', () => {
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'root', path: skillDir }]);

  repo.create({ name: 'skill-a', description: 'A', tags: ['ops'], status: 'stable', trigger_phrases: [] }, 'Widget migration notes for skill A.');
  repo.create({ name: 'skill-b', description: 'B', tags: ['misc'], status: 'unreviewed', trigger_phrases: [] }, 'Widget migration notes for skill B.');
  repo.create({ name: 'skill-c', description: 'C', tags: ['ops'], status: 'stable', trigger_phrases: [] }, 'Widget migration notes for skill C.');

  const stableOnly = repo.search('widget', { status: 'stable' });
  assert.deepEqual(stableOnly.map((h) => h.name).sort(), ['skill-a', 'skill-c']);

  const opsOnly = repo.search('widget', { tag: 'ops' });
  assert.deepEqual(opsOnly.map((h) => h.name).sort(), ['skill-a', 'skill-c']);

  const page1 = repo.search('widget', { limit: 1, offset: 0 });
  const page2 = repo.search('widget', { limit: 1, offset: 1 });
  assert.equal(page1.length, 1);
  assert.equal(page2.length, 1);
  assert.notEqual(page1[0]?.name, page2[0]?.name);

  db.close();
  fs.rmSync(skillDir, { recursive: true, force: true });
});

test('bucket_search finds hits across both skills and memory docs, ranked together', () => {
  const skillDir = makeTmpDir();
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'root', path: skillDir }]);
  const memoryRepo = new MemoryRepository(db, [{ name: 'root', path: memDir }]);

  skillRepo.create({ name: 'widget-skill', description: 'Widget skill.', tags: [], trigger_phrases: [] }, 'A widget pattern.');
  memoryRepo.create({ key: 'RMXS-9', key_type: 'ticket', doc_type: 'plan', description: 'widget plan', body: 'A widget migration plan.' });

  const hits = searchCombined(db, 'widget');
  assert.deepEqual(
    hits.map((h) => h.ref_table).sort(),
    ['memory_docs', 'skills']
  );

  db.close();
  fs.rmSync(skillDir, { recursive: true, force: true });
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('search throws a SearchQueryError with actionable guidance on malformed FTS5 syntax', () => {
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'root', path: skillDir }]);

  assert.throws(() => repo.search('blue-green'), (err: unknown) => {
    assert.ok(err instanceof SearchQueryError);
    assert.match((err as Error).message, /must be quoted/);
    return true;
  });

  db.close();
  fs.rmSync(skillDir, { recursive: true, force: true });
});

test('skill bulkGet/bulkCreate/bulkDelete: partial failures do not abort the batch', () => {
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'root', path: skillDir }]);

  repo.create({ name: 'existing-skill', description: 'Pre-existing.', tags: [], trigger_phrases: [] }, 'Body.');

  const createResults = repo.bulkCreate([
    { frontmatter: { name: 'new-skill-1', description: 'New one.', tags: [], trigger_phrases: [] }, body: 'Body 1.' },
    { frontmatter: { name: 'existing-skill', description: 'Duplicate.', tags: [], trigger_phrases: [] }, body: 'Body dup.' }, // collides
    { frontmatter: { name: 'new-skill-2', description: 'Another.', tags: [], trigger_phrases: [] }, body: 'Body 2.' },
  ]);
  assert.deepEqual(
    createResults.map((r) => r.ok),
    [true, false, true]
  );

  const fetched = repo.bulkGet(['new-skill-1', 'new-skill-2', 'missing-skill']);
  assert.deepEqual(fetched.map((d) => d.name).sort(), ['new-skill-1', 'new-skill-2']);

  const deleteResults = repo.bulkDelete(['new-skill-1', 'missing-skill', 'new-skill-2']);
  assert.deepEqual(
    deleteResults.map((r) => r.ok),
    [true, false, true]
  );
  assert.equal(repo.get('new-skill-1'), null);
  assert.equal(repo.get('new-skill-2'), null);

  db.close();
  fs.rmSync(skillDir, { recursive: true, force: true });
});

test('memory bulkGet/bulkCreate/bulkDelete: partial failures do not abort the batch', () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'root', path: memDir }]);

  const createResults = repo.bulkCreate([
    { key: 'RMXS-10', key_type: 'ticket', doc_type: 'plan', description: 'plan a', body: 'Body a.' },
    { key: 'RMXS-11', key_type: 'ticket', doc_type: 'plan', description: 'plan b', body: 'Body b.', folder: '../../etc' }, // traversal fails
    { key: 'RMXS-12', key_type: 'ticket', doc_type: 'plan', description: 'plan c', body: 'Body c.' },
  ]);
  assert.deepEqual(
    createResults.map((r) => r.ok),
    [true, false, true]
  );
  const id1 = createResults[0]!.id!;
  const id3 = createResults[2]!.id!;

  const fetched = repo.bulkGet([id1, id3, 'missing-id']);
  assert.deepEqual(fetched.map((d) => d.id).sort(), [id1, id3].sort());

  const deleteResults = repo.bulkDelete([id1, 'missing-id', id3]);
  assert.deepEqual(
    deleteResults.map((r) => r.ok),
    [true, false, true]
  );
  assert.equal(repo.get(id1), null);
  assert.equal(repo.get(id3), null);

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('relocateMany relocates each file independently, one bad entry does not block the rest', () => {
  const memDir = makeTmpDir();
  const skillDir = makeTmpDir();
  const srcDir = makeTmpDir();
  const db = openCache(':memory:');
  const memoryRepo = new MemoryRepository(db, [{ name: 'root', path: memDir }]);
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'root', path: skillDir }]);

  const goodFile = path.join(srcDir, '2026-08-12-pde-500-good-relocate.md');
  const ambiguousFile = path.join(srcDir, 'notes.md');
  fs.writeFileSync(goodFile, 'Good content.');
  fs.writeFileSync(ambiguousFile, 'Ambiguous content.');

  const results = relocateMany(
    [
      { path: goodFile, target: 'memory' },
      { path: ambiguousFile, target: 'memory' },
    ],
    skillRepo,
    memoryRepo
  );
  assert.equal(results[0]?.moved, true);
  assert.equal(results[1]?.moved, false);
  assert.equal(fs.existsSync(goodFile), false);
  assert.equal(fs.existsSync(ambiguousFile), true); // untouched — no partial write

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
  fs.rmSync(skillDir, { recursive: true, force: true });
  fs.rmSync(srcDir, { recursive: true, force: true });
});

test('skill bulkUpdate flips deprecated across a batch, partial failure does not abort the rest', () => {
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'root', path: skillDir }]);

  repo.create({ name: 'skill-x', description: 'X', tags: [], trigger_phrases: [] }, 'Body X.');
  repo.create({ name: 'skill-y', description: 'Y', tags: [], trigger_phrases: [] }, 'Body Y.');

  const results = repo.bulkUpdate(['skill-x', 'skill-y', 'missing-skill'], { deprecated: true });
  assert.deepEqual(
    results.map((r) => r.ok),
    [true, true, false]
  );
  assert.equal(repo.get('skill-x')?.deprecated, true);
  assert.equal(repo.get('skill-y')?.deprecated, true);

  const undone = repo.bulkUpdate(['skill-x'], { deprecated: false });
  assert.equal(undone[0]?.ok, true);
  assert.equal(repo.get('skill-x')?.deprecated, false);

  db.close();
  fs.rmSync(skillDir, { recursive: true, force: true });
});

test('builtin skills cannot be deprecated or deleted, individually or via bulk ops', () => {
  const builtinDir = makeTmpDir();
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new SkillRepository(db, [{ name: 'builtin', path: builtinDir }, { name: 'root', path: skillDir }]);

  // create() can't target roots[0] (builtin is never user-addable), so simulate the server's
  // builtin-skills bootstrap by writing the file directly and rescanning.
  const builtinSkillDir = path.join(builtinDir, 'authoring-guide');
  fs.mkdirSync(builtinSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(builtinSkillDir, 'SKILL.md'),
    `---\nname: "authoring-guide"\ndescription: "Builtin guide."\ntags: []\ntrigger_phrases: []\n---\nBody.\n`
  );
  initialScan(db, skillSyncSpec([{ name: 'builtin', path: builtinDir }, { name: 'root', path: skillDir }]));

  repo.create({ name: 'user-skill', description: 'User skill.', tags: [], trigger_phrases: [] }, 'Body.');

  // update() silently ignores an attempt to set deprecated on a builtin doc.
  const updated = repo.update('authoring-guide', { deprecated: true });
  assert.equal(updated.deprecated, false);

  // bulkUpdate: builtin doc's deprecated flag is skipped, but a mixed batch's non-builtin
  // entries and other fields still apply — reported as ok, not as a failure.
  const results = repo.bulkUpdate(['authoring-guide', 'user-skill'], { deprecated: true, add_tags: ['x'] });
  assert.deepEqual(
    results.map((r) => r.ok),
    [true, true]
  );
  assert.equal(repo.get('authoring-guide')?.deprecated, false);
  assert.deepEqual(repo.get('authoring-guide')?.tags, ['x']); // non-deprecated fields still applied
  assert.equal(repo.get('user-skill')?.deprecated, true);

  // delete() and bulkDelete() refuse to remove a builtin doc.
  assert.throws(() => repo.delete('authoring-guide'), /builtin/);
  const deleteResults = repo.bulkDelete(['authoring-guide', 'user-skill']);
  assert.equal(deleteResults[0]?.ok, false);
  assert.match(deleteResults[0]?.error ?? '', /builtin/);
  assert.equal(deleteResults[1]?.ok, true);
  assert.ok(repo.get('authoring-guide')); // still present
  assert.equal(repo.get('user-skill'), null); // non-builtin deleted normally

  db.close();
  fs.rmSync(builtinDir, { recursive: true, force: true });
  fs.rmSync(skillDir, { recursive: true, force: true });
});

test('memory bulkUpdate flips deprecated across a batch, partial failure does not abort the rest', () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'root', path: memDir }]);

  const doc1 = repo.create({ key: 'RMXS-20', key_type: 'ticket', doc_type: 'plan', description: 'a', body: 'Body a.' });
  const doc2 = repo.create({ key: 'RMXS-21', key_type: 'ticket', doc_type: 'plan', description: 'b', body: 'Body b.' });

  const results = repo.bulkUpdate([doc1.id, doc2.id, 'missing-id'], { deprecated: true });
  assert.deepEqual(
    results.map((r) => r.ok),
    [true, true, false]
  );
  assert.equal(repo.get(doc1.id)?.deprecated, true);
  assert.equal(repo.get(doc2.id)?.deprecated, true);

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('ensureColumns migration adds deprecated/created_at columns to a pre-existing schema', () => {
  // openCache uses CREATE TABLE IF NOT EXISTS, so it won't retroactively add columns to an
  // existing file — simulate a cache file predating deprecated/created_at, then reopen via
  // openCache and confirm the migration backfills both columns.
  const dbPath = path.join(makeTmpDir(), 'cache.db');
  const preMigration = new Database(dbPath);
  preMigration.exec(`
    CREATE TABLE skills (
      id TEXT PRIMARY KEY, description TEXT NOT NULL, owner TEXT, status TEXT NOT NULL,
      tags TEXT NOT NULL, trigger_phrases TEXT NOT NULL, extends TEXT,
      source_path TEXT NOT NULL UNIQUE, root TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL, mtime_ms INTEGER NOT NULL
    );
    CREATE TABLE memory_docs (
      id TEXT PRIMARY KEY, key TEXT NOT NULL, key_type TEXT NOT NULL, description TEXT NOT NULL,
      doc_type TEXT NOT NULL, tags TEXT NOT NULL, status TEXT NOT NULL, related_to TEXT,
      source_path TEXT NOT NULL UNIQUE, root TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL, mtime_ms INTEGER NOT NULL
    );
  `);
  preMigration.close();

  const migrated = openCache(dbPath);
  const skillCols = new Set(
    (migrated.prepare(`PRAGMA table_info(skills)`).all() as Array<{ name: string }>).map((c) => c.name)
  );
  const memoryCols = new Set(
    (migrated.prepare(`PRAGMA table_info(memory_docs)`).all() as Array<{ name: string }>).map((c) => c.name)
  );
  assert.ok(skillCols.has('deprecated'));
  assert.ok(skillCols.has('created_at'));
  assert.ok(memoryCols.has('deprecated'));
  assert.ok(memoryCols.has('created_at'));
  migrated.close();
});

test('relocate preserves created_at on the resulting doc', () => {
  const memDir = makeTmpDir();
  const skillDir = makeTmpDir();
  const srcDir = makeTmpDir();
  const db = openCache(':memory:');
  const memoryRepo = new MemoryRepository(db, [{ name: 'root', path: memDir }]);
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'root', path: skillDir }]);

  const srcFile = path.join(srcDir, '2026-08-12-pde-600-relocate-created-at.md');
  fs.writeFileSync(srcFile, 'Some plan content.');

  const result = relocate({ path: srcFile, target: 'memory' }, skillRepo, memoryRepo);
  assert.equal(result.moved, true);
  const doc = memoryRepo.get(result.id!);
  assert.ok(doc?.created_at && !Number.isNaN(Date.parse(doc.created_at)));

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
  fs.rmSync(skillDir, { recursive: true, force: true });
  fs.rmSync(srcDir, { recursive: true, force: true });
});

test('isValidSkillName enforces the agentskills.io name constraints', () => {
  assert.equal(isValidSkillName('pdf-processing'), true);
  assert.equal(isValidSkillName('PDF-Processing'), false); // uppercase
  assert.equal(isValidSkillName('-pdf'), false); // leading hyphen
  assert.equal(isValidSkillName('pdf--processing'), false); // consecutive hyphens
  assert.equal(isValidSkillName('a'.repeat(65)), false); // too long
});

test('searchByDate finds memory docs and skills by dates mentioned in their body', () => {
  const memDir = makeTmpDir();
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const memoryRepo = new MemoryRepository(db, [{ name: 'root', path: memDir }]);
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'root', path: skillDir }]);

  memoryRepo.create({
    key: 'date-test',
    key_type: 'freeform',
    doc_type: 'session-summary',
    description: 'Session with dates',
    body: 'Started work on 2026-08-10, wrapped up on 2026-08-12 after review.',
  });
  memoryRepo.create({
    key: 'no-date-test',
    key_type: 'freeform',
    doc_type: 'session-summary',
    description: 'Session without dates',
    body: 'No dates mentioned in this one at all.',
  });
  skillRepo.create(
    {
      name: 'dated-skill',
      description: 'Skill with a date. Use for testing search_by_date.',
      owner: null,
      status: 'unreviewed',
      tags: [],
      trigger_phrases: [],
    },
    'Introduced on Jan 15, 2026 as a pattern.'
  );

  // 2026-08-10 is a body-mentioned date; created_at (today, some other date
  // this test run) is also indexed but falls outside this narrow range, so
  // only the body match shows up here.
  const hits = searchByDate(db, '2026-08-10', '2026-08-10');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.ref_table, 'memory_docs');
  assert.equal(hits[0]?.matched_date, '2026-08-10');
  assert.ok(hits[0]?.snippet.includes('<<2026-08-10>>'));

  const skillHits = searchByDate(db, '2026-01-15', '2026-01-15', { table: 'skills' });
  assert.equal(skillHits.length, 1);
  assert.equal(skillHits[0]?.ref_id, 'dated-skill');

  const outOfRange = searchByDate(db, '2020-01-01', '2020-01-31');
  assert.equal(outOfRange.length, 0);

  assert.throws(() => searchByDate(db, '2026-08-31', '2026-08-01'), /invalid date range/);

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
  fs.rmSync(skillDir, { recursive: true, force: true });
});

test('searchByDate also matches on created_at when no date is mentioned in the body', () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const memoryRepo = new MemoryRepository(db, [{ name: 'root', path: memDir }]);

  const doc = memoryRepo.create({
    key: 'created-at-only',
    key_type: 'freeform',
    doc_type: 'session-summary',
    description: 'No dates in body',
    body: 'Nothing date-like mentioned here.',
  });
  const createdDate = toLocalDate(doc.created_at!);

  const hits = searchByDate(db, createdDate, createdDate);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.ref_id, doc.id);
  assert.equal(hits[0]?.matched_date, createdDate);
  assert.ok(hits[0]?.snippet.includes('matched via created_at'));

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('wiping all cache tables and re-running initialScan fully restores state from disk (bucket_rebuild_cache mechanics)', () => {
  const memDir = makeTmpDir();
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const skillSpec = skillSyncSpec([{ name: 'builtin', path: '/nonexistent' }, { name: 'root', path: skillDir }]);
  const memorySpec = memorySyncSpec([{ name: 'root', path: memDir }]);
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'root', path: skillDir }]);
  const memoryRepo = new MemoryRepository(db, [{ name: 'root', path: memDir }]);

  memoryRepo.create({
    key: 'rebuild-test',
    key_type: 'freeform',
    doc_type: 'session-summary',
    description: 'Rebuild target',
    body: 'Happened on 2026-07-04.',
  });
  skillRepo.create(
    { name: 'rebuild-skill', description: 'For rebuild testing. Use to test rebuild.', owner: null, status: 'unreviewed', tags: [], trigger_phrases: [] },
    'Body text.'
  );

  // Simulate the tool's wipe: delete all four derived tables directly (source
  // files on disk are untouched).
  db.exec(`DELETE FROM skills; DELETE FROM memory_docs; DELETE FROM search_index; DELETE FROM doc_dates;`);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM memory_docs`).get() as { n: number }).n, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM doc_dates`).get() as { n: number }).n, 0);

  initialScan(db, skillSpec);
  initialScan(db, memorySpec);

  const restoredMemory = memoryRepo.getByKey('rebuild-test');
  assert.equal(restoredMemory.length, 1);
  assert.equal(restoredMemory[0]?.description, 'Rebuild target');
  assert.ok(skillRepo.get('rebuild-skill'));
  assert.equal(searchByDate(db, '2026-07-04', '2026-07-04').length, 1);

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
  fs.rmSync(skillDir, { recursive: true, force: true });
});

test('searchByDate reflects doc_dates cleanup after deletion', () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const memoryRepo = new MemoryRepository(db, [{ name: 'root', path: memDir }]);

  const doc = memoryRepo.create({
    key: 'delete-test',
    key_type: 'freeform',
    doc_type: 'session-summary',
    description: 'To be deleted',
    body: 'Happened on 2026-05-01.',
  });
  assert.equal(searchByDate(db, '2026-05-01', '2026-05-01').length, 1);

  memoryRepo.delete(doc.id);
  assert.equal(searchByDate(db, '2026-05-01', '2026-05-01').length, 0);

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});
