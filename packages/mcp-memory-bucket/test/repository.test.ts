import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCache } from '../src/store/db.js';
import { initialScan, skillSyncSpec, memorySyncSpec } from '../src/store/sync.js';
import { SkillRepository } from '../src/skills/repository.js';
import { MemoryRepository } from '../src/memory/repository.js';
import { relocate, inferMemoryFrontmatter } from '../src/shared/relocate.js';
import { isValidSkillName } from '../src/store/skill-name.js';

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

test('isValidSkillName enforces the agentskills.io name constraints', () => {
  assert.equal(isValidSkillName('pdf-processing'), true);
  assert.equal(isValidSkillName('PDF-Processing'), false); // uppercase
  assert.equal(isValidSkillName('-pdf'), false); // leading hyphen
  assert.equal(isValidSkillName('pdf--processing'), false); // consecutive hyphens
  assert.equal(isValidSkillName('a'.repeat(65)), false); // too long
});
