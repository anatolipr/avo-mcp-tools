import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCache } from '../src/store/db.js';
import { sanitizeFtsQuery, hasExplicitSyntax, searchIndex, searchCombined, SearchQueryError } from '../src/store/search.js';
import { SkillRepository } from '../src/skills/repository.js';
import { MemoryRepository } from '../src/memory/repository.js';

function setup() {
  const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bucket-search-'));
  const memDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bucket-search-'));
  const db = openCache(':memory:');
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'folder', path: skillDir }]);
  const memoryRepo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);
  const cleanup = () => {
    db.close();
    fs.rmSync(skillDir, { recursive: true, force: true });
    fs.rmSync(memDir, { recursive: true, force: true });
  };
  const doc = (filename: string, key: string, body: string, description = `Doc ${key}`) =>
    memoryRepo.create({ filename, key, key_type: 'freeform', doc_type: 'other', description, body });
  return { db, skillRepo, memoryRepo, doc, cleanup };
}

test('sanitizeFtsQuery quotes punctuated barewords and leaves explicit syntax untouched', () => {
  assert.equal(sanitizeFtsQuery('RMXS-15 deploy'), '"RMXS-15" deploy');
  assert.equal(sanitizeFtsQuery('deploy AND rollback'), 'deploy AND rollback');
  assert.equal(sanitizeFtsQuery('deploy or rollback'), 'deploy or rollback');
  assert.equal(sanitizeFtsQuery('"blue green" migrat*'), '"blue green" migrat*');
  assert.equal(sanitizeFtsQuery('a:b'), '"a:b"');
  assert.equal(sanitizeFtsQuery('say"hi'), '"say""hi"');
  assert.equal(sanitizeFtsQuery('   '), '');
});

test('hasExplicitSyntax detects operators, quotes, wildcards and grouping — not plain words', () => {
  assert.equal(hasExplicitSyntax('deploy rollback'), false);
  assert.equal(hasExplicitSyntax('RMXS-15'), false);
  assert.equal(hasExplicitSyntax('deploy AND rollback'), true);
  assert.equal(hasExplicitSyntax('"blue green"'), true);
  assert.equal(hasExplicitSyntax('migrat*'), true);
  assert.equal(hasExplicitSyntax('(a b)'), true);
});

test('searchIndex: bare words must all match, and fall back to any-word only when nothing matches all', async () => {
  const { db, doc, cleanup } = setup();
  await doc('both.md', 'BOTH', 'kangaroo and wombat together');
  await doc('one.md', 'ONE', 'kangaroo alone');
  await doc('other.md', 'OTHER', 'platypus alone');

  const all = searchIndex(db, 'kangaroo wombat');
  assert.deepEqual(all.map((h) => path.basename(h.ref_id)), ['both.md'], 'a doc matching every word wins outright');

  const any = searchIndex(db, 'kangaroo platypus');
  assert.deepEqual(any.map((h) => path.basename(h.ref_id)).sort(), ['both.md', 'one.md', 'other.md'], 'no doc has both, so either word matches');

  assert.deepEqual(searchIndex(db, 'kangaroo AND platypus'), [], 'explicit syntax is never loosened');
  cleanup();
});

test('searchIndex: table scope, limit and offset', async () => {
  const { db, skillRepo, doc, cleanup } = setup();
  await skillRepo.create({ name: 'quokka-skill', description: 'Quokka skill. Use when testing.' }, 'quokka body');
  await doc('a.md', 'A', 'quokka one');
  await doc('b.md', 'B', 'quokka two');

  assert.equal(searchIndex(db, 'quokka').length, 3);
  assert.deepEqual(searchIndex(db, 'quokka', { table: 'skills' }).map((h) => h.ref_id), ['quokka-skill']);
  assert.equal(searchIndex(db, 'quokka', { table: 'memory_docs' }).length, 2);

  const firstPage = searchIndex(db, 'quokka', { limit: 2 });
  const secondPage = searchIndex(db, 'quokka', { limit: 2, offset: 2 });
  assert.equal(firstPage.length, 2);
  assert.equal(secondPage.length, 1);
  assert.equal(new Set([...firstPage, ...secondPage].map((h) => h.ref_id)).size, 3, 'pages do not overlap');
  assert.deepEqual(searchIndex(db, 'quokka', { limit: 2, offset: 4 }), [], 'a page past the end stays empty rather than loosening the query');
  cleanup();
});

test('search ranks a key or name hit above a body-only hit, and marks the match in the snippet', async () => {
  const { db, doc, cleanup } = setup();
  await doc('body-only.md', 'UNRELATED', 'this text mentions narwhal once among many other words about the sea');
  await doc('keyed.md', 'NARWHAL', 'a short body');

  const hits = searchCombined(db, 'narwhal');
  assert.equal(hits[0]!.id.endsWith('keyed.md'), true);
  assert.ok(hits[0]!.score >= hits[1]!.score);
  assert.match(hits[1]!.snippet, /<<narwhal>>/);
  cleanup();
});

test('search corrects a misspelled word when nothing matches as typed', async () => {
  const { db, doc, cleanup } = setup();
  await doc('m.md', 'M', 'notes on the database migration procedure');
  const hits = searchIndex(db, 'migratoin');
  assert.deepEqual(hits.map((h) => path.basename(h.ref_id)), ['m.md']);
  cleanup();
});

test('searchIndex and searchCombined report malformed FTS5 syntax as a SearchQueryError', () => {
  const { db, cleanup } = setup();
  assert.throws(() => searchIndex(db, '"unterminated'), SearchQueryError);
  assert.throws(() => searchCombined(db, 'a AND'), SearchQueryError);
  cleanup();
});
