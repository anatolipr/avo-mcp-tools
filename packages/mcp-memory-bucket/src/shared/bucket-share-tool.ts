import path from 'node:path';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BucketConfig } from '../config.js';
import type { SkillRepository } from '../skills/repository.js';
import type { MemoryRepository } from '../memory/repository.js';
import type { SkillFrontmatter, MemoryFrontmatter } from '../types.js';
import { readMarkdownFile } from '../store/markdown-file.js';
import { shareWithUser, unshareWithUser, type FolderfooRequestError } from '../remote/folderfoo-client.js';
import { resolveShareTarget, getSharedItem, listSharedItems } from '../remote/shared-items.js';

const KIND = z.enum(['skill', 'memory']);

/**
 * Item-level sharing for an agent session: share/unshare one of the caller's own docs directly
 * with another folderfoo user, and fork an already-accepted shared item into the caller's own
 * storage. Deliberately does NOT expose share-link/public-link creation here — those produce a
 * URL meant for a human to copy/paste/send, which has no useful shape for an agent to consume;
 * the web UI's detail-panel.ts "Share…" form covers that half already (Phase 4).
 */
export function registerBucketShareTools(
  mcp: McpServer,
  config: BucketConfig,
  skillRepo: SkillRepository,
  memoryRepo: MemoryRepository,
  db: Database.Database
): void {
  const repos = { skill: skillRepo, memory: memoryRepo };

  // Skills address by their frontmatter `name` (this project's real id — skill_get(name, folder)'s
  // own convention); memory docs address by filename resolved against `folder` (memoryRepo.get's
  // convention) — so this tool's addressing feels consistent with every other skill_*/memory_*
  // tool an agent already knows, rather than requiring the raw source_path resolveShareTarget
  // actually needs as its `id` param.
  function resolveTarget(kind: 'skill' | 'memory', folder: string | undefined, name: string) {
    if (kind === 'skill') {
      const row = db.prepare(`SELECT id FROM skills WHERE id = ? AND folder = ?`).get(name, folder ?? '') as { id: string } | undefined;
      if (!row) return null;
      return resolveShareTarget(db, repos, 'skills', row.id);
    }
    const filename = name.endsWith('.md') ? name : `${name}.md`;
    const candidates = db.prepare(`SELECT source_path FROM memory_docs WHERE folder = ?`).all(folder ?? '') as Array<{
      source_path: string;
    }>;
    const row = candidates.find((c) => path.basename(c.source_path) === filename);
    if (!row) return null;
    return resolveShareTarget(db, repos, 'memory_docs', row.source_path);
  }

  mcp.tool(
    'bucket_share_item',
    'Grants another folderfoo user direct access to one of YOUR OWN memory docs or skills — only works for a doc connected to a folderfoo remote folder (see bucket_list_folders\' `remote` flag); a purely local doc has nothing on folderfoo to share. `role` defaults to read-only (\'member\'); pass \'editor\' for read-write. Idempotent: re-sharing with the same username/role is a no-op on folderfoo\'s side.',
    {
      kind: KIND,
      name: z.string().describe('skill name, or memory doc filename (with or without .md)'),
      folder: z.string().optional().describe('which configured folder the doc lives in — required once more than one folder exists for this kind'),
      username: z.string().describe('the folderfoo username to share with'),
      role: z.enum(['member', 'editor']).optional().describe("'member' (read-only, default) or 'editor' (read-write)"),
    },
    async ({ kind, name, folder, username, role }) => {
      const target = resolveTarget(kind, folder, name);
      if (!target) {
        return {
          content: [{ type: 'text', text: `"${name}" not found, or not connected to a folderfoo remote folder — sharing requires a remote-backed doc.` }],
          isError: true,
        };
      }
      try {
        await shareWithUser(target.server, config.baseDir, target.tenantId, target.folderPath, target.name, username, target.kind, role ?? 'member');
        return { content: [{ type: 'text', text: `Shared "${name}" with ${username} (${role ?? 'member'}).` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as FolderfooRequestError).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'bucket_unshare_item',
    'Revokes a specific user\'s direct access to one of your own shared memory docs/skills, previously granted via bucket_share_item. No-op (not an error) if that user never had access.',
    {
      kind: KIND,
      name: z.string().describe('skill name, or memory doc filename (with or without .md)'),
      folder: z.string().optional().describe('which configured folder the doc lives in — required once more than one folder exists for this kind'),
      username: z.string().describe('the folderfoo username to revoke'),
    },
    async ({ kind, name, folder, username }) => {
      const target = resolveTarget(kind, folder, name);
      if (!target) {
        return {
          content: [{ type: 'text', text: `"${name}" not found, or not connected to a folderfoo remote folder.` }],
          isError: true,
        };
      }
      try {
        await unshareWithUser(target.server, config.baseDir, target.tenantId, target.folderPath, target.name, username);
        return { content: [{ type: 'text', text: `Revoked ${username}'s access to "${name}".` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as FolderfooRequestError).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'bucket_fork_shared_item',
    'Copies an item someone shared with you (see bucket_list_folders/memory_list/skill_list\'s shared entries, or the web UI\'s "Shared with me" panel — addressed here by origin_id) into a folder you own, as an independent, fully-writable doc. The fork has no ongoing link to the original — editing it never touches the sharer\'s copy, unlike editing a live \'editor\'-role share directly.',
    {
      origin_id: z.string().describe('the shared item\'s origin_id — from bucket_list_shared_items or the web UI'),
      folder: z.string().describe('which of YOUR OWN configured folders to copy it into (matching the item\'s kind — memory folder for a memory doc, skill folder for a skill)'),
    },
    async ({ origin_id, folder }) => {
      const item = getSharedItem(db, origin_id);
      if (!item) {
        return { content: [{ type: 'text', text: `no shared item found with origin_id "${origin_id}"` }], isError: true };
      }
      try {
        const parsed = readMarkdownFile<Record<string, unknown>>(item.mirror_path);
        if (item.kind === 'memory') {
          const fm = parsed.frontmatter as Partial<MemoryFrontmatter>;
          const filename = path.basename(item.mirror_path);
          const doc = await memoryRepo.create({
            filename,
            key: fm.key ?? path.basename(filename, '.md'),
            key_type: fm.key_type ?? 'freeform',
            doc_type: fm.doc_type ?? 'other',
            description: fm.description ?? path.basename(filename, '.md'),
            body: parsed.body,
            tags: fm.tags,
            status: fm.status,
            related_to: fm.related_to,
            folder,
          });
          return { content: [{ type: 'text', text: JSON.stringify({ forked: true, kind: 'memory', id: doc.source_path, folder }, null, 2) }] };
        }
        const fm = parsed.frontmatter as Partial<SkillFrontmatter>;
        if (!fm.name || !fm.description) {
          return { content: [{ type: 'text', text: 'shared skill is missing required name/description frontmatter' }], isError: true };
        }
        const doc = await skillRepo.create(
          { name: fm.name, description: fm.description, tags: fm.tags, trigger_phrases: fm.trigger_phrases },
          parsed.body,
          undefined,
          folder
        );
        return { content: [{ type: 'text', text: JSON.stringify({ forked: true, kind: 'skill', id: doc.name, folder }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'bucket_list_shared_items',
    'Lists memory docs/skills someone has shared directly with you, item by item — not a whole connected folder (see bucket_list_remote_folders for that). Each entry\'s `status` is \'active\' or \'revoked\' (no longer shared — see the web UI\'s dismiss action). Reflects whatever was last fetched via the web UI\'s explicit refresh button — refreshing is a UI-only action this tool does not trigger, so this may be stale if nobody has refreshed recently.',
    {},
    async () => {
      return { content: [{ type: 'text', text: JSON.stringify(listSharedItems(db), null, 2) }] };
    }
  );
}
