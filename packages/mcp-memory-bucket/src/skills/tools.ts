import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SkillRepository } from './repository.js';

const SKILL_STATUS = ['stable', 'beta', 'unreviewed'] as const;
const SKILL_NAME_DESCRIPTION =
  'stable id, must be 1-64 chars, lowercase letters/numbers/hyphens only, no leading/trailing/consecutive hyphens — this becomes the skill\'s folder name (agentskills.io spec requirement)';
const AUTHORING_SKILL_HINT =
  "Before your first call in a session, run skill_get(\"memory-bucket-authoring\") to learn the exact frontmatter schema and conventions — don't guess the shape.";

export function registerSkillTools(mcp: McpServer, repo: SkillRepository): void {
  mcp.tool(
    'skill_list',
    'Lists skills (reusable coding patterns, one SKILL.md per folder per the agentskills.io open standard), optionally filtered by a keyword matched against description/tags/trigger phrases.',
    { query: z.string().optional() },
    async ({ query }) => {
      const items = repo.list(query);
      return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
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
    'skill_create',
    `Creates a new skill as <sourceDir>/[folder/]<name>/SKILL.md, per the agentskills.io open standard — a folder containing SKILL.md, optionally alongside scripts/references/assets subfolders you create separately on disk. ${AUTHORING_SKILL_HINT}`,
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
      folder: z.string().optional().describe('optional subdirectory under the skill source dir, e.g. "frontend"'),
    },
    async ({ name, description, body, license, compatibility, owner, status, tags, trigger_phrases, extends: extendsId, folder }) => {
      try {
        const doc = repo.create(
          { name, description, license, compatibility, owner, status, tags, trigger_phrases, extends: extendsId },
          body,
          folder
        );
        return { content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
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
}
