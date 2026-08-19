import type Database from 'better-sqlite3';

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

/**
 * Full-text search over the shared FTS5 index, optionally scoped to one ref_table.
 * `query` is passed through as raw FTS5 MATCH syntax — supports `AND`/`OR`/`NOT`,
 * `"exact phrases"`, and `prefix*` — so callers get grep-like power for free.
 * Ranked by bm25() (lower is better, so we negate for a "higher is better" score).
 * Throws SearchQueryError on malformed FTS5 syntax instead of a raw SQLite error.
 */
export function searchIndex(
  db: Database.Database,
  query: string,
  opts: { table?: 'skills' | 'memory_docs'; limit?: number; offset?: number } = {}
): SearchHit[] {
  const { table, limit = 20, offset = 0 } = opts;
  try {
    const rows = db
      .prepare(
        `SELECT ref_table, ref_id,
                snippet(search_index, 3, '<<', '>>', '…', 20) AS snippet,
                -bm25(search_index) AS score
         FROM search_index
         WHERE search_index MATCH ? ${table ? 'AND ref_table = ?' : ''}
         ORDER BY bm25(search_index)
         LIMIT ? OFFSET ?`
      )
      .all(...(table ? [query, table, limit, offset] : [query, limit, offset])) as SearchHit[];
    return rows;
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
      `SELECT ref_table, ref_id, MIN(date) AS matched_date
       FROM doc_dates
       WHERE date BETWEEN ? AND ? ${table ? 'AND ref_table = ?' : ''}
       GROUP BY ref_table, ref_id
       ORDER BY matched_date
       LIMIT ? OFFSET ?`
    )
    .all(...params) as Array<{ ref_table: 'skills' | 'memory_docs'; ref_id: string; matched_date: string }>;

  return rows.map((row) => {
    const bodyRow = db
      .prepare(`SELECT body FROM ${row.ref_table} WHERE id = ?`)
      .get(row.ref_id) as { body: string } | undefined;
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
  root: string;
  snippet: string;
  score: number;
}

/**
 * Full-text search across BOTH skills and memory docs in one ranked list —
 * for the common case of "find where I put X" when the caller doesn't know
 * which bucket it landed in. No metadata filters (doc_type/status/tag differ
 * per table); use skill_search/memory_search directly when filtering by those.
 */
export function searchCombined(db: Database.Database, query: string, limit = 20, offset = 0): CombinedSearchHit[] {
  try {
    return db
      .prepare(
        `SELECT ref_table, ref_id AS id,
                COALESCE(s.description, m.description) AS description,
                COALESCE(s.root, m.root) AS root,
                snippet(search_index, 3, '<<', '>>', '…', 20) AS snippet,
                -bm25(search_index) AS score
         FROM search_index
         LEFT JOIN skills s ON search_index.ref_table = 'skills' AND s.id = search_index.ref_id
         LEFT JOIN memory_docs m ON search_index.ref_table = 'memory_docs' AND m.id = search_index.ref_id
         WHERE search_index MATCH ?
         ORDER BY bm25(search_index)
         LIMIT ? OFFSET ?`
      )
      .all(query, limit, offset) as CombinedSearchHit[];
  } catch (err) {
    throw new SearchQueryError(query, err);
  }
}
