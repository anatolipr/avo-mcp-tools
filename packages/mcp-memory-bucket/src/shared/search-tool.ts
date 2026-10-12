import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { searchCombined, searchByDate, SearchQueryError } from '../store/search.js';
import { recall, formatRecall } from '../store/recall.js';
import type { EmbeddingIndexer } from '../store/embeddings.js';

export interface RecallDeps {
  /** Per-table folder names hidden from the current login — evaluated per call, since login can change. */
  hiddenFolders: () => { skills: string[]; memory_docs: string[] };
  /** Absent when embeddings are disabled — bucket_recall is then lexical-only. */
  indexer?: EmbeddingIndexer;
}

export function registerSearchTool(mcp: McpServer, db: Database.Database, deps: RecallDeps): void {
  mcp.tool(
    'bucket_recall',
    'Answers "what do I have about X" in one call: takes a plain natural-language question (no query syntax) and returns the most relevant PASSAGES — heading-level sections with their full text — from skills and memory docs, ranked by hybrid keyword + semantic similarity and packed into max_tokens. Prefer this over *_search followed by *_get when you want content rather than a list of docs; use skill_get/memory_get only when a returned passage shows you need its whole document. Paused docs are excluded.',
    {
      query: z.string().describe('a question or topic in plain words, e.g. `how do I position a tooltip so it flips at the viewport edge`'),
      max_tokens: z.number().int().min(200).max(20000).optional().describe('budget for returned passage text, default 2000'),
      bucket: z.enum(['skills', 'memory_docs']).optional().describe('restrict to one bucket; omit to search both'),
    },
    async ({ query, max_tokens, bucket }) => {
      try {
        const { indexer } = deps;
        const result = await recall(db, query, {
          maxTokens: max_tokens,
          table: bucket,
          hidden: deps.hiddenFolders(),
          embedder: indexer?.isReady() ? indexer.embedder : undefined,
        });
        let note: string | undefined;
        if (indexer && result.mode === 'lexical') {
          const status = indexer.status();
          note = status.error
            ? `Semantic index unavailable (${status.error}) — keyword matches only.`
            : `Semantic index still building (${status.embedded}/${status.total} passages) — keyword matches only for now.`;
        }
        return { content: [{ type: 'text', text: formatRecall(result, note) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'bucket_search',
    'Keyword search across BOTH skills and memory docs in one ranked list of DOCS (for passages, use bucket_recall) — use this to locate a doc when you don\'t know which bucket it landed in. `query` is SQLite FTS5 MATCH syntax: bare words (all must match; falls back to any-word when nothing matches all), "exact phrases", prefix* wildcards, AND/OR/NOT. For filtering by doc_type/status/tag, use skill_search or memory_search instead. Returns ranked hits with a highlighted snippet, not full body — call skill_get/memory_get on a hit for that.',
    {
      query: z.string().describe('FTS5 match expression, e.g. `deploy AND rollback` or `"blue green"`'),
      limit: z.number().int().positive().max(100).optional(),
      offset: z.number().int().nonnegative().optional(),
    },
    async ({ query, limit, offset }) => {
      try {
        const hits = searchCombined(db, query, limit, offset);
        return { content: [{ type: 'text', text: JSON.stringify(hits, null, 2) }] };
      } catch (err) {
        const message = err instanceof SearchQueryError ? err.message : (err as Error).message;
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    }
  );

  mcp.tool(
    'search_by_date',
    'Finds skills and memory docs whose body text mentions a date, OR whose created_at falls, within [start, end] (inclusive, ISO YYYY-MM-DD). Matches any date extracted from the document body plus its created_at — ANY-match, no priority between them. created_at is stored converted to the server\'s local calendar date, so "today"/"this week" ranges built from local time line up correctly without any timezone adjustment. Useful for period-based recall, e.g. "what did I work on this week": the caller computes the date range itself, this tool does not parse natural language. Returns ranked hits (earliest matched date first) with a highlighted snippet showing the matched date in context (or a note that it matched via created_at, when the date isn\'t literally in the body), not the full body — call skill_get/memory_get on a hit for that.',
    {
      start: z.string().describe('ISO date YYYY-MM-DD, inclusive'),
      end: z.string().describe('ISO date YYYY-MM-DD, inclusive'),
      table: z.enum(['skills', 'memory_docs']).optional().describe('restrict to one bucket; omit to search both'),
      limit: z.number().int().positive().max(100).optional(),
      offset: z.number().int().nonnegative().optional(),
    },
    async ({ start, end, table, limit, offset }) => {
      try {
        const hits = searchByDate(db, start, end, { table, limit, offset });
        return { content: [{ type: 'text', text: JSON.stringify(hits, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );
}
