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
import { applyBodyEdits, formatBodyEditsDiff } from '../src/shared/body-edits.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bucket-test-'));
}

test('skill create/get/list/update/delete round-trip, including nested subdirectories', async () => {
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const folders = [{ name: 'builtin', path: '/nonexistent' }, { name: 'folder', path: skillDir }];
  const spec = skillSyncSpec(folders);
  const repo = new SkillRepository(db, folders);

  const created = await repo.create(
    { name: 'demo-skill', description: 'Demo skill. Use when testing.', owner: null, status: 'unreviewed', tags: ['demo'], trigger_phrases: ['demo'] },
    'Body text.'
  );
  initialScan(db, spec);
  assert.equal((await repo.get('demo-skill'))?.description, 'Demo skill. Use when testing.');
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
  const nested = await repo.get('nested-skill');
  assert.equal(nested?.description, 'Nested skill. Use when testing nesting.');

  const listed = repo.list('demo');
  assert.ok(listed.some((s) => s.name === 'demo-skill'));

  const updated = await repo.update('demo-skill', { status: 'stable' });
  assert.equal(updated.metadata.status, 'stable');

  await repo.delete('demo-skill');
  assert.equal(await repo.get('demo-skill'), null);
  assert.equal(fs.existsSync(path.join(skillDir, 'demo-skill')), false); // whole folder removed

  db.close();
  fs.rmSync(skillDir, { recursive: true, force: true });
});

test('memory create with subfolder param + getByKey exact match', async () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);

  const doc = await repo.create({
    key: 'rmxs-14',
    key_type: 'ticket',
    doc_type: 'plan',
    description: 'bulk edit plan',
    body: 'Plan body.',
    subfolder: 'rmxs',
  });
  assert.equal(doc.key, 'RMXS-14');
  assert.ok(doc.source_path.includes(path.join('rmxs', '')));
  assert.equal(doc.deprecated, false);
  assert.ok(doc.created_at && !Number.isNaN(Date.parse(doc.created_at)));

  const spec = memorySyncSpec([{ name: 'folder', path: memDir }]);
  initialScan(db, spec);

  const found = repo.getByKey('rmxs-14');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.description, 'bulk edit plan');

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('resolveWithinBase rejects folder traversal', async () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);

  await assert.rejects(() =>
    repo.create({
      key: 'ESCAPE-1',
      key_type: 'ticket',
      doc_type: 'other',
      description: 'attempt',
      body: 'x',
      subfolder: '../../etc',
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

test('relocate moves a file into memory and skips a repeat bulk relocate', async () => {
  const memDir = makeTmpDir();
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const memoryRepo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'folder', path: skillDir }]);

  const srcDir = makeTmpDir();
  const srcFile = path.join(srcDir, '2026-08-12-pde-433-partner-configuration-management-v3.md');
  fs.writeFileSync(srcFile, 'Some plan content.');

  const result = await relocate({ path: srcFile, target: 'memory' }, skillRepo, memoryRepo);
  assert.equal(result.moved, true);
  assert.equal(fs.existsSync(srcFile), false); // moved, not copied

  // simulate a second bulk pass hitting the same logical doc again (e.g. re-created locally)
  fs.writeFileSync(srcFile, 'Some plan content.');
  const second = await relocate({ path: srcFile, target: 'memory' }, skillRepo, memoryRepo);
  assert.equal(second.moved, false);
  assert.match(second.reason ?? '', /already relocated/);

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
  fs.rmSync(skillDir, { recursive: true, force: true });
  fs.rmSync(srcDir, { recursive: true, force: true });
});

test('relocate to skill requires an explicit description, but infers a valid name', async () => {
  const memDir = makeTmpDir();
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const memoryRepo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'folder', path: skillDir }]);

  const srcDir = makeTmpDir();
  const srcFile = path.join(srcDir, 'Lit Dropdown Pattern.md');
  fs.writeFileSync(srcFile, 'Skill body content.');

  const withoutDescription = await relocate({ path: srcFile, target: 'skill' }, skillRepo, memoryRepo);
  assert.equal(withoutDescription.moved, false);
  assert.match(withoutDescription.reason ?? '', /description/);
  assert.equal(fs.existsSync(srcFile), true); // untouched — no partial write

  const withDescription = await relocate(
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

test('skill search finds body text via FTS5 and bulkUpdate merges/subtracts tags across a batch', async () => {
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const folders = [{ name: 'builtin', path: '/nonexistent' }, { name: 'folder', path: skillDir }];
  const repo = new SkillRepository(db, folders);

  await repo.create(
    { name: 'blue-green-deploy', description: 'Deploy pattern.', tags: ['ops'], trigger_phrases: [] },
    'Explains how to roll back a blue green deployment safely.'
  );
  await repo.create(
    { name: 'unrelated-skill', description: 'Something else.', tags: ['misc'], trigger_phrases: [] },
    'Nothing to do with the topic at hand.'
  );

  const hits = repo.search('deployment');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.name, 'blue-green-deploy');
  assert.match(hits[0]?.snippet ?? '', /deployment/);

  const results = await repo.bulkUpdate(['blue-green-deploy', 'unrelated-skill', 'missing-skill'], {
    add_tags: ['reviewed'],
    remove_tags: ['misc'],
  });
  assert.deepEqual(
    results.map((r) => r.ok),
    [true, true, false]
  );
  assert.deepEqual((await repo.get('blue-green-deploy'))?.tags.sort(), ['ops', 'reviewed']);
  assert.deepEqual((await repo.get('unrelated-skill'))?.tags, ['reviewed']);

  db.close();
  fs.rmSync(skillDir, { recursive: true, force: true });
});

test('memory search finds body text via FTS5 and bulkUpdate flips status across a batch', async () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);

  const doc1 = await repo.create({ key: 'RMXS-1', key_type: 'ticket', doc_type: 'plan', description: 'first plan', body: 'Migrate the widget schema.' });
  const doc2 = await repo.create({ key: 'RMXS-2', key_type: 'ticket', doc_type: 'plan', description: 'second plan', body: 'Totally unrelated notes.' });

  const hits = repo.search('migrate');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.id, doc1.id);

  const results = await repo.bulkUpdate([doc1.id, doc2.id, 'missing-id'], { status: 'shipped' });
  assert.deepEqual(
    results.map((r) => r.ok),
    [true, true, false]
  );
  assert.equal((await repo.get(doc1.id))?.status, 'shipped');
  assert.equal((await repo.get(doc2.id))?.status, 'shipped');

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('memory doc key is searchable via FTS even when the key never appears in description/body', async () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);

  await repo.create({
    key: 'RMXS-15',
    key_type: 'ticket',
    doc_type: 'plan',
    description: 'campaign eligibility postbacks', // deliberately no "RMXS-15" in text
    body: 'Body text with no mention of the ticket id either.',
  });

  const hits = repo.search('"RMXS-15"'); // quoted: isolates the indexing fix from query-sanitization (a later task)
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.key, 'RMXS-15');

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('bare hyphenated key search does not silently return zero results', async () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);

  await repo.create({
    key: 'RMXS-15',
    key_type: 'ticket',
    doc_type: 'plan',
    description: 'campaign eligibility postbacks',
    body: 'Body text with no mention of the ticket id either.',
  });

  // Bare, unquoted, exactly what a user would type into the web UI search box.
  const hits = repo.search('RMXS-15');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.key, 'RMXS-15');

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('skill search: status/tag filters and offset paginate correctly', async () => {
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'folder', path: skillDir }]);

  await repo.create({ name: 'skill-a', description: 'A', tags: ['ops'], status: 'stable', trigger_phrases: [] }, 'Widget migration notes for skill A.');
  await repo.create({ name: 'skill-b', description: 'B', tags: ['misc'], status: 'unreviewed', trigger_phrases: [] }, 'Widget migration notes for skill B.');
  await repo.create({ name: 'skill-c', description: 'C', tags: ['ops'], status: 'stable', trigger_phrases: [] }, 'Widget migration notes for skill C.');

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

test('bucket_search finds hits across both skills and memory docs, ranked together', async () => {
  const skillDir = makeTmpDir();
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'folder', path: skillDir }]);
  const memoryRepo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);

  await skillRepo.create({ name: 'widget-skill', description: 'Widget skill.', tags: [], trigger_phrases: [] }, 'A widget pattern.');
  await memoryRepo.create({ key: 'RMXS-9', key_type: 'ticket', doc_type: 'plan', description: 'widget plan', body: 'A widget migration plan.' });

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
  const repo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'folder', path: skillDir }]);

  // An unterminated quote survives sanitizeFtsQuery unchanged (it already "starts with a quote")
  // and is still invalid FTS5 syntax, so this still exercises the SearchQueryError path.
  assert.throws(() => repo.search('"unterminated'), (err: unknown) => {
    assert.ok(err instanceof SearchQueryError);
    assert.match((err as Error).message, /must be quoted/);
    return true;
  });

  db.close();
  fs.rmSync(skillDir, { recursive: true, force: true });
});

test('skill bulkGet/bulkCreate/bulkDelete: partial failures do not abort the batch', async () => {
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'folder', path: skillDir }]);

  await repo.create({ name: 'existing-skill', description: 'Pre-existing.', tags: [], trigger_phrases: [] }, 'Body.');

  const createResults = await repo.bulkCreate([
    { frontmatter: { name: 'new-skill-1', description: 'New one.', tags: [], trigger_phrases: [] }, body: 'Body 1.' },
    { frontmatter: { name: 'existing-skill', description: 'Duplicate.', tags: [], trigger_phrases: [] }, body: 'Body dup.' }, // collides
    { frontmatter: { name: 'new-skill-2', description: 'Another.', tags: [], trigger_phrases: [] }, body: 'Body 2.' },
  ]);
  assert.deepEqual(
    createResults.map((r) => r.ok),
    [true, false, true]
  );

  const fetched = await repo.bulkGet(['new-skill-1', 'new-skill-2', 'missing-skill']);
  assert.deepEqual(fetched.map((d) => d.name).sort(), ['new-skill-1', 'new-skill-2']);

  const deleteResults = await repo.bulkDelete(['new-skill-1', 'missing-skill', 'new-skill-2']);
  assert.deepEqual(
    deleteResults.map((r) => r.ok),
    [true, false, true]
  );
  assert.equal(await repo.get('new-skill-1'), null);
  assert.equal(await repo.get('new-skill-2'), null);

  db.close();
  fs.rmSync(skillDir, { recursive: true, force: true });
});

test('memory bulkGet/bulkCreate/bulkDelete: partial failures do not abort the batch', async () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);

  const createResults = await repo.bulkCreate([
    { key: 'RMXS-10', key_type: 'ticket', doc_type: 'plan', description: 'plan a', body: 'Body a.' },
    { key: 'RMXS-11', key_type: 'ticket', doc_type: 'plan', description: 'plan b', body: 'Body b.', subfolder: '../../etc' }, // traversal fails
    { key: 'RMXS-12', key_type: 'ticket', doc_type: 'plan', description: 'plan c', body: 'Body c.' },
  ]);
  assert.deepEqual(
    createResults.map((r) => r.ok),
    [true, false, true]
  );
  const id1 = createResults[0]!.id!;
  const id3 = createResults[2]!.id!;

  const fetched = await repo.bulkGet([id1, id3, 'missing-id']);
  assert.deepEqual(fetched.map((d) => d.id).sort(), [id1, id3].sort());

  const deleteResults = await repo.bulkDelete([id1, 'missing-id', id3]);
  assert.deepEqual(
    deleteResults.map((r) => r.ok),
    [true, false, true]
  );
  assert.equal(await repo.get(id1), null);
  assert.equal(await repo.get(id3), null);

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('relocateMany relocates each file independently, one bad entry does not block the rest', async () => {
  const memDir = makeTmpDir();
  const skillDir = makeTmpDir();
  const srcDir = makeTmpDir();
  const db = openCache(':memory:');
  const memoryRepo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'folder', path: skillDir }]);

  const goodFile = path.join(srcDir, '2026-08-12-pde-500-good-relocate.md');
  const ambiguousFile = path.join(srcDir, 'notes.md');
  fs.writeFileSync(goodFile, 'Good content.');
  fs.writeFileSync(ambiguousFile, 'Ambiguous content.');

  const results = await relocateMany(
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

test('skill bulkUpdate flips deprecated across a batch, partial failure does not abort the rest', async () => {
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'folder', path: skillDir }]);

  await repo.create({ name: 'skill-x', description: 'X', tags: [], trigger_phrases: [] }, 'Body X.');
  await repo.create({ name: 'skill-y', description: 'Y', tags: [], trigger_phrases: [] }, 'Body Y.');

  const results = await repo.bulkUpdate(['skill-x', 'skill-y', 'missing-skill'], { deprecated: true });
  assert.deepEqual(
    results.map((r) => r.ok),
    [true, true, false]
  );
  assert.equal((await repo.get('skill-x'))?.deprecated, true);
  assert.equal((await repo.get('skill-y'))?.deprecated, true);

  const undone = await repo.bulkUpdate(['skill-x'], { deprecated: false });
  assert.equal(undone[0]?.ok, true);
  assert.equal((await repo.get('skill-x'))?.deprecated, false);

  db.close();
  fs.rmSync(skillDir, { recursive: true, force: true });
});

test('builtin skills cannot be deprecated or deleted, individually or via bulk ops', async () => {
  const builtinDir = makeTmpDir();
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new SkillRepository(db, [{ name: 'builtin', path: builtinDir }, { name: 'folder', path: skillDir }]);

  // create() can't target folders[0] (builtin is never user-addable), so simulate the server's
  // builtin-skills bootstrap by writing the file directly and rescanning.
  const builtinSkillDir = path.join(builtinDir, 'authoring-guide');
  fs.mkdirSync(builtinSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(builtinSkillDir, 'SKILL.md'),
    `---\nname: "authoring-guide"\ndescription: "Builtin guide."\ntags: []\ntrigger_phrases: []\n---\nBody.\n`
  );
  initialScan(db, skillSyncSpec([{ name: 'builtin', path: builtinDir }, { name: 'folder', path: skillDir }]));

  await repo.create({ name: 'user-skill', description: 'User skill.', tags: [], trigger_phrases: [] }, 'Body.');

  // update() silently ignores an attempt to set deprecated on a builtin doc.
  const updated = await repo.update('authoring-guide', { deprecated: true });
  assert.equal(updated.deprecated, false);

  // bulkUpdate: builtin doc's deprecated flag is skipped, but a mixed batch's non-builtin
  // entries and other fields still apply — reported as ok, not as a failure.
  const results = await repo.bulkUpdate(['authoring-guide', 'user-skill'], { deprecated: true, add_tags: ['x'] });
  assert.deepEqual(
    results.map((r) => r.ok),
    [true, true]
  );
  assert.equal((await repo.get('authoring-guide'))?.deprecated, false);
  assert.deepEqual((await repo.get('authoring-guide'))?.tags, ['x']); // non-deprecated fields still applied
  assert.equal((await repo.get('user-skill'))?.deprecated, true);

  // delete() and bulkDelete() refuse to remove a builtin doc.
  await assert.rejects(() => repo.delete('authoring-guide'), /builtin/);
  const deleteResults = await repo.bulkDelete(['authoring-guide', 'user-skill']);
  assert.equal(deleteResults[0]?.ok, false);
  assert.match(deleteResults[0]?.error ?? '', /builtin/);
  assert.equal(deleteResults[1]?.ok, true);
  assert.ok(await repo.get('authoring-guide')); // still present
  assert.equal(await repo.get('user-skill'), null); // non-builtin deleted normally

  db.close();
  fs.rmSync(builtinDir, { recursive: true, force: true });
  fs.rmSync(skillDir, { recursive: true, force: true });
});

test('memory bulkUpdate flips deprecated across a batch, partial failure does not abort the rest', async () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);

  const doc1 = await repo.create({ key: 'RMXS-20', key_type: 'ticket', doc_type: 'plan', description: 'a', body: 'Body a.' });
  const doc2 = await repo.create({ key: 'RMXS-21', key_type: 'ticket', doc_type: 'plan', description: 'b', body: 'Body b.' });

  const results = await repo.bulkUpdate([doc1.id, doc2.id, 'missing-id'], { deprecated: true });
  assert.deepEqual(
    results.map((r) => r.ok),
    [true, true, false]
  );
  assert.equal((await repo.get(doc1.id))?.deprecated, true);
  assert.equal((await repo.get(doc2.id))?.deprecated, true);

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
      source_path TEXT NOT NULL UNIQUE, folder TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL, mtime_ms INTEGER NOT NULL
    );
    CREATE TABLE memory_docs (
      id TEXT PRIMARY KEY, key TEXT NOT NULL, key_type TEXT NOT NULL, description TEXT NOT NULL,
      doc_type TEXT NOT NULL, tags TEXT NOT NULL, status TEXT NOT NULL, related_to TEXT,
      source_path TEXT NOT NULL UNIQUE, folder TEXT NOT NULL DEFAULT '',
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
  assert.ok(skillCols.has('paused'));
  assert.ok(memoryCols.has('deprecated'));
  assert.ok(memoryCols.has('created_at'));
  assert.ok(memoryCols.has('paused'));
  migrated.close();
});

test('skill setPaused hides skills from list/search by default, never writes paused into SKILL.md', async () => {
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'folder', path: skillDir }]);

  const created = await repo.create({ name: 'pausable', description: 'Pausable skill.', tags: [], trigger_phrases: [] }, 'Body text.');
  assert.equal(created.paused, false);

  const results = await repo.setPaused(['pausable', 'missing-skill'], true);
  assert.deepEqual(
    results.map((r) => r.ok),
    [true, false]
  );
  assert.equal((await repo.get('pausable'))?.paused, true);

  // Hidden from discovery by default...
  assert.equal(repo.list().some((s) => s.name === 'pausable'), false);
  assert.equal(repo.search('pausable').some((s) => s.name === 'pausable'), false);
  // ...but visible with includePaused, and always fetchable directly by name.
  assert.equal(repo.list(undefined, undefined, { includePaused: true }).some((s) => s.name === 'pausable'), true);
  assert.equal(repo.search('pausable', { includePaused: true }).some((s) => s.name === 'pausable'), true);
  assert.ok(await repo.get('pausable'));

  // The toggle is local-only — it must never end up in the SKILL.md frontmatter on disk.
  const raw = fs.readFileSync(path.join(skillDir, 'pausable', 'SKILL.md'), 'utf-8');
  assert.doesNotMatch(raw, /paused/);

  // update() must round-trip the file without disturbing the paused flag or leaking it into the file.
  const updated = await repo.update('pausable', { status: 'stable' });
  assert.equal(updated.paused, true);
  assert.equal((await repo.get('pausable'))?.paused, true);
  const rawAfterUpdate = fs.readFileSync(path.join(skillDir, 'pausable', 'SKILL.md'), 'utf-8');
  assert.doesNotMatch(rawAfterUpdate, /paused/);

  const resumed = await repo.setPaused(['pausable'], false);
  assert.equal(resumed[0]?.ok, true);
  assert.equal((await repo.get('pausable'))?.paused, false);
  assert.equal(repo.list().some((s) => s.name === 'pausable'), true);

  db.close();
  fs.rmSync(skillDir, { recursive: true, force: true });
});

test('builtin skills cannot be paused', async () => {
  const builtinDir = makeTmpDir();
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new SkillRepository(db, [{ name: 'builtin', path: builtinDir }, { name: 'folder', path: skillDir }]);

  const builtinSkillDir = path.join(builtinDir, 'authoring-guide');
  fs.mkdirSync(builtinSkillDir, { recursive: true });
  fs.writeFileSync(
    path.join(builtinSkillDir, 'SKILL.md'),
    `---\nname: "authoring-guide"\ndescription: "Builtin guide."\ntags: []\ntrigger_phrases: []\n---\nBody.\n`
  );
  initialScan(db, skillSyncSpec([{ name: 'builtin', path: builtinDir }, { name: 'folder', path: skillDir }]));

  const results = await repo.setPaused(['authoring-guide'], true);
  assert.equal(results[0]?.ok, false);
  assert.match(results[0]?.error ?? '', /builtin/);
  assert.equal((await repo.get('authoring-guide'))?.paused, false);

  db.close();
  fs.rmSync(builtinDir, { recursive: true, force: true });
  fs.rmSync(skillDir, { recursive: true, force: true });
});

test('memory setPaused hides docs from getByKey/search by default, never writes paused into the doc file', async () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);

  const doc = await repo.create({ key: 'RMXS-30', key_type: 'ticket', doc_type: 'plan', description: 'pausable plan', body: 'Plan body.' });
  assert.equal(doc.paused, false);

  const results = await repo.setPaused([doc.id, 'missing-id'], true);
  assert.deepEqual(
    results.map((r) => r.ok),
    [true, false]
  );
  assert.equal((await repo.get(doc.id))?.paused, true);

  assert.equal(repo.getByKey('RMXS-30').length, 0);
  assert.equal(repo.getByKey('RMXS-30', undefined, { includePaused: true }).length, 1);
  assert.equal(repo.search('pausable').some((h) => h.id === doc.id), false);
  assert.equal(repo.search('pausable', { includePaused: true }).some((h) => h.id === doc.id), true);
  assert.ok(await repo.get(doc.id)); // always fetchable directly by id

  const raw = fs.readFileSync(doc.source_path, 'utf-8');
  assert.doesNotMatch(raw, /paused/);

  const updated = await repo.update(doc.id, { description: 'updated pausable plan' });
  assert.equal(updated.paused, true);
  const rawAfterUpdate = fs.readFileSync(doc.source_path, 'utf-8');
  assert.doesNotMatch(rawAfterUpdate, /paused/);

  const resumed = await repo.setPaused([doc.id], false);
  assert.equal(resumed[0]?.ok, true);
  assert.equal((await repo.get(doc.id))?.paused, false);
  assert.equal(repo.getByKey('RMXS-30').length, 1);

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('relocate preserves created_at on the resulting doc', async () => {
  const memDir = makeTmpDir();
  const skillDir = makeTmpDir();
  const srcDir = makeTmpDir();
  const db = openCache(':memory:');
  const memoryRepo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'folder', path: skillDir }]);

  const srcFile = path.join(srcDir, '2026-08-12-pde-600-relocate-created-at.md');
  fs.writeFileSync(srcFile, 'Some plan content.');

  const result = await relocate({ path: srcFile, target: 'memory' }, skillRepo, memoryRepo);
  assert.equal(result.moved, true);
  const doc = await memoryRepo.get(result.id!);
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

test('searchByDate finds memory docs and skills by dates mentioned in their body', async () => {
  const memDir = makeTmpDir();
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const memoryRepo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'folder', path: skillDir }]);

  await memoryRepo.create({
    key: 'date-test',
    key_type: 'freeform',
    doc_type: 'session-summary',
    description: 'Session with dates',
    body: 'Started work on 2026-08-10, wrapped up on 2026-08-12 after review.',
  });
  await memoryRepo.create({
    key: 'no-date-test',
    key_type: 'freeform',
    doc_type: 'session-summary',
    description: 'Session without dates',
    body: 'No dates mentioned in this one at all.',
  });
  await skillRepo.create(
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

test('searchByDate also matches on created_at when no date is mentioned in the body', async () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const memoryRepo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);

  const doc = await memoryRepo.create({
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

test('wiping all cache tables and re-running initialScan fully restores state from disk (bucket_rebuild_cache mechanics)', async () => {
  const memDir = makeTmpDir();
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const skillSpec = skillSyncSpec([{ name: 'builtin', path: '/nonexistent' }, { name: 'folder', path: skillDir }]);
  const memorySpec = memorySyncSpec([{ name: 'folder', path: memDir }]);
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'folder', path: skillDir }]);
  const memoryRepo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);

  await memoryRepo.create({
    key: 'rebuild-test',
    key_type: 'freeform',
    doc_type: 'session-summary',
    description: 'Rebuild target',
    body: 'Happened on 2026-07-04.',
  });
  await skillRepo.create(
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
  assert.ok(await skillRepo.get('rebuild-skill'));
  assert.equal(searchByDate(db, '2026-07-04', '2026-07-04').length, 1);

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
  fs.rmSync(skillDir, { recursive: true, force: true });
});

test('searchByDate reflects doc_dates cleanup after deletion', async () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const memoryRepo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);

  const doc = await memoryRepo.create({
    key: 'delete-test',
    key_type: 'freeform',
    doc_type: 'session-summary',
    description: 'To be deleted',
    body: 'Happened on 2026-05-01.',
  });
  assert.equal(searchByDate(db, '2026-05-01', '2026-05-01').length, 1);

  await memoryRepo.delete(doc.id);
  assert.equal(searchByDate(db, '2026-05-01', '2026-05-01').length, 0);

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('memory doc with no frontmatter at all falls back to file mtime for created_at', () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const folders = [{ name: 'folder', path: memDir }];
  const spec = memorySyncSpec(folders);
  const repo = new MemoryRepository(db, folders);

  const filePath = path.join(memDir, 'dropped-in-notes.md');
  fs.writeFileSync(filePath, 'Just some plain notes, no frontmatter.');
  initialScan(db, spec);

  const docs = repo.getByKey('DROPPED-IN-NOTES');
  assert.equal(docs.length, 1);
  const doc = docs[0]!;
  assert.ok(doc.created_at && !Number.isNaN(Date.parse(doc.created_at)));

  const expectedDate = toLocalDate(new Date(fs.statSync(filePath).mtimeMs).toISOString());
  assert.equal(searchByDate(db, expectedDate, expectedDate).length, 1);

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('memory doc with no frontmatter falls back to mtime, not birthtime (survives a copy that preserves birthtime)', () => {
  // Regression test: some filesystems/tools (e.g. macOS cp in some cases) preserve a copied
  // file's birthtime from its source rather than stamping "now" — mtime is always reset by the
  // write itself, so it's the fallback that actually reflects when this doc came into being.
  // Simulated here by writing the file, then rewinding its mtime backward via touch/utimes to a
  // date distinct from its (untouched, "now") birthtime, and confirming the derived created_at
  // tracks the rewound mtime, not the original birthtime.
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const folders = [{ name: 'folder', path: memDir }];
  const spec = memorySyncSpec(folders);
  const repo = new MemoryRepository(db, folders);

  const filePath = path.join(memDir, 'copied-notes.md');
  fs.writeFileSync(filePath, 'Copied content, no frontmatter.');
  const birthtimeMs = fs.statSync(filePath).birthtimeMs;
  const rewoundMtime = new Date('2020-03-15T00:00:00.000Z');
  fs.utimesSync(filePath, rewoundMtime, rewoundMtime);
  initialScan(db, spec);

  const docs = repo.getByKey('COPIED-NOTES');
  const doc = docs[0]!;
  assert.equal(toLocalDate(doc.created_at!), toLocalDate(rewoundMtime.toISOString()));
  assert.notEqual(toLocalDate(doc.created_at!), toLocalDate(new Date(birthtimeMs).toISOString()));

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('SKILL.md predating created_at falls back to file mtime instead of null', async () => {
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const folders = [{ name: 'builtin', path: '/nonexistent' }, { name: 'folder', path: skillDir }];
  const spec = skillSyncSpec(folders);
  const repo = new SkillRepository(db, folders);

  const legacySkillDir = path.join(skillDir, 'legacy-skill');
  fs.mkdirSync(legacySkillDir, { recursive: true });
  const filePath = path.join(legacySkillDir, 'SKILL.md');
  fs.writeFileSync(
    filePath,
    `---\nname: "legacy-skill"\ndescription: "Legacy skill predating created_at."\ntags: []\ntrigger_phrases: []\n---\nLegacy body.\n`
  );
  initialScan(db, spec);

  const skill = await repo.get('legacy-skill');
  assert.ok(skill?.created_at && !Number.isNaN(Date.parse(skill.created_at)));

  db.close();
  fs.rmSync(skillDir, { recursive: true, force: true });
});

test('skill rename moves the folder and updates the frontmatter name', async () => {
  const skillDir = makeTmpDir();
  const db = openCache(':memory:');
  const folders = [{ name: 'builtin', path: '/nonexistent' }, { name: 'folder', path: skillDir }];
  const repo = new SkillRepository(db, folders);

  await repo.create(
    { name: 'old-name', description: 'Rename target. Use for testing.', owner: null, status: 'unreviewed', tags: [], trigger_phrases: [] },
    'Body.'
  );

  const renamed = await repo.rename('old-name', 'new-name');
  assert.equal(renamed.name, 'new-name');
  assert.equal(await repo.get('old-name'), null);
  assert.equal((await repo.get('new-name'))?.description, 'Rename target. Use for testing.');
  assert.equal(fs.existsSync(path.join(skillDir, 'new-name', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(skillDir, 'old-name')), false);

  db.close();
  fs.rmSync(skillDir, { recursive: true, force: true });
});

test('memory stripFrontmatter leaves a bare file; deriveFrontmatter re-seeds key from the filename', async () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const folders = [{ name: 'folder', path: memDir }];
  const repo = new MemoryRepository(db, folders);

  const doc = await repo.create({
    key: 'strip-test',
    key_type: 'freeform',
    doc_type: 'other',
    description: 'To be stripped',
    body: 'Body content survives stripping.',
  });
  assert.equal(repo.getByKey('strip-test').length, 1);
  assert.equal(doc.key, 'STRIP-TEST');

  await repo.stripFrontmatter(doc.id);
  const raw = fs.readFileSync(doc.source_path, 'utf-8');
  assert.equal(raw.includes('---'), false);
  assert.equal(raw.trim(), 'Body content survives stripping.');

  // stripFrontmatter's own upsertFile call re-derives frontmatter from the filename right away
  // (deriveFrontmatter's fallback) — since the file is still named `<id>.md` (never renamed),
  // the id round-trips to the same value, but `key`/`doc_type`/`status` are reset to fallback
  // defaults (the original key/doc_type only existed in the now-deleted frontmatter block).
  const rows = db.prepare(`SELECT id, key, doc_type FROM memory_docs`).all() as Array<{
    id: string;
    key: string;
    doc_type: string;
  }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, doc.id);
  assert.notEqual(rows[0]!.key, 'STRIP-TEST');
  assert.equal(rows[0]!.doc_type, 'other');

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('memory update() can change key in place, normalized', async () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const folders = [{ name: 'folder', path: memDir }];
  const repo = new MemoryRepository(db, folders);

  const doc = await repo.create({
    key: 'old-key',
    key_type: 'freeform',
    doc_type: 'other',
    description: 'Key change target',
    body: 'Body.',
  });

  const updated = await repo.update(doc.id, { key: 'new key' });
  assert.equal(updated.key, 'NEW-KEY');
  assert.equal(repo.getByKey('old-key').length, 0);
  assert.equal(repo.getByKey('new key').length, 1);

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('applyBodyEdits replaces a unique match, and requires uniqueness unless replace_all', () => {
  const body = 'one\ntwo\nthree\n';
  assert.equal(applyBodyEdits(body, [{ find: 'two', replace: 'TWO' }]).body, 'one\nTWO\nthree\n');

  // ambiguous match without replace_all: rejected, body untouched
  assert.throws(() => applyBodyEdits('a-x-a', [{ find: 'a', replace: 'b' }]), /matches 2 times/);

  // ambiguous match with replace_all: every occurrence replaced
  assert.equal(applyBodyEdits('a-x-a', [{ find: 'a', replace: 'b', replace_all: true }]).body, 'b-x-b');

  // no match: rejected
  assert.throws(() => applyBodyEdits(body, [{ find: 'missing', replace: 'x' }]), /not found/);

  // multiple edits applied in order, second edit sees the first edit's result
  const chained = applyBodyEdits('foo bar', [
    { find: 'foo', replace: 'baz' },
    { find: 'baz bar', replace: 'done' },
  ]);
  assert.equal(chained.body, 'done');
});

test('formatBodyEditsDiff renders a compact -/+ summary per applied edit', () => {
  const { applied } = applyBodyEdits('hello world', [{ find: 'world', replace: 'there' }]);
  const diff = formatBodyEditsDiff(applied);
  assert.match(diff, /-world/);
  assert.match(diff, /\+there/);
});

test('memory update() with body_edits patches in place without a full body replacement', async () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);

  const doc = await repo.create({
    key: 'patch-target',
    key_type: 'freeform',
    doc_type: 'other',
    description: 'Body edit target',
    body: 'line one\nline two\nline three\n',
  });

  const updated = await repo.update(doc.id, {}, undefined, [{ find: 'line two', replace: 'LINE TWO' }]);
  assert.equal(updated.body, 'line one\nLINE TWO\nline three');
  assert.equal((await repo.get(doc.id))?.body, 'line one\nLINE TWO\nline three');

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('suggestKeys finds a punctuation-drifted match (RMXS15 vs RMXS-15)', async () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);

  await repo.create({ key: 'RMXS-15', key_type: 'ticket', doc_type: 'plan', description: 'a', body: 'a' });
  await repo.create({ key: 'RMXS-14', key_type: 'ticket', doc_type: 'plan', description: 'b', body: 'b' });

  const hits = repo.suggestKeys('RMXS15'); // no hyphen — should still find RMXS-15
  assert.equal(hits[0]!.key, 'RMXS-15');
  assert.equal(hits[0]!.docCount, 1);
  assert.ok(!hits.some((h) => h.key === 'RMXS-14')); // unrelated key excluded

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});

test('upsertFile refuses to silently overwrite a name collision across two configured folders', () => {
  // id/name is the table's real PRIMARY KEY and the sole addressing handle
  // across the whole public API (skill_get(name), memory_get(id)) - two
  // different files claiming the same id would otherwise silently
  // ON-CONFLICT-overwrite each other via upsertFile, with no error and no
  // way to recover the shadowed one. This is a regression guard for that
  // fix: the second-synced colliding file must be skipped, not silently
  // clobber the first.
  const dirA = makeTmpDir();
  const dirB = makeTmpDir();
  const db = openCache(':memory:');

  fs.mkdirSync(path.join(dirA, 'shared-name'));
  fs.writeFileSync(
    path.join(dirA, 'shared-name', 'SKILL.md'),
    '---\nname: "shared-name"\ndescription: "From A"\ntags: []\ntrigger_phrases: []\n---\nBody A.\n'
  );
  fs.mkdirSync(path.join(dirB, 'shared-name'));
  fs.writeFileSync(
    path.join(dirB, 'shared-name', 'SKILL.md'),
    '---\nname: "shared-name"\ndescription: "From B"\ntags: []\ntrigger_phrases: []\n---\nBody B.\n'
  );

  const folders = [{ name: 'builtin', path: '/nonexistent' }, { name: 'folderA', path: dirA }, { name: 'folderB', path: dirB }];
  const spec = skillSyncSpec(folders);
  initialScan(db, spec);

  const rows = db.prepare(`SELECT id, description, folder FROM skills WHERE id = ?`).all('shared-name') as Array<{
    id: string;
    description: string;
    folder: string;
  }>;
  // Exactly one row (the schema's PRIMARY KEY makes two impossible), and it
  // must be the FIRST one scanned (folderA, since initialScan walks
  // spec.sources in order) - the collision guard skips B's write entirely
  // rather than letting it clobber A's.
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.description, 'From A');
  assert.equal(rows[0]!.folder, 'folderA');

  db.close();
  fs.rmSync(dirA, { recursive: true, force: true });
  fs.rmSync(dirB, { recursive: true, force: true });
});
