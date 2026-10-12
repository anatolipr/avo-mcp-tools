import type Database from 'better-sqlite3';
import { correctWords } from './spelling.js';

export interface SearchHit {
  ref_table: 'skills' | 'memory_docs';
  ref_id: string;
  snippet: string;
  score: number;
}

/** A quoted FTS5 syntax error, translated into something an agent can act on without seeing raw SQLite internals. */
export class SearchQueryError extends Error {
  constructor(query: string, cause: unknown) {
    super(
      `invalid search query "${query}": ${(cause as Error).message}. ` +
        `FTS5 syntax notes: hyphenated/punctuated words must be quoted (e.g. "blue-green"), ` +
        `bare words are AND'd by default, use OR/NOT for other logic, "exact phrase" for phrases, and prefix* for prefix matching.`
    );
    this.name = 'SearchQueryError';
  }
}

const FTS_BOOLEAN_KEYWORDS = new Set(['AND', 'OR', 'NOT']);

/**
 * Auto-quotes bareword tokens that contain punctuation (e.g. a bare hyphenated ticket key like
 * `RMXS-15`) so FTS5 doesn't interpret a bare `-` as its NOT/column-filter operator and silently
 * return zero rows. Already-quoted phrases, `AND`/`OR`/`NOT` operators, and `prefix*` wildcards are
 * left untouched so existing power-user query syntax keeps working exactly as before.
 */
export function sanitizeFtsQuery(query: string): string {
  const tokens = query.match(/"[^"]*"|\S+/g) ?? [];
  return tokens
    .map((token) => {
      if (token.startsWith('"')) return token; // already an explicit phrase
      if (FTS_BOOLEAN_KEYWORDS.has(token.toUpperCase())) return token; // boolean operator
      if (/^[A-Za-z0-9_*]+$/.test(token)) return token; // plain word or prefix* wildcard — no punctuation
      return `"${token.replace(/"/g, '""')}"`; // punctuation present (hyphen, colon, etc.) — quote it literally
    })
    .join(' ');
}

/**
 * bm25() over search_index with per-column weights, in column order (ref_table, ref_id, ref_folder,
 * description, body, tags, key, filename, triggers) — a hit in a doc's name/key/trigger phrases
 * says far more about what the doc IS than the same word appearing somewhere in a long body.
 */
export const SEARCH_BM25 = 'bm25(search_index, 0, 0, 0, 4.0, 1.0, 3.0, 6.0, 8.0, 6.0)';
/** Best-matching column's excerpt (-1), not a fixed column — a hit in tags/key alone still shows why it matched. */
export const SEARCH_SNIPPET = `snippet(search_index, -1, '<<', '>>', '…', 20)`;

/** True when the caller used FTS5 syntax (quotes, AND/OR/NOT, prefix*, parentheses, column filters) and so meant the query literally. */
export function hasExplicitSyntax(query: string): boolean {
  const tokens = query.match(/\S+/g) ?? [];
  return tokens.some((t) => FTS_BOOLEAN_KEYWORDS.has(t.toUpperCase()) || /["*():^]/.test(t));
}

/**
 * Runs `run` with the sanitized query and, only when that matches nothing and the query is plain
 * bare words, loosens it in two steps: first the words OR'd instead of FTS5's implicit AND (bm25
 * ranks docs matching more of them first), then with misspelled words replaced by the closest word
 * in the corpus (see spelling.ts). A query using explicit syntax is never loosened.
 */
export function withOrFallback<T>(db: Database.Database, query: string, offset: number, run: (ftsQuery: string, probe: boolean) => T[]): T[] {
  const strict = sanitizeFtsQuery(query);
  const rows = run(strict, false);
  if (rows.length > 0 || hasExplicitSyntax(query)) return rows;
  // An empty page past the first is not "no AND matches" — don't start serving looser rows mid-pagination.
  if (offset > 0 && run(strict, true).length > 0) return rows;
  const tokens = query.match(/\S+/g) ?? [];
  if (tokens.length > 1) {
    const relaxed = run(tokens.map((t) => sanitizeFtsQuery(t)).join(' OR '), false);
    if (relaxed.length > 0) return relaxed;
  }
  const corrections = correctWords(db, tokens);
  if (corrections.size === 0) return rows;
  return run(tokens.map((t) => sanitizeFtsQuery(corrections.get(t) ?? t)).join(' OR '), false);
}

/**
 * Full-text search over the shared FTS5 index, optionally scoped to one ref_table.
 * `query` is passed through as raw FTS5 MATCH syntax — supports `AND`/`OR`/`NOT`,
 * `"exact phrases"`, and `prefix*` — so callers get grep-like power for free.
 * Ranked by weighted bm25() (lower is better, so we negate for a "higher is better" score); bare
 * words that match nothing together fall back to OR, then to typo correction (see withOrFallback).
 * Throws SearchQueryError on malformed FTS5 syntax instead of a raw SQLite error.
 */
export function searchIndex(
  db: Database.Database,
  query: string,
  opts: { table?: 'skills' | 'memory_docs'; limit?: number; offset?: number } = {}
): SearchHit[] {
  const { table, limit = 20, offset = 0 } = opts;
  try {
    const statement = db.prepare(
      `SELECT ref_table, ref_id,
              ${SEARCH_SNIPPET} AS snippet,
              -${SEARCH_BM25} AS score
       FROM search_index
       WHERE search_index MATCH ? ${table ? 'AND ref_table = ?' : ''}
       ORDER BY ${SEARCH_BM25}
       LIMIT ? OFFSET ?`
    );
    return withOrFallback(db, query, offset, (ftsQuery, probe) => {
      const page = probe ? [1, 0] : [limit, offset];
      return statement.all(...(table ? [ftsQuery, table, ...page] : [ftsQuery, ...page])) as SearchHit[];
    });
  } catch (err) {
    throw new SearchQueryError(query, err);
  }
}

export interface DateSearchHit {
  ref_table: 'skills' | 'memory_docs';
  ref_id: string;
  matched_date: string;
  snippet: string;
}

const SNIPPET_CONTEXT_WORDS = 20;

/**
 * Builds a `<<...>>`-marked excerpt around the first occurrence of `date` in
 * `body`, mirroring FTS5's snippet() style for visual consistency with the
 * other search tools. `date` doesn't always appear literally in the body —
 * it may have matched via created_at instead — in which case there's no
 * position to excerpt around, so the marker stands alone with no context.
 */
function buildDateSnippet(body: string, date: string): string {
  const idx = body.indexOf(date);
  if (idx === -1) return `<<${date}>> (matched via created_at, not mentioned in body)`;
  const before = body.slice(0, idx).split(/\s+/).filter(Boolean).slice(-SNIPPET_CONTEXT_WORDS).join(' ');
  const after = body
    .slice(idx + date.length)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, SNIPPET_CONTEXT_WORDS)
    .join(' ');
  return `${before ? '…' + before + ' ' : ''}<<${date}>>${after ? ' ' + after + '…' : ''}`;
}

/**
 * Finds skills/memory docs whose body mentions a date, OR whose created_at
 * falls, within [start, end] (inclusive, ISO YYYY-MM-DD) — driven by the
 * `doc_dates` side table, populated at index time from both extractDates()
 * on the body and the doc's created_at, not FTS5. ANY-match: a doc with
 * multiple candidate dates matches if any falls in range; `matched_date` is
 * the earliest match, with no priority between body-extracted and created_at.
 */
export function searchByDate(
  db: Database.Database,
  start: string,
  end: string,
  opts: { table?: 'skills' | 'memory_docs'; limit?: number; offset?: number } = {}
): DateSearchHit[] {
  if (start > end) {
    throw new Error(`invalid date range: start "${start}" is after end "${end}"`);
  }
  const { table, limit = 20, offset = 0 } = opts;
  const params: unknown[] = [start, end];
  if (table) params.push(table);
  params.push(limit, offset);

  const rows = db
    .prepare(
      `SELECT ref_table, ref_id, ref_folder, MIN(date) AS matched_date
       FROM doc_dates
       WHERE date BETWEEN ? AND ? ${table ? 'AND ref_table = ?' : ''}
       GROUP BY ref_table, ref_id, ref_folder
       ORDER BY matched_date
       LIMIT ? OFFSET ?`
    )
    .all(...params) as Array<{ ref_table: 'skills' | 'memory_docs'; ref_id: string; ref_folder: string; matched_date: string }>;

  return rows.map((row) => {
    // Scoped by ref_folder for skills (compound key: a bare `id` can match two different
    // folders' same-named skills — see doc_dates'/search_index's ref_folder column). memory_docs'
    // ref_id is source_path (globally unique by construction), so ref_folder is always '' there
    // and the extra condition is a no-op.
    const bodyRow = (
      row.ref_table === 'skills'
        ? db.prepare(`SELECT body FROM skills WHERE id = ? AND folder = ?`).get(row.ref_id, row.ref_folder)
        : db.prepare(`SELECT body FROM memory_docs WHERE source_path = ?`).get(row.ref_id)
    ) as { body: string } | undefined;
    return {
      ref_table: row.ref_table,
      ref_id: row.ref_id,
      matched_date: row.matched_date,
      snippet: bodyRow ? buildDateSnippet(bodyRow.body, row.matched_date) : '',
    };
  });
}

export interface CombinedSearchHit {
  ref_table: 'skills' | 'memory_docs';
  id: string; // skill name, or memory doc id
  description: string;
  folder: string;
  snippet: string;
  score: number;
  /** Present only when this hit is an item-level share (see remote/shared-items.ts) — its `folder`
   * is a synthetic "shared-by-<owner>" name, not a configured folder. shared_owner/shared_role
   * surface the provenance (and the read-only role) without requiring a caller to cross-reference
   * bucket_list_shared_items separately. */
  shared_owner?: string;
  shared_role?: 'member' | 'editor';
}

/**
 * Full-text search across BOTH skills and memory docs in one ranked list —
 * for the common case of "find where I put X" when the caller doesn't know
 * which bucket it landed in. No metadata filters (doc_type/status/tag differ
 * per table); use skill_search/memory_search directly when filtering by those.
 */
export function searchCombined(db: Database.Database, query: string, limit = 20, offset = 0): CombinedSearchHit[] {
  try {
    const statement = db.prepare(
      `SELECT ref_table, ref_id AS id,
              COALESCE(s.description, m.description) AS description,
              COALESCE(s.folder, m.folder) AS folder,
              ${SEARCH_SNIPPET} AS snippet,
              -${SEARCH_BM25} AS score,
              si.owner AS shared_owner,
              si.role AS shared_role
       FROM search_index
       LEFT JOIN skills s ON search_index.ref_table = 'skills' AND s.id = search_index.ref_id AND s.folder = search_index.ref_folder
       LEFT JOIN memory_docs m ON search_index.ref_table = 'memory_docs' AND m.source_path = search_index.ref_id
       LEFT JOIN shared_items si ON si.status = 'active' AND si.mirror_path = COALESCE(s.source_path, m.source_path)
       WHERE search_index MATCH ?
       ORDER BY ${SEARCH_BM25}
       LIMIT ? OFFSET ?`
    );
    const rows = withOrFallback(
      db,
      query,
      offset,
      (ftsQuery, probe) =>
        statement.all(ftsQuery, ...(probe ? [1, 0] : [limit, offset])) as Array<CombinedSearchHit & { shared_owner: string | null; shared_role: string | null }>
    );
    return rows.map((row) => ({
      ...row,
      shared_owner: row.shared_owner ?? undefined,
      shared_role: (row.shared_role as 'member' | 'editor' | null) ?? undefined,
    }));
  } catch (err) {
    throw new SearchQueryError(query, err);
  }
}
