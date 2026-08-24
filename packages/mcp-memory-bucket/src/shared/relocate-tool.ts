import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SkillRepository } from '../skills/repository.js';
import type { MemoryRepository } from '../memory/repository.js';
import { relocate, relocateMany } from './relocate.js';
import { statusSchema } from './status.js';

const AUTHORING_SKILL_HINT =
  "Before your first call in a session, run skill_get(\"memory-bucket-authoring\") to learn the exact frontmatter schema and conventions — don't guess the shape.";

const overridesSchema = z
  .object({
    name: z.string().optional().describe('skill target only: lowercase, hyphenated, <=64 chars — becomes the skill folder name'),
    description: z
      .string()
      .max(1024)
      .optional()
      .describe(
        'required for skill target (cannot be inferred from a filename — must state what the skill does and when to use it); optional for memory target where it distinguishes this doc from siblings under the same key'
      ),
    key: z.string().optional().describe('memory target only'),
    key_type: z.enum(['ticket', 'freeform']).optional().describe('memory target only'),
    doc_type: z.enum(['plan', 'spec', 'sql', 'testing-todo', 'discovery', 'session-summary', 'other']).optional().describe('memory target only'),
    tags: z.array(z.string()).optional(),
    status: statusSchema(['stable', 'beta', 'unreviewed', 'active', 'shipped', 'abandoned']).optional(),
    subfolder: z.string().optional().describe('optional subdirectory under the target folder'),
    folder: z.string().optional().describe('which configured folder to write into; required if multiple folders exist for the target type'),
  })
  .optional();

export function registerRelocateTool(mcp: McpServer, skillRepo: SkillRepository, memoryRepo: MemoryRepository): void {
  mcp.tool(
    'relocate',
    `Moves an existing local markdown file into the skill or memory source directory, converting it into a properly frontmattered doc. Default is a move (original deleted); pass keep_original to copy instead. On a weak/ambiguous filename match for memory docs, does nothing — no guess, no partial write; ask the user for an explicit key/description and retry with overrides. ${AUTHORING_SKILL_HINT}`,
    {
      path: z.string().describe('absolute or relative path to the local file to relocate'),
      target: z.enum(['skill', 'memory']),
      keep_original: z.boolean().optional().describe('if true, copies instead of moving (default: move)'),
      overrides: overridesSchema,
    },
    async (opts) => {
      const result = await relocate(opts, skillRepo, memoryRepo);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: !result.moved,
      };
    }
  );

  mcp.tool(
    'relocate_bulk',
    `Relocates many local files in one call — each entry is the same shape as relocate's args. Returns one result per path (in order); a weak/ambiguous filename match for one file does not block the rest of the batch. ${AUTHORING_SKILL_HINT}`,
    {
      entries: z
        .array(
          z.object({
            path: z.string().describe('absolute or relative path to the local file to relocate'),
            target: z.enum(['skill', 'memory']),
            keep_original: z.boolean().optional(),
            overrides: overridesSchema,
          })
        )
        .min(1),
    },
    async ({ entries }) => {
      const results = await relocateMany(entries, skillRepo, memoryRepo);
      return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
    }
  );
}
