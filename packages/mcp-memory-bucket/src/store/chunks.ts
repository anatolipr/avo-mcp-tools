import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { chunkMarkdown } from './chunker.js';
import { flattenTags } from './db.js';

type RefTable = 'skills' | 'memory_docs';

/**
 * Bumped on every write to `chunks` (content or embedding) — lets the in-memory vector cache in
 * recall.ts know when to reload, and wakes the embedding indexer via the listener below.
 */
let chunksVersion = 0;
let onChunksChanged: (() => void) | undefined;

export function getChunksVersion(): number {
  return chunksVersion;
}

export function bumpChunksVersion(): void {
  chunksVersion++;
}

/** Registers the single callback fired whenever chunk CONTENT changes (not on embedding writes) — see EmbeddingIndexer.start. */
export function setChunksChangedListener(listener: (() => void) | undefined): void {
  onChunksChanged = listener;
}

/** The text an embedding is computed from: doc-level context + heading path + chunk text, so a chunk stays meaningful out of its document. */
export function embedTextFor(chunk: { context: string; heading: string; text: string }): string {
  return [chunk.context, chunk.heading, chunk.text].filter(Boolean).join('\n');
}

/** Doc-level line prepended to every chunk's embedding input — name/key, description, and a skill's trigger phrases. */
export function chunkContext(table: RefTable, row: Record<string, unknown>): string {
  const label = table === 'skills' ? row.id : row.key;
  const triggers = table === 'skills' ? flattenTags(String(row.trigger_phrases ?? '[]')) : '';
  return [`${label ?? ''}: ${row.description ?? ''}`, triggers].filter(Boolean).join(' — ');
}

/**
 * Replaces one doc's chunks (and their chunk_fts rows) with a fresh split of `body`. An embedding
 * is carried over to any new chunk whose embedded text is byte-identical to an old one, so editing
 * one section of a long doc re-embeds only that section. A doc with an empty body still gets one
 * chunk (its description) so it stays reachable by semantic search.
 */
export function writeChunks(db: Database.Database, table: RefTable, id: string, refFolder: string, context: string, description: string, body: string): void {
  const old = db
    .prepare(`SELECT id, hash, embedding, embed_model FROM chunks WHERE ref_table = ? AND ref_id = ? AND ref_folder = ?`)
    .all(table, id, refFolder) as Array<{ id: number; hash: string; embedding: Buffer | null; embed_model: string | null }>;
  const reusable = new Map(old.filter((o) => o.embedding).map((o) => [o.hash, o]));
  deleteChunkRows(db, old.map((o) => o.id));

  let chunks = chunkMarkdown(body);
  if (chunks.length === 0) chunks = [{ ord: 0, heading: '', text: description }];

  const insertChunk = db.prepare(
    `INSERT INTO chunks (ref_table, ref_id, ref_folder, ord, context, heading, text, hash, embedding, embed_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertFts = db.prepare(`INSERT INTO chunk_fts (rowid, heading, body) VALUES (?, ?, ?)`);
  const insertTerms = db.prepare(`INSERT INTO term_index (rowid, text) VALUES (?, ?)`);
  for (const chunk of chunks) {
    const hash = crypto.createHash('sha1').update(embedTextFor({ context, ...chunk })).digest('hex');
    const kept = reusable.get(hash);
    const { lastInsertRowid } = insertChunk.run(table, id, refFolder, chunk.ord, context, chunk.heading, chunk.text, hash, kept?.embedding ?? null, kept?.embed_model ?? null);
    insertFts.run(lastInsertRowid, chunk.heading, chunk.text);
    insertTerms.run(lastInsertRowid, embedTextFor({ context, ...chunk }));
  }
  chunksVersion++;
  onChunksChanged?.();
}

export function deleteChunks(db: Database.Database, table: RefTable, id: string, refFolder: string): void {
  const rows = db.prepare(`SELECT id FROM chunks WHERE ref_table = ? AND ref_id = ? AND ref_folder = ?`).all(table, id, refFolder) as Array<{ id: number }>;
  deleteChunkRows(db, rows.map((r) => r.id));
  chunksVersion++;
}

function deleteChunkRows(db: Database.Database, ids: number[]): void {
  const deleteFts = db.prepare(`DELETE FROM chunk_fts WHERE rowid = ?`);
  const deleteChunk = db.prepare(`DELETE FROM chunks WHERE id = ?`);
  const deleteTerms = db.prepare(`DELETE FROM term_index WHERE rowid = ?`);
  for (const id of ids) {
    deleteFts.run(id);
    deleteTerms.run(id);
    deleteChunk.run(id);
  }
}

/**
 * Drops chunks whose parent doc row is gone. A cache rebuild wipes skills/memory_docs and rescans
 * but deliberately leaves `chunks` alone so writeChunks can carry every unchanged embedding over —
 * this then removes whatever the rescan did not re-claim.
 */
export function pruneOrphanChunks(db: Database.Database): void {
  const orphans = db
    .prepare(
      `SELECT c.id FROM chunks c WHERE
         (c.ref_table = 'skills' AND NOT EXISTS (SELECT 1 FROM skills s WHERE s.id = c.ref_id AND s.folder = c.ref_folder))
         OR (c.ref_table = 'memory_docs' AND NOT EXISTS (SELECT 1 FROM memory_docs m WHERE m.source_path = c.ref_id))`
    )
    .all() as Array<{ id: number }>;
  if (orphans.length === 0) return;
  deleteChunkRows(db, orphans.map((o) => o.id));
  chunksVersion++;
}

/**
 * Chunks every cached doc that has none yet — cache files created before `chunks` existed, whose
 * rows upsertFile's mtime check would otherwise skip forever. Safe to call every startup.
 */
export function backfillChunks(db: Database.Database): void {
  const skills = db
    .prepare(
      `SELECT id, folder, description, trigger_phrases, body FROM skills s
       WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.ref_table = 'skills' AND c.ref_id = s.id AND c.ref_folder = s.folder)`
    )
    .all() as Array<{ id: string; folder: string; description: string; trigger_phrases: string; body: string }>;
  const memoryDocs = db
    .prepare(
      `SELECT source_path, key, description, body FROM memory_docs m
       WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.ref_table = 'memory_docs' AND c.ref_id = m.source_path)`
    )
    .all() as Array<{ source_path: string; key: string; description: string; body: string }>;
  if (skills.length === 0 && memoryDocs.length === 0) return;
  db.transaction(() => {
    for (const row of skills) writeChunks(db, 'skills', row.id, row.folder, chunkContext('skills', row), row.description, row.body);
    for (const row of memoryDocs) writeChunks(db, 'memory_docs', row.source_path, '', chunkContext('memory_docs', row), row.description, row.body);
  })();
}

/** Fills term_index for cache files whose chunks were written before it existed. Safe to call every startup. */
export function backfillTermIndex(db: Database.Database): void {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM term_index`).get() as { n: number };
  if (n > 0) return;
  const rows = db.prepare(`SELECT id, context, heading, text FROM chunks`).all() as Array<{ id: number; context: string; heading: string; text: string }>;
  if (rows.length === 0) return;
  const insert = db.prepare(`INSERT INTO term_index (rowid, text) VALUES (?, ?)`);
  db.transaction(() => {
    for (const row of rows) insert.run(row.id, embedTextFor(row));
  })();
  chunksVersion++;
}
