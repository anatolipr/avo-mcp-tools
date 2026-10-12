import path from 'node:path';
import type Database from 'better-sqlite3';
import { getChunksVersion } from './chunks.js';
import { blobToVector, type Embedder } from './embeddings.js';
import { SEARCH_BM25 } from './search.js';
import { correctWords } from './spelling.js';

type RefTable = 'skills' | 'memory_docs';

export interface RecallChunk {
  ref_table: RefTable;
  /** Skill name, or memory doc filename — the handle skill_get/memory_get take. */
  id: string;
  folder: string;
  /** Memory doc key; undefined for skills. */
  key?: string;
  heading: string;
  ord: number;
  text: string;
  score: number;
  /** Set when the doc is deprecated or abandoned — such docs rank lower and are labelled in the output. */
  stale?: 'deprecated' | 'abandoned';
}

export interface RecallResult {
  /** 'hybrid' when the query was also matched by embedding similarity, 'lexical' when only BM25 ran. */
  mode: 'hybrid' | 'lexical';
  chunks: RecallChunk[];
  /** True when relevant chunks were left out because max_tokens ran out. */
  truncated: boolean;
  /** Query words read as a likely misspelling, with the corpus word matched in their place. */
  corrections: Record<string, string>;
}

export interface RecallOptions {
  maxTokens?: number;
  table?: RefTable;
  /** Folder names to exclude per table — remote folders not visible to the current login (see hiddenFolderNames). */
  hidden?: { skills: string[]; memory_docs: string[] };
  /** Omit (or pass one whose model is not loaded yet) for lexical-only retrieval. */
  embedder?: Embedder;
}

const STOPWORDS = new Set(
  'a an and are as at be but by can do does for from how i if in into is it my not of on or so that the their then there this to was we what when where which who why will with you your'.split(' ')
);

/**
 * A natural-language question as an FTS5 query: its content words OR'd together. OR (not FTS5's
 * default AND) because a question rarely shares every word with its answer — bm25 already ranks a
 * chunk matching more of the words above one matching fewer.
 */
export function questionToFtsQuery(question: string, corrections?: Map<string, string>): string | null {
  const words = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])];
  const content = words.filter((w) => !STOPWORDS.has(w));
  const terms = new Set(content.length > 0 ? content : words);
  // A corrected spelling is added, not swapped in: the original may be a real word this corpus simply lacks.
  for (const term of [...terms]) if (corrections?.has(term)) terms.add(corrections.get(term)!);
  return terms.size > 0 ? [...terms].map((t) => `"${t}"`).join(' OR ') : null;
}

const WORD_RE = /[\p{L}\p{N}_]+/gu;

const CANDIDATES_PER_LIST = 30;
const DOC_CANDIDATES = 10;
/** Reciprocal-rank-fusion constant — the conventional 60; damps how much a rank-1 hit outweighs a rank-5 one. */
const RRF_K = 60;
/**
 * The semantic list counts double: two of the three fused lists are keyword-based (chunk and doc
 * BM25), so at equal weight a chunk that is the clear best match by meaning loses to one that
 * merely shares common words with the question in both keyword lists.
 */
const SEMANTIC_WEIGHT = 2;
const MAX_CHUNKS_PER_DOC = 3;
/** Fused scores below this fraction of the best hit's are dropped rather than used to fill the token budget. */
const RELATIVE_SCORE_FLOOR = 0.3;
/** A deprecated or abandoned doc keeps this fraction of its fused score — still findable, but below a live doc that matches as well. */
const STALE_SCORE_FACTOR = 0.5;
const CHARS_PER_TOKEN = 4;
const HEADER_TOKENS = 20;

let vectorCache: { version: number; model: string; ids: number[]; vectors: Float32Array[] } | undefined;

function loadVectors(db: Database.Database, model: string): { ids: number[]; vectors: Float32Array[] } {
  const version = getChunksVersion();
  if (!vectorCache || vectorCache.version !== version || vectorCache.model !== model) {
    const rows = db.prepare(`SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL AND embed_model = ?`).all(model) as Array<{ id: number; embedding: Buffer }>;
    vectorCache = { version, model, ids: rows.map((r) => r.id), vectors: rows.map((r) => blobToVector(r.embedding)) };
  }
  return vectorCache;
}

/** Chunks by descending cosine similarity (vectors are unit-length, so a dot product). Brute force — a personal corpus is thousands of chunks, not millions. */
function vectorSearch(db: Database.Database, model: string, query: Float32Array, limit: number, skip?: Set<number>): Array<{ id: number; similarity: number }> {
  const { ids, vectors } = loadVectors(db, model);
  const scored: Array<{ id: number; similarity: number }> = [];
  for (let i = 0; i < vectors.length; i++) {
    const vector = vectors[i]!;
    if (vector.length !== query.length || skip?.has(ids[i]!)) continue;
    let dot = 0;
    for (let d = 0; d < vector.length; d++) dot += vector[d]! * query[d]!;
    scored.push({ id: ids[i]!, similarity: dot });
  }
  return scored.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
}

/**
 * Cosine similarity a chunk must reach to count as a semantic match on its own. Rank fusion in
 * recall() needs no such cut-off, but a result LIST does: similarity search always returns its
 * nearest chunks, however unrelated. Tuned for the default bge-small model, where unrelated text
 * scores 0.50–0.58 and a real match 0.60+; override when using another model.
 */
const SEMANTIC_MIN_SIMILARITY = Number(process.env.MEMORY_BUCKET_SEMANTIC_MIN_SIMILARITY) || 0.6;
/** Beyond the floor, a doc must also be this close to the best match — keeps one strong hit from dragging in the merely-adjacent. */
const SEMANTIC_WINDOW = 0.05;
const SEMANTIC_MAX_DOCS = 5;

/**
 * Docs whose best chunk is semantically close to `query`, best first — the doc-level counterpart
 * of recall()'s vector list, for the web UI's result list (which shows docs, not passages).
 */
export async function semanticDocMatches(
  db: Database.Database,
  embedder: Embedder,
  query: string
): Promise<Array<{ ref_table: RefTable; ref_id: string; ref_folder: string; similarity: number }>> {
  const [queryVector] = await embedder.embed([query], 'query');
  const hits = vectorSearch(db, embedder.model, queryVector!, 50);
  const floor = Math.max(SEMANTIC_MIN_SIMILARITY, (hits[0]?.similarity ?? 0) - SEMANTIC_WINDOW);
  const chunkDoc = db.prepare(`SELECT ref_table, ref_id, ref_folder FROM chunks WHERE id = ?`);
  const docs = new Map<string, { ref_table: RefTable; ref_id: string; ref_folder: string; similarity: number }>();
  for (const hit of hits) {
    if (hit.similarity < floor || docs.size >= SEMANTIC_MAX_DOCS) break;
    const doc = chunkDoc.get(hit.id) as { ref_table: RefTable; ref_id: string; ref_folder: string } | undefined;
    if (doc && !docs.has(docKey(doc))) docs.set(docKey(doc), { ...doc, similarity: hit.similarity });
  }
  return [...docs.values()];
}

interface ChunkRow {
  id: number;
  ref_table: RefTable;
  ref_id: string;
  ref_folder: string;
  ord: number;
  heading: string;
  text: string;
  hash: string;
}

const docKey = (c: { ref_table: string; ref_id: string; ref_folder: string }) => `${c.ref_table}\0${c.ref_folder}\0${c.ref_id}`;

/**
 * The chunks (and their docs) recall must never return: those of paused docs and of docs in a
 * folder hidden from the current login. Resolved up front so each ranked list can skip them BEFORE
 * its candidate cut — filtered afterwards, a corpus with many paused or hidden docs has them take
 * the candidate slots and visible matches never get ranked at all. Normally empty, and found
 * through the partial `paused` indexes and the folder indexes (see db.ts), so the common case costs
 * four index probes. Any failure degrades to "skip nothing": recall()'s own per-doc visibility
 * check still drops such chunks from the result.
 */
function invisibleChunks(db: Database.Database, hidden: RecallOptions['hidden']): { chunkIds: Set<number>; docKeys: Set<string> } {
  const chunkIds = new Set<number>();
  const docKeys = new Set<string>();
  try {
    const collect = (sql: string, params: string[]) => {
      for (const row of db.prepare(sql).all(...params) as Array<{ id: number; ref_table: string; ref_id: string; ref_folder: string }>) {
        chunkIds.add(row.id);
        docKeys.add(docKey(row));
      }
    };
    // CROSS JOIN pins the doc table as the outer loop, so the (small) filtered doc set drives index lookups into chunks.
    const skillChunks = `SELECT c.id, c.ref_table, c.ref_id, c.ref_folder FROM skills s CROSS JOIN chunks c ON c.ref_table = 'skills' AND c.ref_id = s.id AND c.ref_folder = s.folder`;
    const memoryChunks = `SELECT c.id, c.ref_table, c.ref_id, c.ref_folder FROM memory_docs m CROSS JOIN chunks c ON c.ref_table = 'memory_docs' AND c.ref_id = m.source_path AND c.ref_folder = ''`;
    const placeholders = (names: string[]) => names.map(() => '?').join(', ');
    collect(`${skillChunks} WHERE s.paused = 1`, []);
    collect(`${memoryChunks} WHERE m.paused = 1`, []);
    if (hidden?.skills.length) collect(`${skillChunks} WHERE s.folder IN (${placeholders(hidden.skills)})`, hidden.skills);
    if (hidden?.memory_docs.length) collect(`${memoryChunks} WHERE m.folder IN (${placeholders(hidden.memory_docs)})`, hidden.memory_docs);
  } catch (err) {
    console.error('[memory-bucket] recall could not pre-filter paused/hidden docs:', (err as Error).message);
    chunkIds.clear();
    docKeys.clear();
  }
  return { chunkIds, docKeys };
}

/**
 * Retrieves the passages most relevant to a natural-language query, packed into a token budget.
 * Three ranked lists are fused by reciprocal rank: chunk-level BM25, chunk-level embedding
 * similarity (when an embedder is ready), and doc-level weighted BM25 — the last so a query that
 * names a skill, key, tag or trigger phrase lifts that doc's chunks even when the body never
 * repeats the word. Rank fusion needs no score calibration between the three.
 */
export async function recall(db: Database.Database, query: string, opts: RecallOptions = {}): Promise<RecallResult> {
  const { maxTokens = 2000, table, hidden, embedder } = opts;
  const fused = new Map<number, number>();
  const add = (chunkId: number, rank: number, weight = 1) => fused.set(chunkId, (fused.get(chunkId) ?? 0) + weight / (RRF_K + rank));

  const invisible = invisibleChunks(db, hidden);

  const corrections = correctWords(db, query.toLowerCase().match(WORD_RE) ?? []);
  const ftsQuery = questionToFtsQuery(query, corrections);
  const tableFilter = table ? `AND c.ref_table = '${table}'` : '';
  let docRanks: Array<{ ref_table: RefTable; ref_id: string; ref_folder: string }> = [];
  if (ftsQuery) {
    const lexical = db
      .prepare(
        `SELECT c.id FROM chunk_fts JOIN chunks c ON c.id = chunk_fts.rowid
         WHERE chunk_fts MATCH ? ${tableFilter}
         ORDER BY bm25(chunk_fts, 3.0, 1.0) LIMIT ${CANDIDATES_PER_LIST + invisible.chunkIds.size}`
      )
      .all(ftsQuery) as Array<{ id: number }>;
    lexical
      .filter((row) => !invisible.chunkIds.has(row.id))
      .slice(0, CANDIDATES_PER_LIST)
      .forEach((row, i) => add(row.id, i + 1));

    docRanks = db
      .prepare(
        `SELECT ref_table, ref_id, ref_folder FROM search_index
         WHERE search_index MATCH ? ${table ? `AND ref_table = '${table}'` : ''}
         ORDER BY ${SEARCH_BM25} LIMIT ${DOC_CANDIDATES + invisible.docKeys.size}`
      )
      .all(ftsQuery) as typeof docRanks;
    docRanks = docRanks.filter((doc) => !invisible.docKeys.has(docKey(doc))).slice(0, DOC_CANDIDATES);
  }

  let mode: RecallResult['mode'] = 'lexical';
  if (embedder) {
    const [queryVector] = await embedder.embed([query], 'query');
    const semantic = vectorSearch(db, embedder.model, queryVector!, CANDIDATES_PER_LIST * (table ? 4 : 1), invisible.chunkIds);
    if (semantic.length > 0) mode = 'hybrid';
    semantic.forEach((hit, i) => add(hit.id, i + 1, SEMANTIC_WEIGHT));
  }

  // Doc-level boost: every candidate chunk of a doc-level hit gains that doc's rank; a doc with no
  // candidate chunk yet (the query matched only its name/key/tags) contributes its opening chunk.
  const firstChunkOf = db.prepare(`SELECT id FROM chunks WHERE ref_table = ? AND ref_id = ? AND ref_folder = ? ORDER BY ord LIMIT 1`);
  const chunkById = db.prepare(`SELECT id, ref_table, ref_id, ref_folder, ord, heading, text, hash FROM chunks WHERE id = ?`);
  const rows = new Map<number, ChunkRow>();
  for (const id of fused.keys()) {
    const row = chunkById.get(id) as ChunkRow | undefined;
    if (row && (!table || row.ref_table === table)) rows.set(id, row);
    else fused.delete(id);
  }
  docRanks.forEach((doc, i) => {
    const key = docKey(doc);
    const members = [...rows.values()].filter((row) => docKey(row) === key);
    if (members.length === 0) {
      const first = firstChunkOf.get(doc.ref_table, doc.ref_id, doc.ref_folder) as { id: number } | undefined;
      const row = first && (chunkById.get(first.id) as ChunkRow | undefined);
      if (row) {
        rows.set(row.id, row);
        members.push(row);
      }
    }
    for (const row of members) add(row.id, i + 1);
  });

  // Resolve each candidate's parent doc once — for its public handle, and to drop paused/hidden docs.
  const skillMeta = db.prepare(`SELECT folder, paused, deprecated, status FROM skills WHERE id = ? AND folder = ?`);
  const memoryMeta = db.prepare(`SELECT folder, key, paused, deprecated, status FROM memory_docs WHERE source_path = ?`);
  const docs = new Map<string, { id: string; folder: string; key?: string; stale?: RecallChunk['stale'] } | null>();
  const resolveDoc = (row: ChunkRow) => {
    const key = docKey(row);
    if (!docs.has(key)) {
      const meta = (row.ref_table === 'skills' ? skillMeta.get(row.ref_id, row.ref_folder) : memoryMeta.get(row.ref_id)) as
        | { folder: string; key?: string; paused: number; deprecated: number; status: string }
        | undefined;
      const visible = meta && !meta.paused && !(hidden?.[row.ref_table] ?? []).includes(meta.folder);
      docs.set(
        key,
        visible
          ? {
              id: row.ref_table === 'skills' ? row.ref_id : path.basename(row.ref_id),
              folder: meta.folder,
              key: meta.key,
              stale: meta.deprecated ? 'deprecated' : meta.status === 'abandoned' ? 'abandoned' : undefined,
            }
          : null
      );
    }
    return docs.get(key)!;
  };

  const ranked = [...rows.values()]
    .map((row) => ({ row, score: fused.get(row.id) ?? 0, doc: resolveDoc(row) }))
    .filter((c): c is typeof c & { doc: NonNullable<typeof c.doc> } => c.doc !== null)
    .map((c) => (c.doc.stale ? { ...c, score: c.score * STALE_SCORE_FACTOR } : c))
    .sort((a, b) => b.score - a.score);

  const floor = (ranked[0]?.score ?? 0) * RELATIVE_SCORE_FLOOR;
  const perDoc = new Map<string, number>();
  // The same skill synced into two folders yields byte-identical passages — return each once.
  const seenText = new Set<string>();
  const chunks: RecallChunk[] = [];
  let budget = maxTokens;
  let truncated = false;
  for (const { row, score, doc } of ranked) {
    if (score < floor) break;
    const key = docKey(row);
    if ((perDoc.get(key) ?? 0) >= MAX_CHUNKS_PER_DOC || seenText.has(row.hash)) continue;
    let text = row.text;
    const cost = () => HEADER_TOKENS + Math.ceil((row.heading.length + text.length) / CHARS_PER_TOKEN);
    if (cost() > budget) {
      truncated = true;
      // Always return something for the best hit, even under a budget smaller than one chunk.
      if (chunks.length > 0) continue;
      text = text.slice(0, Math.max(0, (budget - HEADER_TOKENS) * CHARS_PER_TOKEN - row.heading.length)) + '…';
    }
    budget -= cost();
    perDoc.set(key, (perDoc.get(key) ?? 0) + 1);
    seenText.add(row.hash);
    chunks.push({ ref_table: row.ref_table, id: doc.id, folder: doc.folder, key: doc.key, heading: row.heading, ord: row.ord, text, score, stale: doc.stale });
  }
  return { mode, chunks, truncated, corrections: Object.fromEntries(corrections) };
}

/**
 * Renders a recall result as compact markdown rather than JSON — passages are mostly multi-line
 * text, and JSON-escaping every newline and quote costs tokens for nothing. Chunks of the same doc
 * are grouped (docs in best-hit order) and shown in document order.
 */
export function formatRecall(result: RecallResult, note?: string): string {
  if (result.chunks.length === 0) return `No matches.${note ? ` ${note}` : ''}`;
  const groups = new Map<string, RecallChunk[]>();
  for (const chunk of result.chunks) {
    const key = `${chunk.ref_table}\0${chunk.folder}\0${chunk.id}`;
    groups.set(key, [...(groups.get(key) ?? []), chunk]);
  }
  const corrected = Object.entries(result.corrections).map(([from, to]) => `"${from}" read as "${to}"`).join(', ');
  const lines = [
    `${result.mode} search, ${result.chunks.length} passages from ${groups.size} docs${result.truncated ? ' (more matched — raise max_tokens)' : ''}${corrected ? `; ${corrected}` : ''}${note ? `. ${note}` : ''}`,
  ];
  for (const group of groups.values()) {
    const first = group[0]!;
    const label = first.ref_table === 'skills' ? `skill ${first.id}` : `memory ${first.id}`;
    const details = [first.folder && `folder: ${first.folder}`, first.key && `key: ${first.key}`, first.stale].filter(Boolean).join(', ');
    lines.push('', `## ${label}${details ? ` (${details})` : ''}`);
    let previousHeading = '';
    for (const chunk of group.sort((a, b) => a.ord - b.ord)) {
      // Consecutive pieces of one oversized section share a heading — print it once.
      if (chunk.heading && chunk.heading !== previousHeading) lines.push(`### ${chunk.heading}`);
      previousHeading = chunk.heading;
      lines.push(chunk.text, '');
    }
  }
  return lines.join('\n').trimEnd();
}
