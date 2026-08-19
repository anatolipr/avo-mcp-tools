import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { searchCombined, searchByDate, SearchQueryError } from '../store/search.js';

export function registerSearchTool(mcp: McpServer, db: Database.Database): void {
  mcp.tool(
    'bucket_search',
    'Full-text search across BOTH skills and memory docs in one ranked list — use this when you don\'t know (or don\'t care) which bucket something landed in. `query` is raw SQLite FTS5 MATCH syntax: bare words, "exact phrases", prefix* wildcards, AND/OR/NOT boolean operators; hyphenated/punctuated terms must be quoted, e.g. "blue-green". For filtering by doc_type/status/tag, use skill_search or memory_search instead. Returns ranked hits with a highlighted snippet, not full body — call skill_get/memory_get on a hit for that.',
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
