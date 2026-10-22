import fs from 'node:fs';
import path from 'node:path';
import { readMarkdownFile } from '../store/markdown-file.js';
import { walkFilesRecursive, guessMimeType } from '../attachments/storage.js';
import type { MemoryFrontmatter, SkillFrontmatter } from '../types.js';
import { TENANT_ID } from '../shared/folderfoo-tenant.js';
import {
  shareWithUser,
  unshareWithUser,
  listShareMembers,
  createShareLink,
  createPublicLink,
  listLinks,
  revokeLink,
  getShareLinkJoins,
  getChangedSince,
  fetchPublicLink,
  FolderfooRequestError,
  type ShareRole,
  type ShareMember,
  type LinkSummary,
  type LinkJoin,
} from './folderfoo-client.js';
import {
  resolveShareTarget,
  resolveFolderShareTarget,
  isSharedFolderName,
  addSharedItem,
  refreshSharedItems,
  getForkableSharedItem,
  sharedItemDocs,
  isSingleSkillFolder,
  type ShareTarget,
  type RefreshSummary,
} from './shared-items.js';
import { connectRemoteFolder, refreshSharedFolderRoles, repoFor, SharingError, type ConnectResult, type RemoteDeps } from './connect.js';
import { isFolderVisible } from './identity.js';

/**
 * Sharing, as one set of operations for both the web routes (routes.ts) and the bucket_share_*
 * MCP tools (bucket-share-tool.ts) — so the two can never drift apart. Every function throws a
 * SharingError (carrying an HTTP status) or a folderfoo client error on failure.
 */

/**
 * What to share: one doc, or one of the caller's connected folders as a whole.
 * - kind 'skill': `id` is the skill name (`folder` disambiguates a name in several folders).
 * - kind 'memory': `id` is the doc's source_path, or its filename (with `folder` when ambiguous).
 * - kind 'skill_folder' / 'memory_folder': `id` is the configured folder's name.
 */
export interface ShareSubject {
  kind: 'skill' | 'memory' | 'skill_folder' | 'memory_folder';
  id: string;
  folder?: string;
}

const repos = (deps: RemoteDeps) => ({ skill: deps.skillRepo, memory: deps.memoryRepo });

export function resolveSubject(deps: RemoteDeps, subject: ShareSubject): ShareTarget {
  let target: ShareTarget | { error: string };
  if (subject.kind === 'skill_folder' || subject.kind === 'memory_folder') {
    target = resolveFolderShareTarget(repos(deps), subject.kind === 'skill_folder' ? 'skill' : 'memory', subject.id);
  } else if (subject.kind === 'skill') {
    target = resolveShareTarget(deps.db, repos(deps), 'skills', subject.id, subject.folder);
  } else {
    target = resolveShareTarget(deps.db, repos(deps), 'memory_docs', memorySourcePath(deps, subject.id, subject.folder), subject.folder);
  }
  if ('error' in target) throw new SharingError(`"${subject.id}": ${target.error}`, target.error === 'not found' ? 404 : 400);
  return target;
}

/** A memory doc's source_path from either the path itself or its filename (unique, or narrowed by `folder`). */
function memorySourcePath(deps: RemoteDeps, id: string, folder?: string): string {
  if (path.isAbsolute(id)) return id;
  const filename = id.endsWith('.md') ? id : `${id}.md`;
  const rows = (
    folder !== undefined
      ? deps.db.prepare(`SELECT source_path, folder FROM memory_docs WHERE folder = ?`).all(folder)
      : deps.db.prepare(`SELECT source_path, folder FROM memory_docs`).all()
  ) as Array<{ source_path: string; folder: string }>;
  const matches = rows.filter((row) => path.basename(row.source_path) === filename && !isSharedFolderName(row.folder));
  if (matches.length > 1) throw new SharingError(`"${id}" exists in more than one folder (${matches.map((m) => m.folder).join(', ')}) — specify folder`, 400);
  return matches[0]?.source_path ?? id;
}

export async function shareWith(deps: RemoteDeps, subject: ShareSubject, username: string, role: ShareRole = 'member'): Promise<ShareTarget> {
  const target = resolveSubject(deps, subject);
  await shareWithUser(target.server, deps.config.baseDir, target.tenantId, target, username, target.kind, role);
  return target;
}

/** Revokes one user's direct access. For a skill this also clears a share made before skills were shared as folders (its SKILL file). */
export async function unshareWith(deps: RemoteDeps, subject: ShareSubject, username: string): Promise<void> {
  const target = resolveSubject(deps, subject);
  await unshareWithUser(target.server, deps.config.baseDir, target.tenantId, target, username);
  if (subject.kind === 'skill') {
    await unshareWithUser(target.server, deps.config.baseDir, target.tenantId, { path: `${target.path}/SKILL`, type: 'file' }, username).catch(() => undefined);
  }
}

export interface CreatedShareLink {
  id: string;
  url: string;
  expiresAt: string;
  role: ShareRole;
  type: 'invite' | 'public';
}

/**
 * Creates an invite link (login required, grants `role`) or a public link (no login, read-only) and
 * returns the URL to send — it lands on this app's web UI, whose share-accept flow redeems it.
 */
export async function createLink(deps: RemoteDeps, subject: ShareSubject, type: 'invite' | 'public', role: ShareRole = 'member'): Promise<CreatedShareLink> {
  const target = resolveSubject(deps, subject);
  const { baseDir } = deps.config;
  const link =
    type === 'invite'
      ? await createShareLink(target.server, baseDir, target.tenantId, target, target.kind, role)
      : await createPublicLink(target.server, baseDir, target.tenantId, target, target.kind);
  const url = new URL(deps.appUrl);
  url.searchParams.set(type === 'invite' ? 'shareToken' : 'publicToken', link.token);
  return { id: link.id, url: url.toString(), expiresAt: link.expiresAt, role: type === 'invite' ? role : 'member', type };
}

export interface ShareStatus {
  path: string;
  type: 'file' | 'folder';
  members: ShareMember[];
  links: LinkSummary[];
}

/** Who has direct access and which links exist (with who joined through each) — the owner's view of one shared thing. */
export async function shareStatus(deps: RemoteDeps, subject: ShareSubject): Promise<ShareStatus> {
  const target = resolveSubject(deps, subject);
  const { baseDir } = deps.config;
  const [members, links] = await Promise.all([
    listShareMembers(target.server, baseDir, target.tenantId, target),
    listLinks(target.server, baseDir, target.tenantId, target),
  ]);
  if (subject.kind === 'skill') {
    const legacy = await listShareMembers(target.server, baseDir, target.tenantId, { path: `${target.path}/SKILL`, type: 'file' }).catch(() => []);
    for (const member of legacy) if (!members.some((m) => m.username === member.username)) members.push(member);
  }
  return { path: target.path, type: target.type, members, links };
}

export async function revokeShareLink(deps: RemoteDeps, subject: ShareSubject, type: 'invite' | 'public', linkId: string): Promise<void> {
  const target = resolveSubject(deps, subject);
  await revokeLink(target.server, deps.config.baseDir, target.tenantId, type, linkId);
}

/** Every server+tenant this login can have shares on: its visible remote folders' plus the configured host under this app's tenant. */
function shareServers(deps: RemoteDeps): Array<{ server: string; tenantId: string }> {
  const current = deps.identity.current();
  const servers = [...deps.skillRepo.listRemoteFolders(), ...deps.memoryRepo.listRemoteFolders()]
    .filter((f) => isFolderVisible(f, current))
    .map((f) => ({ server: f.server, tenantId: f.tenantId }));
  if (deps.config.folderfooHost) servers.push({ server: deps.config.folderfooHost, tenantId: TENANT_ID });
  return servers.filter((s, i) => servers.findIndex((o) => o.server === s.server && o.tenantId === s.tenantId) === i);
}

/** Brings "Shared with me" and connected shared folders' roles up to date. */
export async function refreshShares(deps: RemoteDeps): Promise<RefreshSummary> {
  const current = deps.identity.current();
  const connected = [...deps.skillRepo.listRemoteFolders(), ...deps.memoryRepo.listRemoteFolders()].filter((f) => f.owner && isFolderVisible(f, current));
  const summary = await refreshSharedItems(deps.db, deps.config.baseDir, deps.skillSpec, deps.memorySpec, shareServers(deps), current.username, (server, tenantId, owner, folderPath) =>
    connected.some((f) => f.server === server && f.tenantId === tenantId && f.owner === owner && f.folderPath === folderPath)
  );
  await refreshSharedFolderRoles(deps);
  if (summary.authExpired) deps.identity.clearUsername();
  return summary;
}

/** Who joined through any of this login's invite links since the last call (marks them seen). */
export async function shareLinkJoins(deps: RemoteDeps): Promise<LinkJoin[]> {
  if (!deps.identity.current().username) return [];
  const joins: LinkJoin[] = [];
  for (const { server, tenantId } of shareServers(deps)) {
    joins.push(...(await getShareLinkJoins(server, deps.config.baseDir, tenantId).catch(() => [])));
  }
  return joins;
}

/** A redeemed invite link or a followed public link, as share-accept.ts reports it. */
export interface AcceptedShare {
  owner: string;
  path: string;
  type: 'file' | 'folder';
  originId?: string | null;
  kind?: 'memory' | 'skill' | null;
  role?: ShareRole | null;
  server: string;
  tenantId: string;
  publicToken?: string;
}

export type AcceptResult = { accepted: string; itemType: 'file' | 'folder' } | { connected: ConnectResult };

/**
 * Files an accepted share where it belongs:
 *  - a file → a shared item (needs a memory/skill `kind`);
 *  - a folder holding one skill → a shared item mirrored whole (siblings and attachments included);
 *  - any other folder → through an invite, connected as a live remote source (writable when the
 *    link granted 'editor'); through a public link, a read-only shared item mirroring every doc.
 * A folder with no `kind` is classified by content (any SKILL file means skills).
 */
export async function acceptShare(deps: RemoteDeps, share: AcceptedShare): Promise<AcceptResult> {
  const { config, identity } = deps;
  if (!config.folderfooHost || share.server !== config.folderfooHost) {
    throw new SharingError("server must be this app's configured folderfoo host", 400);
  }
  const username = identity.current().username;
  if (!share.publicToken && !username) throw new SharingError('not logged in to folderfoo', 401);
  if (!share.originId) throw new SharingError('this link was not created for a shared item', 400);
  const role: ShareRole = share.role === 'editor' ? 'editor' : 'member';
  const base = { owner: share.owner, server: share.server, tenantId: share.tenantId, path: share.path, originId: share.originId, role, username, publicToken: share.publicToken };

  if (share.type === 'file') {
    if (!share.kind) throw new SharingError('this file is not a memory doc or skill', 400);
    await addSharedItem(deps.db, config.baseDir, deps.skillSpec, deps.memorySpec, { ...base, kind: share.kind, itemType: 'file' });
    return { accepted: share.originId, itemType: 'file' };
  }

  // Folder: what it holds, from the public listing or the owner's (shared) tree.
  const files = share.publicToken
    ? ((await fetchPublicLink(share.server, share.publicToken)).files ?? []).map((f) => ({ ...f, folderPath: f.folderPath ? `${share.path}/${f.folderPath}` : share.path }))
    : await getChangedSince(share.server, config.baseDir, share.tenantId, share.path, 0, share.owner);
  const kind = share.kind ?? (files.some((f) => f.name === 'SKILL') ? 'skill' : 'memory');
  const singleSkill = kind === 'skill' && files.some((f) => f.folderPath === share.path && f.name === 'SKILL');

  if (share.publicToken || singleSkill) {
    await addSharedItem(deps.db, config.baseDir, deps.skillSpec, deps.memorySpec, { ...base, kind, itemType: 'folder' });
    return { accepted: share.originId, itemType: 'folder' };
  }
  return { connected: await connectRemoteFolder(deps, { kind, server: share.server, tenantId: share.tenantId, folderPath: share.path, owner: share.owner }) };
}

export { isSingleSkillFolder };

/**
 * "Fork to mine" — writes an INDEPENDENT copy of a shared item into a folder the caller owns, via
 * the same create path any new doc goes through. Everything comes along: a skill's siblings and
 * attachments, a memory doc's attachments, every doc of a folder item. The copy carries no link to
 * the original — editing it never touches the owner's copy, unlike a live 'editor' share.
 */
export async function forkSharedItem(
  deps: RemoteDeps,
  originId: string,
  folder: string | undefined
): Promise<{ forked: true; kind: 'memory' | 'skill'; ids: string[] }> {
  const item = getForkableSharedItem(deps.db, originId, deps.identity.current().username);
  if ('error' in item) throw new SharingError(item.error, 404);
  const ids: string[] = [];
  for (const docPath of sharedItemDocs(item)) {
    ids.push(item.kind === 'memory' ? await forkMemoryDoc(deps, docPath, folder) : await forkSkill(deps, docPath, folder));
  }
  return { forked: true, kind: item.kind, ids };
}

async function forkMemoryDoc(deps: RemoteDeps, docPath: string, folder: string | undefined): Promise<string> {
  const parsed = readMarkdownFile<Partial<MemoryFrontmatter>>(docPath);
  const fm = parsed.frontmatter;
  const stem = path.basename(docPath, '.md');
  const doc = await deps.memoryRepo.create({
    filename: path.basename(docPath),
    key: fm.key ?? stem,
    key_type: fm.key_type ?? 'freeform',
    doc_type: fm.doc_type ?? 'other',
    description: fm.description ?? stem,
    body: parsed.body,
    tags: fm.tags,
    status: fm.status,
    related_to: fm.related_to,
    folder,
  });
  // The doc's attachments: copied beside the new doc (pushed first when its folder is remote), then
  // declared in its frontmatter the way the original had them.
  const attachmentsDir = path.join(path.dirname(docPath), stem, 'attachments');
  if (fs.existsSync(attachmentsDir) && fm.attachments?.length) {
    const newDir = path.join(path.dirname(doc.source_path), path.basename(doc.source_path, '.md'), 'attachments');
    for (const rel of walkFilesRecursive(attachmentsDir)) {
      const data = fs.readFileSync(path.join(attachmentsDir, rel));
      const dest = path.join(newDir, rel);
      await deps.memoryRepo.pushAttachmentIfNeeded(doc.folder, dest, data, guessMimeType(rel));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
    }
    await deps.memoryRepo.update(doc.folder, path.basename(doc.source_path), { attachments: fm.attachments });
  }
  return doc.source_path;
}

async function forkSkill(deps: RemoteDeps, skillPath: string, folder: string | undefined): Promise<string> {
  const parsed = readMarkdownFile<Partial<SkillFrontmatter>>(skillPath);
  const fm = parsed.frontmatter;
  if (!fm.name || !fm.description) throw new SharingError('shared skill is missing required name/description frontmatter', 500);
  const doc = await deps.skillRepo.create({ name: fm.name, description: fm.description, tags: fm.tags, trigger_phrases: fm.trigger_phrases }, parsed.body, undefined, folder);
  // Siblings (references/, scripts/, ...) and attachments/: copied into the new skill's directory
  // and pushed one by one when that folder is remote.
  const sourceDir = path.dirname(skillPath);
  const newDir = path.dirname(doc.source_path);
  for (const rel of walkFilesRecursive(sourceDir)) {
    if (rel === 'SKILL.md') continue;
    const data = fs.readFileSync(path.join(sourceDir, rel));
    const dest = path.join(newDir, rel);
    await deps.skillRepo.pushSkillSiblingFileIfNeeded(doc.folder, dest, data);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
  if (fm.attachments?.length) await deps.skillRepo.update(doc.name, { attachments: fm.attachments }, undefined, undefined, doc.folder);
  return doc.name;
}

/** Re-exported so callers deal with one module. */
export { SharingError, connectRemoteFolder, repoFor, FolderfooRequestError };
export type { RemoteDeps, ConnectResult };
