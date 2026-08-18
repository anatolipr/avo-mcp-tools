import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SkillRepository } from './repository.js';

const SKILL_STATUS = ['stable', 'beta', 'unreviewed'] as const;
const SKILL_NAME_DESCRIPTION =
  'stable id, must be 1-64 chars, lowercase letters/numbers/hyphens only, no leading/trailing/consecutive hyphens — this becomes the skill\'s folder name (agentskills.io spec requirement)';
const AUTHORING_SKILL_HINT =
  "Before your first call in a session, run skill_get(\"memory-bucket-authoring\") to learn the exact frontmatter schema and conventions — don't guess the shape.";

export function registerSkillTools(mcp: McpServer, repo: SkillRepository): void {
  const roots = repo.listRoots();
  const multiRoot = roots.length > 1;
  const rootNames = roots.map((r) => r.name).join(', ');

  mcp.tool(
    'skill_list',
    'Lists skills (reusable coding patterns, one SKILL.md per folder per the agentskills.io open standard), optionally filtered by a keyword matched against description/tags/trigger phrases.',
    multiRoot
      ? { query: z.string().optional(), root: z.string().optional().describe(`filter to one root: ${rootNames}`) }
      : { query: z.string().optional() },
    async ({ query, root }: { query?: string; root?: string }) => {
      const items = repo.list(query, root);
      return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
    }
  );

  mcp.tool(
    'skill_search',
    'Full-text search over skill description/body/tags (grep/find-like, ranked by relevance) — unlike skill_list\'s substring metadata filter, this searches the full markdown body. `query` is raw SQLite FTS5 MATCH syntax: bare words, "exact phrases", prefix* wildcards, AND/OR/NOT boolean operators; hyphenated/punctuated terms must be quoted, e.g. "blue-green". Can be combined with status/owner/tag filters. Returns ranked hits with a highlighted snippet, not the full body — call skill_get on a hit\'s name for that.',
    {
      query: z.string().describe('FTS5 match expression, e.g. `deploy AND rollback` or `"blue green"`'),
      status: z.enum(SKILL_STATUS).optional(),
      owner: z.string().optional(),
      tag: z.string().optional(),
      limit: z.number().int().positive().max(100).optional(),
      offset: z.number().int().nonnegative().optional(),
      ...(multiRoot ? { root: z.string().optional().describe(`filter to one root: ${rootNames}`) } : {}),
    },
    async ({ query, status, owner, tag, limit, offset, root }: any) => {
      try {
        const hits = repo.search(query, { root, status, owner, tag, limit, offset });
        return { content: [{ type: 'text', text: JSON.stringify(hits, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'skill_bulk_update',
    'Applies the same frontmatter change to many skills at once by name — e.g. add/remove a tag across a batch found via skill_search, or flip status for a group. add_tags/remove_tags merge or subtract per-skill; owner/status/extends overwrite uniformly when provided. Body is never touched. Returns per-name success/failure so one bad name doesn\'t abort the batch.',
    {
      names: z.array(z.string()).min(1),
      add_tags: z.array(z.string()).optional(),
      remove_tags: z.array(z.string()).optional(),
      owner: z.string().nullable().optional(),
      status: z.enum(SKILL_STATUS).optional(),
      extends: z.string().nullable().optional(),
      deprecated: z.boolean().optional().describe('marks skills as deprecated (or un-deprecates when false) — independent of status'),
    },
    async ({ names, add_tags, remove_tags, owner, status, extends: extendsId, deprecated }: any) => {
      const results = repo.bulkUpdate(names, { add_tags, remove_tags, owner, status, extends: extendsId, deprecated });
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  mcp.tool(
    'skill_get',
    'Fetches a single skill by name, including its full markdown body.',
    { name: z.string() },
    async ({ name }) => {
      const doc = repo.get(name);
      if (!doc) {
        return { content: [{ type: 'text', text: `No skill found with name "${name}"` }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }] };
    }
  );

  mcp.tool(
    'skill_bulk_get',
    'Fetches many skills by name in one call, including full markdown bodies — e.g. hydrating a batch of skill_search hits. Missing names are simply omitted from the result, not errors.',
    { names: z.array(z.string()).min(1) },
    async ({ names }) => {
      const docs = repo.bulkGet(names);
      return { content: [{ type: 'text', text: JSON.stringify(docs, null, 2) }] };
    }
  );

  mcp.tool(
    'skill_create',
    `Creates a new skill as <root>/[folder/]<name>/SKILL.md, per the agentskills.io open standard — a folder containing SKILL.md, optionally alongside scripts/references/assets subfolders you create separately on disk. ${AUTHORING_SKILL_HINT}`,
    {
      name: z.string().describe(SKILL_NAME_DESCRIPTION),
      description: z
        .string()
        .max(1024)
        .describe('required by spec: what the skill does AND when to use it — this is what agents scan to decide relevance, so be specific'),
      body: z.string().describe('markdown body of SKILL.md — the instructions, loaded only once the skill is activated'),
      license: z.string().optional(),
      compatibility: z.string().max(500).optional().describe('only needed if the skill has specific environment requirements'),
      owner: z.string().optional().describe('squad or "company" — stored in frontmatter.metadata, unused for resolution in V0'),
      status: z.enum(SKILL_STATUS).optional().describe('defaults to "unreviewed"; stored in frontmatter.metadata'),
      tags: z.array(z.string()).optional(),
      trigger_phrases: z.array(z.string()).optional(),
      extends: z.string().optional().describe('reserved for a future overlay mechanism — stored in frontmatter.metadata'),
      folder: z.string().optional().describe('optional subdirectory under the skill root, e.g. "frontend"'),
      ...(multiRoot ? { root: z.string().describe(`which configured skill root to write into: ${rootNames}`) } : {}),
    },
    async ({ name, description, body, license, compatibility, owner, status, tags, trigger_phrases, extends: extendsId, folder, root }: any) => {
      try {
        const doc = repo.create(
          { name, description, license, compatibility, owner, status, tags, trigger_phrases, extends: extendsId },
          body,
          folder,
          root
        );
        return { content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  const skillEntrySchema = z.object({
    name: z.string().describe(SKILL_NAME_DESCRIPTION),
    description: z.string().max(1024).describe('required by spec: what the skill does AND when to use it'),
    body: z.string().describe('markdown body of SKILL.md'),
    license: z.string().optional(),
    compatibility: z.string().max(500).optional(),
    owner: z.string().optional(),
    status: z.enum(SKILL_STATUS).optional(),
    tags: z.array(z.string()).optional(),
    trigger_phrases: z.array(z.string()).optional(),
    extends: z.string().optional(),
    folder: z.string().optional(),
    ...(multiRoot ? { root: z.string().describe(`which configured skill root to write into: ${rootNames}`) } : {}),
  });

  mcp.tool(
    'skill_bulk_create',
    `Creates many skills in one call — each entry is the same shape as skill_create's args. Returns per-name success/failure so one bad entry (duplicate name, invalid name, existing directory) doesn't abort the rest of the batch. ${AUTHORING_SKILL_HINT}`,
    { entries: z.array(skillEntrySchema).min(1) },
    async ({ entries }: any) => {
      const results = repo.bulkCreate(
        entries.map((e: any) => ({
          frontmatter: {
            name: e.name,
            description: e.description,
            license: e.license,
            compatibility: e.compatibility,
            owner: e.owner,
            status: e.status,
            tags: e.tags,
            trigger_phrases: e.trigger_phrases,
            extends: e.extends,
          },
          body: e.body,
          folder: e.folder,
          root: e.root,
        }))
      );
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  mcp.tool(
    'skill_update',
    `Edits an existing skill in place — frontmatter fields and/or body. Only provided fields change. Use skill_rename to change the name/folder. ${AUTHORING_SKILL_HINT}`,
    {
      name: z.string(),
      description: z.string().max(1024).optional(),
      body: z.string().optional(),
      license: z.string().optional(),
      compatibility: z.string().max(500).optional(),
      owner: z.string().optional(),
      status: z.enum(SKILL_STATUS).optional(),
      tags: z.array(z.string()).optional(),
      trigger_phrases: z.array(z.string()).optional(),
      extends: z.string().optional(),
      deprecated: z.boolean().optional().describe('marks the skill as deprecated (or un-deprecates when false) — independent of status'),
    },
    async ({ name, body, ...frontmatterFields }) => {
      try {
        const doc = repo.update(name, frontmatterFields, body);
        return { content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'skill_rename',
    'Renames a skill: moves its folder to the new name and updates the frontmatter `name` field to match, preserving any scripts/references/assets alongside SKILL.md.',
    {
      name: z.string().describe('current skill name'),
      new_name: z.string().describe(SKILL_NAME_DESCRIPTION),
    },
    async ({ name, new_name }) => {
      try {
        const doc = repo.rename(name, new_name);
        return { content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'skill_delete',
    'Hard-deletes a skill by name — removes the whole skill folder (SKILL.md plus any scripts/references/assets), no tombstone.',
    { name: z.string() },
    async ({ name }) => {
      try {
        repo.delete(name);
        return { content: [{ type: 'text', text: `Deleted skill "${name}"` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'skill_bulk_delete',
    'Hard-deletes many skills by name in one call — e.g. cleaning up a batch found via skill_search/skill_list. No tombstone. Returns per-name success/failure so one bad name doesn\'t abort the rest of the batch.',
    { names: z.array(z.string()).min(1) },
    async ({ names }) => {
      const results = repo.bulkDelete(names);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );
}
