import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SkillRepository } from './repository.js';
import { statusSchema } from '../shared/status.js';
import { bodyEditsSchema, applyBodyEdits, formatBodyEditsDiff } from '../shared/body-edits.js';

const SKILL_STATUS_DEFAULTS = ['stable', 'beta', 'unreviewed'] as const;
const SKILL_NAME_DESCRIPTION =
  'stable id, must be 1-64 chars, lowercase letters/numbers/hyphens only, no leading/trailing/consecutive hyphens — this becomes the skill\'s folder name (agentskills.io spec requirement)';
const AUTHORING_SKILL_HINT =
  "Before your first call in a session, run skill_get(\"memory-bucket-authoring\") to learn the exact frontmatter schema and conventions — don't guess the shape.";

export function registerSkillTools(mcp: McpServer, repo: SkillRepository): void {
  const folders = repo.listFolders();
  const multiFolder = folders.length > 1;
  const folderNames = folders.map((f) => f.name).join(', ');

  mcp.tool(
    'skill_list',
    'Lists skills (reusable coding patterns, one SKILL.md per folder per the agentskills.io open standard), optionally filtered by a keyword matched against description/tags/trigger phrases. Paused skills are hidden by default — pass include_paused to see them.',
    multiFolder
      ? {
          query: z.string().optional(),
          folder: z.string().optional().describe(`filter to one folder: ${folderNames}`),
          include_paused: z.boolean().optional().describe('include paused skills, which are hidden by default (see skill_set_paused)'),
        }
      : {
          query: z.string().optional(),
          include_paused: z.boolean().optional().describe('include paused skills, which are hidden by default (see skill_set_paused)'),
        },
    async ({ query, folder, include_paused }: { query?: string; folder?: string; include_paused?: boolean }) => {
      const items = repo.list(query, folder, { includePaused: include_paused });
      return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
    }
  );

  mcp.tool(
    'skill_search',
    'Full-text search over skill description/body/tags (grep/find-like, ranked by relevance) — unlike skill_list\'s substring metadata filter, this searches the full markdown body. `query` is raw SQLite FTS5 MATCH syntax: bare words, "exact phrases", prefix* wildcards, AND/OR/NOT boolean operators; hyphenated/punctuated terms must be quoted, e.g. "blue-green". Can be combined with status/owner/tag filters. Returns ranked hits with a highlighted snippet, not the full body — call skill_get on a hit\'s name for that. Paused skills are hidden by default — pass include_paused to see them.',
    {
      query: z.string().describe('FTS5 match expression, e.g. `deploy AND rollback` or `"blue green"`'),
      status: statusSchema(SKILL_STATUS_DEFAULTS).optional(),
      owner: z.string().optional(),
      tag: z.string().optional(),
      limit: z.number().int().positive().max(100).optional(),
      offset: z.number().int().nonnegative().optional(),
      include_paused: z.boolean().optional().describe('include paused skills, which are hidden by default (see skill_set_paused)'),
      ...(multiFolder ? { folder: z.string().optional().describe(`filter to one folder: ${folderNames}`) } : {}),
    },
    async ({ query, status, owner, tag, limit, offset, folder, include_paused }: any) => {
      try {
        const hits = repo.search(query, { folder, status, owner, tag, limit, offset, includePaused: include_paused });
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
      status: statusSchema(SKILL_STATUS_DEFAULTS).optional(),
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
    `Creates a new skill as <folder>/[subfolder/]<name>/SKILL.md, per the agentskills.io open standard — a folder containing SKILL.md, optionally alongside scripts/references/assets subfolders you create separately on disk. ${AUTHORING_SKILL_HINT}`,
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
      status: statusSchema(SKILL_STATUS_DEFAULTS).optional().describe('defaults to "unreviewed"; stored in frontmatter.metadata'),
      tags: z.array(z.string()).optional(),
      trigger_phrases: z.array(z.string()).optional(),
      extends: z.string().optional().describe('reserved for a future overlay mechanism — stored in frontmatter.metadata'),
      subfolder: z.string().optional().describe('optional subdirectory under the skill folder, e.g. "frontend"'),
      ...(multiFolder ? { folder: z.string().describe(`which configured skill folder to write into: ${folderNames}`) } : {}),
    },
    async ({ name, description, body, license, compatibility, owner, status, tags, trigger_phrases, extends: extendsId, subfolder, folder }: any) => {
      try {
        const doc = repo.create(
          { name, description, license, compatibility, owner, status, tags, trigger_phrases, extends: extendsId },
          body,
          subfolder,
          folder
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
    status: statusSchema(SKILL_STATUS_DEFAULTS).optional(),
    tags: z.array(z.string()).optional(),
    trigger_phrases: z.array(z.string()).optional(),
    extends: z.string().optional(),
    subfolder: z.string().optional(),
    ...(multiFolder ? { folder: z.string().describe(`which configured skill folder to write into: ${folderNames}`) } : {}),
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
          subfolder: e.subfolder,
          folder: e.folder,
        }))
      );
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  mcp.tool(
    'skill_update',
    `Edits an existing skill in place — frontmatter fields and/or body. Only provided fields change. Use skill_rename to change the name/folder. For a body change smaller than the whole document, prefer body_edits over body: it patches via find/replace instead of requiring you to reproduce the entire body, which saves tokens and avoids accidentally dropping untouched content on a large skill. When body_edits is used, the response includes a \`diff\` field (compact -/+ per-edit summary) — show it to the user so they can see what changed, similar to a code diff view. The response never includes the full body (even on a full-body replacement) to avoid echoing back a potentially large doc — call skill_get(name) if you need the fresh full body. ${AUTHORING_SKILL_HINT}`,
    {
      name: z.string(),
      description: z.string().max(1024).optional(),
      body: z.string().optional().describe('full body replacement — omit in favor of body_edits when only part of the doc is changing'),
      body_edits: bodyEditsSchema.optional(),
      license: z.string().optional(),
      compatibility: z.string().max(500).optional(),
      owner: z.string().optional(),
      status: statusSchema(SKILL_STATUS_DEFAULTS).optional(),
      tags: z.array(z.string()).optional(),
      trigger_phrases: z.array(z.string()).optional(),
      extends: z.string().optional(),
      deprecated: z.boolean().optional().describe('marks the skill as deprecated (or un-deprecates when false) — independent of status'),
    },
    async ({ name, body, body_edits, ...frontmatterFields }) => {
      if (body !== undefined && body_edits !== undefined) {
        return { content: [{ type: 'text', text: 'Pass either body or body_edits, not both.' }], isError: true };
      }
      try {
        let diff: string | undefined;
        if (body_edits) {
          const existing = repo.get(name);
          if (!existing) throw new Error(`skill with name "${name}" not found`);
          const { body: patchedBody, applied } = applyBodyEdits(existing.body, body_edits);
          diff = formatBodyEditsDiff(applied);
          body = patchedBody;
        }
        const doc = repo.update(name, frontmatterFields, body);
        // Body is omitted from the response: the caller either just sent it (full replacement),
        // already has it, or has `diff` — echoing a potentially large body back is pure waste.
        // Fetch skill_get(name) if the fresh full body is actually needed.
        const { body: _omitted, ...docWithoutBody } = doc;
        const result = diff ? { ...docWithoutBody, diff } : docWithoutBody;
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
    'skill_bulk_rename',
    'Renames many skills at once — each entry is a {name, new_name} pair, same semantics as skill_rename (moves the folder, updates frontmatter `name`). Returns per-entry success/failure so one bad pair (unknown name, name collision) doesn\'t abort the rest of the batch.',
    {
      entries: z
        .array(z.object({ name: z.string().describe('current skill name'), new_name: z.string().describe(SKILL_NAME_DESCRIPTION) }))
        .min(1),
    },
    async ({ entries }: any) => {
      const results = repo.bulkRename(entries);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );

  mcp.tool(
    'skill_set_paused',
    'Pauses or resumes skills by name — a local-only toggle stored in this machine\'s SQLite cache, never written to SKILL.md, so it never touches the file on disk and never follows the skill to another machine\'s cache. Paused skills are hidden from skill_list/skill_search by default but stay fully intact and are still fetchable directly via skill_get/skill_bulk_get — use this to temporarily stop a skill from being surfaced during discovery without deprecating (retiring) it. Returns per-name success/failure so one bad name doesn\'t abort the batch.',
    {
      names: z.array(z.string()).min(1),
      paused: z.boolean().describe('true to pause (hide from skill_list/skill_search), false to resume'),
    },
    async ({ names, paused }) => {
      const results = repo.setPaused(names, paused);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
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
