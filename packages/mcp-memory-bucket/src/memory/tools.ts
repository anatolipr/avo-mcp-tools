import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MemoryRepository } from './repository.js';
import { stripKey } from './repository.js';
import { statusSchema } from '../shared/status.js';
import { bodyEditsSchema, applyBodyEdits, formatBodyEditsDiff } from '../shared/body-edits.js';
import { normalizeKey } from '../types.js';

const MEMORY_DOC_TYPES = ['plan', 'spec', 'sql', 'testing-todo', 'discovery', 'session-summary', 'other'] as const;
const MEMORY_KEY_TYPES = ['ticket', 'freeform'] as const;
const MEMORY_STATUS_DEFAULTS = ['active', 'shipped', 'abandoned'] as const;
const AUTHORING_SKILL_HINT =
  "Before your first call in a session, run skill_get(\"memory-bucket-authoring\") to learn the exact frontmatter schema and conventions — don't guess the shape.";

export function registerMemoryTools(mcp: McpServer, repo: MemoryRepository): void {
  const folders = repo.listFolders();
  const multiFolder = folders.length > 1;
  const folderNames = folders.map((f) => f.name).join(', ');

  mcp.tool(
    'memory_get',
    'Exact-match lookup of memory docs (plan/spec/sql/etc.) by normalized key — a ticket ID or a free-form name like "Spot Chart Design". Returns every doc under that key, or only the matching doc_type if provided. Paused docs are hidden by default — pass include_paused to see them.',
    {
      key: z.string(),
      doc_type: z.enum(MEMORY_DOC_TYPES).optional(),
      include_paused: z.boolean().optional().describe('include paused docs, which are hidden by default (see memory_set_paused)'),
    },
    async ({ key, doc_type, include_paused }) => {
      const docs = repo.getByKey(key, doc_type, { includePaused: include_paused });
      return { content: [{ type: 'text', text: JSON.stringify(docs, null, 2) }] };
    }
  );

  mcp.tool(
    'memory_bulk_get',
    'Fetches many memory docs by id in one call, including full markdown bodies — e.g. hydrating a batch of memory_search hits (which return ids, not keys). Missing ids are simply omitted from the result, not errors.',
    { ids: z.array(z.string()).min(1) },
    async ({ ids }) => {
      const docs = repo.bulkGet(ids);
      return { content: [{ type: 'text', text: JSON.stringify(docs, null, 2) }] };
    }
  );

  mcp.tool(
    'memory_list',
    'Browses available memory keys (optionally filtered by a prefix) without needing to know the exact key upfront. Returns each key with its doc count.',
    { key_prefix: z.string().optional() },
    async ({ key_prefix }) => {
      const keys = repo.listKeys(key_prefix);
      return { content: [{ type: 'text', text: JSON.stringify(keys, null, 2) }] };
    }
  );

  mcp.tool(
    'memory_search',
    'Full-text search over memory doc description/body/tags (grep/find-like, ranked by relevance) — unlike memory_get\'s exact-key lookup, this searches by content across all keys. `query` is raw SQLite FTS5 MATCH syntax: bare words, "exact phrases", prefix* wildcards, AND/OR/NOT boolean operators; hyphenated/punctuated terms must be quoted, e.g. "blue-green". Can be combined with doc_type/status/tag filters. Returns ranked hits with a highlighted snippet, not the full body — call memory_get(key) or fetch by id for that. Paused docs are hidden by default — pass include_paused to see them.',
    {
      query: z.string().describe('FTS5 match expression, e.g. `migration AND rollback` or `"blue green"`'),
      doc_type: z.enum(MEMORY_DOC_TYPES).optional(),
      status: statusSchema(MEMORY_STATUS_DEFAULTS).optional(),
      tag: z.string().optional(),
      ...(multiFolder ? { folder: z.string().optional().describe(`filter to one folder: ${folderNames}`) } : {}),
      limit: z.number().int().positive().max(100).optional(),
      offset: z.number().int().nonnegative().optional(),
      include_paused: z.boolean().optional().describe('include paused docs, which are hidden by default (see memory_set_paused)'),
    },
    async ({ query, doc_type, status, tag, folder, limit, offset, include_paused }: any) => {
      try {
        const hits = repo.search(query, { docType: doc_type, status, tag, folder, limit, offset, includePaused: include_paused });
        return { content: [{ type: 'text', text: JSON.stringify(hits, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'memory_bulk_update',
    'Applies the same frontmatter change to many memory docs at once by id — e.g. add/remove a tag across a batch found via memory_search, or mark a group of docs "shipped". add_tags/remove_tags merge or subtract per-doc; status/related_to overwrite uniformly when provided. Body is never touched. Returns per-id success/failure so one bad id doesn\'t abort the batch.',
    {
      ids: z.array(z.string()).min(1),
      add_tags: z.array(z.string()).optional(),
      remove_tags: z.array(z.string()).optional(),
      status: statusSchema(MEMORY_STATUS_DEFAULTS).optional(),
      related_to: z.string().nullable().optional(),
      deprecated: z.boolean().optional().describe('marks docs as deprecated (or un-deprecates when false) — independent of status'),
    },
    async ({ ids, add_tags, remove_tags, status, related_to, deprecated }) => {
      const results = repo.bulkUpdate(ids, { add_tags, remove_tags, status, related_to, deprecated });
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  mcp.tool(
    'memory_create',
    `Writes a new memory doc (plan, spec, SQL, testing notes, discovery, etc.) into the memory folder under the given key. ${AUTHORING_SKILL_HINT}`,
    {
      key: z.string().describe('lookup handle — ticket ID or free-form name; normalized on write'),
      key_type: z.enum(MEMORY_KEY_TYPES),
      doc_type: z.enum(MEMORY_DOC_TYPES),
      description: z.string().describe('distinguishes this doc from others sharing the same key'),
      body: z.string(),
      tags: z.array(z.string()).optional(),
      status: statusSchema(MEMORY_STATUS_DEFAULTS).optional().describe('defaults to "active"'),
      related_to: z.string().optional().describe('id of a related doc, e.g. a spec linking to its plan'),
      subfolder: z.string().optional().describe('optional subdirectory under the memory folder'),
      ...(multiFolder ? { folder: z.string().describe(`which configured memory folder to write into: ${folderNames}`) } : {}),
    },
    async ({ key, key_type, doc_type, description, body, tags, status, related_to, subfolder, folder }: any) => {
      try {
        const normalized = normalizeKey(key);
        const strippedNew = stripKey(normalized);
        const nearDuplicate = repo
          .suggestKeys(key, 3)
          .find((m) => stripKey(m.key) === strippedNew && m.key !== normalized);

        const doc = repo.create({ key, key_type, doc_type, description, body, tags, status, related_to, subfolder, folder });

        const result: Record<string, unknown> = { ...doc };
        if (nearDuplicate) {
          result.key_warning = `A similarly-formatted key "${nearDuplicate.key}" already exists with ${nearDuplicate.docCount} doc(s) — did you mean to use that key instead of "${normalized}"? This doc was still created under "${normalized}".`;
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  const memoryEntrySchema = z.object({
    key: z.string().describe('lookup handle — ticket ID or free-form name; normalized on write'),
    key_type: z.enum(MEMORY_KEY_TYPES),
    doc_type: z.enum(MEMORY_DOC_TYPES),
    description: z.string().describe('distinguishes this doc from others sharing the same key'),
    body: z.string(),
    tags: z.array(z.string()).optional(),
    status: statusSchema(MEMORY_STATUS_DEFAULTS).optional().describe('defaults to "active"'),
    related_to: z.string().optional(),
    subfolder: z.string().optional(),
    ...(multiFolder ? { folder: z.string().describe(`which configured memory folder to write into: ${folderNames}`) } : {}),
  });

  mcp.tool(
    'memory_bulk_create',
    `Writes many memory docs in one call — each entry is the same shape as memory_create's args. Returns per-key success/failure (with the new id on success) so one bad entry doesn't abort the rest of the batch. ${AUTHORING_SKILL_HINT}`,
    { entries: z.array(memoryEntrySchema).min(1) },
    async ({ entries }: any) => {
      const results = repo.bulkCreate(entries);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  mcp.tool(
    'memory_update',
    `Edits an existing memory doc in place — frontmatter fields and/or body. Only provided fields change. For a body change smaller than the whole document, prefer body_edits over body: it patches via find/replace instead of requiring you to reproduce the entire body, which saves tokens and avoids accidentally dropping untouched content on a large doc. When body_edits is used, the response includes a \`diff\` field (compact -/+ per-edit summary) — show it to the user so they can see what changed, similar to a code diff view. The response never includes the full body (even on a full-body replacement) to avoid echoing back a potentially large doc — call memory_get(id) if you need the fresh full body. ${AUTHORING_SKILL_HINT}`,
    {
      id: z.string(),
      key: z.string().optional(),
      key_type: z.enum(MEMORY_KEY_TYPES).optional(),
      doc_type: z.enum(MEMORY_DOC_TYPES).optional(),
      description: z.string().optional(),
      body: z.string().optional().describe('full body replacement — omit in favor of body_edits when only part of the doc is changing'),
      body_edits: bodyEditsSchema.optional(),
      tags: z.array(z.string()).optional(),
      status: statusSchema(MEMORY_STATUS_DEFAULTS).optional(),
      related_to: z.string().optional(),
      deprecated: z.boolean().optional().describe('marks the doc as deprecated (or un-deprecates when false) — independent of status'),
    },
    async ({ id, body, body_edits, ...frontmatterFields }) => {
      if (body !== undefined && body_edits !== undefined) {
        return { content: [{ type: 'text', text: 'Pass either body or body_edits, not both.' }], isError: true };
      }
      try {
        let diff: string | undefined;
        if (body_edits) {
          const existing = repo.get(id);
          if (!existing) throw new Error(`memory doc with id "${id}" not found`);
          const { body: patchedBody, applied } = applyBodyEdits(existing.body, body_edits);
          diff = formatBodyEditsDiff(applied);
          body = patchedBody;
        }
        const doc = repo.update(id, frontmatterFields, body);
        // Body is omitted from the response: the caller either just sent it (full replacement),
        // already has it, or has `diff` — echoing a potentially large body back is pure waste.
        // Fetch memory_get(id) if the fresh full body is actually needed.
        const { body: _omitted, ...docWithoutBody } = doc;
        const result = diff ? { ...docWithoutBody, diff } : docWithoutBody;
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'memory_set_paused',
    'Pauses or resumes memory docs by id — a local-only toggle stored in this machine\'s SQLite cache, never written to the doc\'s markdown file, so it never touches the file on disk and never follows the doc to another machine\'s cache. Paused docs are hidden from memory_get/memory_search by default but stay fully intact and are still fetchable directly via memory_bulk_get — use this to temporarily stop a doc from surfacing during discovery without deprecating it. Returns per-id success/failure so one bad id doesn\'t abort the batch.',
    {
      ids: z.array(z.string()).min(1),
      paused: z.boolean().describe('true to pause (hide from memory_get/memory_search), false to resume'),
    },
    async ({ ids, paused }) => {
      const results = repo.setPaused(ids, paused);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  mcp.tool(
    'memory_delete',
    'Hard-deletes a memory doc by id — removes the markdown file, no tombstone.',
    { id: z.string() },
    async ({ id }) => {
      try {
        repo.delete(id);
        return { content: [{ type: 'text', text: `Deleted memory doc "${id}"` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'memory_bulk_delete',
    'Hard-deletes many memory docs by id in one call — e.g. cleaning up a batch of abandoned docs found via memory_search. No tombstone. Returns per-id success/failure so one bad id doesn\'t abort the rest of the batch.',
    { ids: z.array(z.string()).min(1) },
    async ({ ids }) => {
      const results = repo.bulkDelete(ids);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  mcp.tool(
    'memory_save_session',
    `Saves a summary of the current chat session as a memory doc (doc_type "session-summary"). Pass a summary, not a raw transcript. If key or description are omitted, ask the user for them rather than guessing. ${AUTHORING_SKILL_HINT}`,
    {
      summary: z.string().describe('a scannable summary of the session, not a raw transcript'),
      key: z.string().optional(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      ...(multiFolder ? { folder: z.string().optional().describe(`which configured memory folder to write into: ${folderNames}`) } : {}),
    },
    async ({ summary, key, description, tags, folder }: any) => {
      if (!key || !description) {
        const missing = [!key && 'key', !description && 'description'].filter(Boolean).join(' and ');
        return {
          content: [
            {
              type: 'text',
              text: `Missing ${missing}. Ask the user what key (ticket id or free-form name) and description this session summary should be saved under, then call memory_save_session again.`,
            },
          ],
          isError: true,
        };
      }
      try {
        const doc = repo.create({
          key,
          key_type: /^[A-Z]+-\d+$/i.test(key) ? 'ticket' : 'freeform',
          doc_type: 'session-summary',
          description,
          body: summary,
          tags,
          folder,
        });
        return { content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );
}
