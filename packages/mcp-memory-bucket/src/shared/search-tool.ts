import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { searchCombined, SearchQueryError } from '../store/search.js';

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
}
