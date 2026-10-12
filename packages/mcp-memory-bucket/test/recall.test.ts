import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCache } from '../src/store/db.js';
import { SkillRepository } from '../src/skills/repository.js';
import { MemoryRepository } from '../src/memory/repository.js';
import { chunkMarkdown, MAX_CHUNK_CHARS } from '../src/store/chunker.js';
import express from 'express';
import { backfillChunks, backfillTermIndex, pruneOrphanChunks } from '../src/store/chunks.js';
import { suggestCorrection } from '../src/store/spelling.js';
import { buildWebRouter } from '../src/web/routes.js';
import { IdentityTracker } from '../src/remote/identity.js';
import { EmbeddingIndexer, type Embedder } from '../src/store/embeddings.js';
import { recall, formatRecall, questionToFtsQuery } from '../src/store/recall.js';
import { searchCombined } from '../src/store/search.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bucket-recall-'));
}

function setup() {
  const skillDir = makeTmpDir();
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }, { name: 'folder', path: skillDir }]);
  const memoryRepo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);
  const cleanup = () => {
    db.close();
    fs.rmSync(skillDir, { recursive: true, force: true });
    fs.rmSync(memDir, { recursive: true, force: true });
  };
  return { db, skillRepo, memoryRepo, cleanup };
}

/**
 * Deterministic stand-in for a real embedding model: one dimension per concept, set when the text
 * contains any of that concept's synonyms — so "undo" and "revert" land on the same axis without
 * sharing a single token, which is exactly what lexical search cannot do.
 */
const CONCEPTS = [
  ['undo', 'revert', 'rollback', 'snapshot'],
  ['tooltip', 'popover', 'hover'],
  ['database', 'postgres', 'sql', 'migration'],
];
function fakeEmbedder(): Embedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    model: 'fake-concepts',
    calls,
    async embed(texts) {
      calls.push(texts);
      return texts.map((text) => {
        const lower = text.toLowerCase();
        const vector = new Float32Array(CONCEPTS.length + 1);
        CONCEPTS.forEach((words, i) => (vector[i] = words.some((w) => lower.includes(w)) ? 1 : 0));
        vector[CONCEPTS.length] = 0.01; // never the zero vector
        const norm = Math.hypot(...vector);
        return vector.map((v) => v / norm);
      });
    },
  };
}

test('chunkMarkdown splits by heading, tracks the heading path, and ignores # inside code fences', () => {
  const filler = (word: string) => Array.from({ length: 60 }, () => word).join(' ');
  const chunks = chunkMarkdown(
    [`Intro ${filler('intro')}`, '# Setup', filler('setup'), '## Install', filler('install'), '```sh', '# not a heading', '```', '# Usage', filler('usage')].join('\n')
  );
  assert.deepEqual(
    chunks.map((c) => c.heading),
    ['', 'Setup', 'Setup › Install', 'Usage']
  );
  assert.match(chunks[2]!.text, /# not a heading/);
  assert.deepEqual(chunks.map((c) => c.ord), [0, 1, 2, 3]);
});

test('chunkMarkdown folds a tiny section into the previous chunk and splits an oversized one at paragraphs', () => {
  const folded = chunkMarkdown(`# A\n${'alpha '.repeat(50)}\n## B\nshort note\n`);
  assert.equal(folded.length, 1);
  assert.match(folded[0]!.text, /## B\nshort note/);

  const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${'word '.repeat(60)}`.trim());
  const split = chunkMarkdown(`# Big\n${paragraphs.join('\n\n')}`);
  assert.ok(split.length > 1);
  for (const chunk of split) {
    assert.equal(chunk.heading, 'Big');
    assert.ok(chunk.text.length <= MAX_CHUNK_CHARS);
  }
  assert.equal(split.map((c) => c.text).join('\n\n'), paragraphs.join('\n\n'));
});

test('a skill is findable by its name and trigger phrases, not only by description/body', async () => {
  const { db, skillRepo, cleanup } = setup();
  await skillRepo.create(
    { name: 'canvas-zoom-pan', description: 'Pointer gestures for a drawing surface.', tags: [], trigger_phrases: ['pinch gesture'] },
    'Handle wheel events.'
  );
  assert.equal(skillRepo.search('zoom')[0]?.name, 'canvas-zoom-pan');
  assert.equal(skillRepo.search('pinch')[0]?.name, 'canvas-zoom-pan');
  cleanup();
});

test('bare words that never all co-occur fall back to OR; explicit syntax does not', async () => {
  const { db, memoryRepo, cleanup } = setup();
  await memoryRepo.create({ filename: 'deploy', key: 'deploy', key_type: 'freeform', doc_type: 'plan', description: 'release plan', body: 'Deploy on Friday.' });
  assert.equal(searchCombined(db, 'deploy kubernetes').length, 1);
  assert.equal(searchCombined(db, 'deploy AND kubernetes').length, 0);
  assert.equal(searchCombined(db, '"deploy kubernetes"').length, 0);
  cleanup();
});

test('a name/key hit outranks the same word buried in another doc body', async () => {
  const { db, skillRepo, memoryRepo, cleanup } = setup();
  await memoryRepo.create({
    filename: 'notes',
    key: 'notes',
    key_type: 'freeform',
    doc_type: 'other',
    description: 'misc',
    body: `Assorted notes. ${'filler '.repeat(40)} tooltip tooltip tooltip.`,
  });
  await skillRepo.create({ name: 'tooltip', description: 'Floating hint.', tags: [], trigger_phrases: [] }, 'Anchor it to the trigger element.');
  assert.equal(searchCombined(db, 'tooltip')[0]?.id, 'tooltip');
  cleanup();
});

test('recall returns the matching section, not the whole document, and respects max_tokens', async () => {
  const { db, skillRepo, cleanup } = setup();
  const section = (word: string) => `${word} ${'detail '.repeat(80)}`;
  await skillRepo.create(
    { name: 'deploy-guide', description: 'How we ship.', tags: [], trigger_phrases: [] },
    `# Build\n${section('compile')}\n# Rollback\n${section('revert the release with the rollback script')}\n# Monitor\n${section('dashboards')}`
  );

  const result = await recall(db, 'how do I rollback a release?');
  assert.equal(result.mode, 'lexical');
  assert.equal(result.chunks[0]!.heading, 'Rollback');
  assert.equal(result.chunks[0]!.id, 'deploy-guide');
  assert.ok(!result.chunks.some((c) => c.heading === 'Monitor'));

  const text = formatRecall(result);
  assert.match(text, /## skill deploy-guide \(folder: folder\)/);
  assert.match(text, /### Rollback/);

  const tight = await recall(db, 'rollback release', { maxTokens: 60 });
  assert.equal(tight.chunks.length, 1);
  assert.equal(tight.truncated, true);
  assert.ok(tight.chunks[0]!.text.length < 300);
  cleanup();
});

test('recall surfaces a doc whose only match is its key, and skips paused and hidden docs', async () => {
  const { db, memoryRepo, cleanup } = setup();
  await memoryRepo.create({ filename: 'plan-a', key: 'RMXS-77', key_type: 'ticket', doc_type: 'plan', description: 'plan', body: 'Body with no ticket ref.' });
  const byKey = await recall(db, 'RMXS-77');
  assert.equal(byKey.chunks[0]?.id, 'plan-a.md');
  assert.equal(byKey.chunks[0]?.key, 'RMXS-77');

  assert.equal((await recall(db, 'RMXS-77', { table: 'skills' })).chunks.length, 0);
  assert.equal((await recall(db, 'RMXS-77', { hidden: { skills: [], memory_docs: ['folder'] } })).chunks.length, 0);

  await memoryRepo.setPaused([{ filename: 'plan-a' }], true);
  assert.equal((await recall(db, 'RMXS-77')).chunks.length, 0);
  cleanup();
});

test('hybrid recall finds a paraphrase that shares no keyword with the doc', async () => {
  const { db, skillRepo, memoryRepo, cleanup } = setup();
  await skillRepo.create({ name: 'history-stack', description: 'State history.', tags: [], trigger_phrases: [] }, 'Keep a snapshot per change so the user can step back.');
  await memoryRepo.create({ filename: 'db', key: 'db', key_type: 'freeform', doc_type: 'plan', description: 'schema work', body: 'Postgres migration for the orders table.' });

  assert.equal((await recall(db, 'undo')).chunks.length, 0); // lexical alone: no shared token

  const embedder = fakeEmbedder();
  const indexer = new EmbeddingIndexer(db, embedder);
  indexer.kick();
  await indexer.drain();
  assert.equal(indexer.isReady(), true);
  assert.deepEqual({ embedded: indexer.status().embedded, total: indexer.status().total }, { embedded: 2, total: 2 });

  const result = await recall(db, 'undo', { embedder });
  assert.equal(result.mode, 'hybrid');
  assert.equal(result.chunks[0]!.id, 'history-stack');
  cleanup();
});

test('editing one section re-embeds only that section; a rebuild keeps embeddings and prunes orphans', async () => {
  const { db, skillRepo, cleanup } = setup();
  const section = (word: string) => `${word} ${'detail '.repeat(60)}`;
  await skillRepo.create({ name: 'guide', description: 'Guide.', tags: [], trigger_phrases: [] }, `# One\n${section('first')}\n# Two\n${section('second')}`);

  const embedder = fakeEmbedder();
  const indexer = new EmbeddingIndexer(db, embedder);
  indexer.start();
  await indexer.drain();
  assert.equal(embedder.calls.flat().length, 2);

  await skillRepo.update('guide', undefined, `# One\n${section('first')}\n# Two\n${section('changed')}`);
  await indexer.drain();
  assert.equal(embedder.calls.flat().length, 3);
  assert.match(embedder.calls.flat()[2]!, /changed/);

  // A later process finds nothing pending but must still load the model, or queries stay lexical.
  const restarted = new EmbeddingIndexer(db, embedder);
  assert.equal(restarted.isReady(), false);
  restarted.kick();
  await restarted.drain();
  assert.equal(restarted.isReady(), true);

  // Simulates bucket_rebuild_cache: doc tables wiped, chunks left for the rescan to re-claim.
  db.exec(`DELETE FROM skills`);
  pruneOrphanChunks(db);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as { n: number }).n, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM chunk_fts`).get() as { n: number }).n, 0);
  indexer.stop();
  cleanup();
});

test('backfillChunks chunks docs cached before the chunks table existed', async () => {
  const { db, memoryRepo, cleanup } = setup();
  await memoryRepo.create({ filename: 'old', key: 'old', key_type: 'freeform', doc_type: 'other', description: 'old doc', body: 'Legacy content about widgets.' });
  db.exec(`DELETE FROM chunks; DELETE FROM chunk_fts;`);
  assert.equal((await recall(db, 'widgets')).chunks.filter((c) => c.text.includes('Legacy')).length, 0);
  backfillChunks(db);
  assert.equal((await recall(db, 'widgets')).chunks[0]?.text, 'Legacy content about widgets.');
  cleanup();
});

test('questionToFtsQuery drops stopwords and ORs the rest', () => {
  assert.equal(questionToFtsQuery('How do I flip the tooltip?'), '"flip" OR "tooltip"');
  assert.equal(questionToFtsQuery('what is it'), '"what" OR "is" OR "it"');
  assert.equal(questionToFtsQuery('?!'), null);
});

test('a misspelled word is corrected to the closest corpus word; real words and short words are left alone', async () => {
  const { db, skillRepo, memoryRepo, cleanup } = setup();
  await skillRepo.create({ name: 'hover-hints', description: 'Floating hint.', tags: [], trigger_phrases: [] }, 'Position the tooltip beside its anchor. Deploying takes a minute.');
  await memoryRepo.create({ filename: 'plan', key: 'plan', key_type: 'freeform', doc_type: 'plan', description: 'schema work', body: 'Database migration for orders.' });

  assert.equal(suggestCorrection(db, 'tooltp'), 'tooltip');
  assert.equal(suggestCorrection(db, 'migratoin'), 'migration');
  assert.equal(suggestCorrection(db, 'tooltip'), undefined); // already a corpus word
  assert.equal(suggestCorrection(db, 'deploy'), undefined); // only "deploying" is in the corpus, but the stemmed index matches
  assert.equal(suggestCorrection(db, 'kubernetes'), undefined); // nothing close
  assert.equal(suggestCorrection(db, 'tol'), undefined); // too short to call a typo
  assert.equal(suggestCorrection(db, 'borders'), undefined); // a real word one edit from "orders" — different first letter, not a typo

  // Keyword search: single misspelled word, and a misspelled word next to an absent one.
  assert.equal(skillRepo.search('tooltp')[0]?.name, 'hover-hints');
  assert.equal(searchCombined(db, 'migratoin')[0]?.id.endsWith('plan.md'), true);
  assert.equal(searchCombined(db, '"tooltp"').length, 0); // explicit syntax is taken literally

  const result = await recall(db, 'where does the tooltp go');
  assert.equal(result.chunks[0]?.id, 'hover-hints');
  assert.deepEqual(result.corrections, { tooltp: 'tooltip' });
  assert.match(formatRecall(result), /"tooltp" read as "tooltip"/);

  // A deleted doc's words leave the vocabulary with it.
  await memoryRepo.delete(undefined, 'plan');
  assert.equal(suggestCorrection(db, 'migratoin'), undefined);
  cleanup();
});

test('backfillTermIndex rebuilds the typo vocabulary for a cache whose chunks predate it', async () => {
  const { db, skillRepo, cleanup } = setup();
  await skillRepo.create({ name: 'hints', description: 'Hint.', tags: [], trigger_phrases: [] }, 'Position the tooltip.');
  db.exec(`DELETE FROM term_index`);
  backfillTermIndex(db);
  assert.equal(suggestCorrection(db, 'tooltp'), 'tooltip');
  cleanup();
});

test('web UI search merges semantic matches into keyword results, but not for explicit-syntax queries', async () => {
  const { db, skillRepo, memoryRepo, cleanup } = setup();
  await skillRepo.create({ name: 'history-stack', description: 'State history.', tags: [], trigger_phrases: [] }, 'Keep a snapshot per change so the user can step back.');
  await memoryRepo.create({ filename: 'db', key: 'db', key_type: 'freeform', doc_type: 'plan', description: 'schema work', body: 'Postgres migration for the orders table. Undo is not supported.' });
  const embedder = fakeEmbedder();
  const indexer = new EmbeddingIndexer(db, embedder);
  indexer.kick();
  await indexer.drain();

  const config = { skillFolders: [], memoryFolders: [], remoteSkillFolders: [], remoteMemoryFolders: [], folderfooMode: 'off' } as any;
  const spec = { sources: [] } as any;
  const app = express();
  app.use(buildWebRouter(db, config, skillRepo, memoryRepo, spec, spec, new IdentityTracker('off'), undefined, undefined, indexer));
  const server = app.listen(0);
  const base = `http://localhost:${(server.address() as { port: number }).port}`;
  const names = async (q: string) => ((await (await fetch(`${base}/api/entries?q=${encodeURIComponent(q)}`)).json()) as Array<{ name: string }>).map((e) => e.name);

  // "revert" is in neither doc; only the embedding links it to the snapshot skill.
  assert.deepEqual(await names('revert'), ['history-stack']);
  // Keyword hit (db.md says "Undo") and semantic hit (history-stack) both listed.
  assert.deepEqual((await names('undo')).sort(), ['db.md', 'history-stack'].sort());
  assert.deepEqual(await names('"revert"'), []);

  server.close();
  indexer.stop();
  cleanup();
});
