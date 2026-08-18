import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MemoryRepository } from './repository.js';

const MEMORY_DOC_TYPES = ['plan', 'spec', 'sql', 'testing-todo', 'discovery', 'session-summary', 'other'] as const;
const MEMORY_KEY_TYPES = ['ticket', 'freeform'] as const;
const MEMORY_STATUS = ['active', 'shipped', 'abandoned'] as const;
const AUTHORING_SKILL_HINT =
  "Before your first call in a session, run skill_get(\"memory-bucket-authoring\") to learn the exact frontmatter schema and conventions — don't guess the shape.";

export function registerMemoryTools(mcp: McpServer, repo: MemoryRepository): void {
  const roots = repo.listRoots();
  const multiRoot = roots.length > 1;
  const rootNames = roots.map((r) => r.name).join(', ');

  mcp.tool(
    'memory_get',
    'Exact-match lookup of memory docs (plan/spec/sql/etc.) by normalized key — a ticket ID or a free-form name like "Spot Chart Design". Returns every doc under that key, or only the matching doc_type if provided.',
    {
      key: z.string(),
      doc_type: z.enum(MEMORY_DOC_TYPES).optional(),
    },
    async ({ key, doc_type }) => {
      const docs = repo.getByKey(key, doc_type);
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
    'memory_create',
    `Writes a new memory doc (plan, spec, SQL, testing notes, discovery, etc.) into the memory root under the given key. ${AUTHORING_SKILL_HINT}`,
    {
      key: z.string().describe('lookup handle — ticket ID or free-form name; normalized on write'),
      key_type: z.enum(MEMORY_KEY_TYPES),
      doc_type: z.enum(MEMORY_DOC_TYPES),
      description: z.string().describe('distinguishes this doc from others sharing the same key'),
      body: z.string(),
      tags: z.array(z.string()).optional(),
      related_to: z.string().optional().describe('id of a related doc, e.g. a spec linking to its plan'),
      folder: z.string().optional().describe('optional subdirectory under the memory root'),
      ...(multiRoot ? { root: z.string().describe(`which configured memory root to write into: ${rootNames}`) } : {}),
    },
    async ({ key, key_type, doc_type, description, body, tags, related_to, folder, root }: any) => {
      try {
        const doc = repo.create({ key, key_type, doc_type, description, body, tags, related_to, folder, root });
        return { content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'memory_update',
    `Edits an existing memory doc in place — frontmatter fields and/or body. Only provided fields change. ${AUTHORING_SKILL_HINT}`,
    {
      id: z.string(),
      key: z.string().optional(),
      key_type: z.enum(MEMORY_KEY_TYPES).optional(),
      doc_type: z.enum(MEMORY_DOC_TYPES).optional(),
      description: z.string().optional(),
      body: z.string().optional(),
      tags: z.array(z.string()).optional(),
      status: z.enum(MEMORY_STATUS).optional(),
      related_to: z.string().optional(),
    },
    async ({ id, body, ...frontmatterFields }) => {
      try {
        const doc = repo.update(id, frontmatterFields, body);
        return { content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
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
    'memory_save_session',
    `Saves a summary of the current chat session as a memory doc (doc_type "session-summary"). Pass a summary, not a raw transcript. If key or description are omitted, ask the user for them rather than guessing. ${AUTHORING_SKILL_HINT}`,
    {
      summary: z.string().describe('a scannable summary of the session, not a raw transcript'),
      key: z.string().optional(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      ...(multiRoot ? { root: z.string().optional().describe(`which configured memory root to write into: ${rootNames}`) } : {}),
    },
    async ({ summary, key, description, tags, root }: any) => {
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
          root,
        });
        return { content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );
}
