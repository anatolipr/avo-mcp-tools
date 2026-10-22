import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listSharedItems, leaveSharedItem } from '../remote/shared-items.js';
import { shareWith, unshareWith, createLink, shareStatus, revokeShareLink, refreshShares, forkSharedItem, type ShareSubject } from '../remote/sharing.js';
import type { RemoteDeps } from '../remote/connect.js';

const SUBJECT = {
  kind: z
    .enum(['skill', 'memory', 'skill_folder', 'memory_folder'])
    .describe('skill/memory = one doc; skill_folder/memory_folder = one of your connected folders as a whole'),
  name: z.string().describe('skill name, memory doc filename, or folder name'),
  folder: z.string().optional().describe('only needed when a doc name exists in more than one folder'),
};

const subjectOf = ({ kind, name, folder }: { kind: ShareSubject['kind']; name: string; folder?: string }): ShareSubject => ({ kind, id: name, folder });

const ok = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const fail = (err: unknown) => ({ content: [{ type: 'text' as const, text: (err as Error).message }], isError: true });

/**
 * Sharing for an agent session — the same operations the web UI's share form and "Shared with me"
 * panel use (see remote/sharing.ts). Only docs/folders connected to the caller's OWN folderfoo
 * remote folders can be shared.
 */
export function registerBucketShareTools(mcp: McpServer, deps: RemoteDeps): void {
  mcp.tool(
    'bucket_share_item',
    "Shares one of YOUR OWN folderfoo-backed docs or connected folders (bucket_list_folders' `remote` flag). Pass `username` to grant that folderfoo user access directly, or `link` to get a URL to send instead: 'invite' (recipient logs in; grants `role`) or 'public' (no login, read-only). A skill is shared with its whole directory (siblings, attachments); a memory doc with its attachments. `role` 'member' is read-only (default), 'editor' lets the recipient edit in place.",
    {
      ...SUBJECT,
      username: z.string().optional(),
      link: z.enum(['invite', 'public']).optional(),
      role: z.enum(['member', 'editor']).optional(),
    },
    async ({ username, link, role, ...subject }) => {
      if (!username === !link) return fail(new Error('pass exactly one of username or link'));
      try {
        if (link) return ok(await createLink(deps, subjectOf(subject), link, role));
        await shareWith(deps, subjectOf(subject), username!, role);
        return ok(`Shared "${subject.name}" with ${username} (${role ?? 'member'}).`);
      } catch (err) {
        return fail(err);
      }
    }
  );

  mcp.tool(
    'bucket_unshare_item',
    "Revokes access to something you shared: `username` removes that user; `link_id` (from bucket_share_status) revokes a link so nobody new can use it — people who already joined through it keep access until removed by username.",
    {
      ...SUBJECT,
      username: z.string().optional(),
      link_id: z.string().optional(),
      link_type: z.enum(['invite', 'public']).optional().describe("the link's type; default 'invite'"),
    },
    async ({ username, link_id, link_type, ...subject }) => {
      if (!username === !link_id) return fail(new Error('pass exactly one of username or link_id'));
      try {
        if (link_id) {
          await revokeShareLink(deps, subjectOf(subject), link_type ?? 'invite', link_id);
          return ok(`Revoked link ${link_id}.`);
        }
        await unshareWith(deps, subjectOf(subject), username!);
        return ok(`Revoked ${username}'s access to "${subject.name}".`);
      } catch (err) {
        return fail(err);
      }
    }
  );

  mcp.tool(
    'bucket_share_status',
    'Who has access to something you shared (users and roles) and its links (id, type, role, expiry, revoked, who joined, view count).',
    SUBJECT,
    async (subject) => {
      try {
        return ok(await shareStatus(deps, subjectOf(subject)));
      } catch (err) {
        return fail(err);
      }
    }
  );

  mcp.tool(
    'bucket_list_shared_items',
    "Lists docs/skills others shared with you item by item (folders shared whole are connected as sources instead). Read one with skill_get/memory_get using its `folder`; role 'editor' items are editable in place, others read-only. `paused: true` = a direct share not yet accepted — hidden from list/search until unpaused. `refresh: true` first syncs with folderfoo (discovers new shares, revocations, edits).",
    { refresh: z.boolean().optional() },
    async ({ refresh }) => {
      try {
        const summary = refresh ? await refreshShares(deps) : undefined;
        return ok({ ...(summary ? { refresh: summary } : {}), items: listSharedItems(deps.db, deps.identity.current().username) });
      } catch (err) {
        return fail(err);
      }
    }
  );

  mcp.tool(
    'bucket_fork_shared_item',
    'Copies a shared item (origin_id from bucket_list_shared_items) into one of your own folders of the matching kind, with its attachments and skill files, as an independent doc no longer linked to the original.',
    { origin_id: z.string(), folder: z.string() },
    async ({ origin_id, folder }) => {
      try {
        return ok(await forkSharedItem(deps, origin_id, folder));
      } catch (err) {
        return fail(err);
      }
    }
  );

  mcp.tool(
    'bucket_leave_shared_item',
    'Removes yourself from an item shared with you (origin_id from bucket_list_shared_items) and deletes its local copy. Fork it first to keep a copy.',
    { origin_id: z.string() },
    async ({ origin_id }) => {
      try {
        const result = await leaveSharedItem(deps.db, deps.config.baseDir, origin_id, deps.identity.current().username);
        return 'error' in result ? fail(new Error(result.error)) : ok(`Left shared item ${origin_id}.`);
      } catch (err) {
        return fail(err);
      }
    }
  );
}
