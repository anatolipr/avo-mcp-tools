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
  createPublicPage,
  listPublicPages,
  updatePublicPage,
  revokePublicPage,
  type PublicPage,
  type PublicPageItem,
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
  /** The link to send. A public link opens folderfoo's viewer, readable by anyone with no account or app. */
  url: string;
  /** Public links only: the same link opened in a Memory Bucket, which files it as a shared item. */
  bucketUrl?: string;
  /** Public links only: the whole share as one file — a skill directory or a doc with attachments as a .zip. */
  downloadUrl?: string;
  expiresAt: string;
  role: ShareRole;
  type: 'invite' | 'public';
}

/**
 * Creates an invite link (login required, grants `role`) or a public link (no login, read-only) and
 * returns the URL to send. An invite lands on this app's web UI, whose share-accept flow redeems it.
 * A public link lands on folderfoo's own viewer page (/p/<token>), so anyone can read it in a
 * browser without an account or a Memory Bucket; `bucketUrl` is the same link for bucket users.
 */
export async function createLink(deps: RemoteDeps, subject: ShareSubject, type: 'invite' | 'public', role: ShareRole = 'member'): Promise<CreatedShareLink> {
  const target = resolveSubject(deps, subject);
  const { baseDir } = deps.config;
  const link =
    type === 'invite'
      ? await createShareLink(target.server, baseDir, target.tenantId, target, target.kind, role)
      : await createPublicLink(target.server, baseDir, target.tenantId, target, target.kind);
  const appLink = new URL(deps.appUrl);
  appLink.searchParams.set(type === 'invite' ? 'shareToken' : 'publicToken', link.token);
  if (type === 'invite') return { id: link.id, url: appLink.toString(), expiresAt: link.expiresAt, role, type };
  const token = encodeURIComponent(link.token);
  return {
    id: link.id,
    url: `${target.server}/p/${token}`,
    bucketUrl: appLink.toString(),
    downloadUrl: `${target.server}/public/${token}/download`,
    expiresAt: link.expiresAt,
    role: 'member',
    type,
  };
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

// --- Public pages: one no-login link (folderfoo's /b/<token>) where anyone can browse and
// download a set of the owner's docs, skills, and folders. Pages live on this app's configured
// folderfoo host under its own tenant, like the remote folders that hold the items.

export interface PageView {
  id: string;
  title: string;
  /** The page's link (null once revoked) — a file browser anyone can open. */
  url: string | null;
  /** Everything on the page as one .zip. */
  downloadUrl: string | null;
  items: PublicPageItem[];
  expiresAt: string;
  revoked: boolean;
  viewCount: number;
}

function pageHost(deps: RemoteDeps): { server: string; tenantId: string } {
  if (!deps.config.folderfooHost) throw new SharingError('folderfoo integration is off — restart with --folderfoo-mode dev|cloud', 400);
  if (!deps.identity.current().username) throw new SharingError('not logged in to folderfoo — open the web UI (bucket_open_ui) and log in first', 401);
  return { server: deps.config.folderfooHost, tenantId: TENANT_ID };
}

function pageView(server: string, page: PublicPage): PageView {
  const token = page.token ? encodeURIComponent(page.token) : null;
  return {
    id: page.id,
    title: page.title,
    url: token ? `${server}/b/${token}` : null,
    downloadUrl: token ? `${server}/public-page/${token}/download` : null,
    items: page.items,
    expiresAt: page.expiresAt,
    revoked: page.revoked,
    viewCount: page.viewCount,
  };
}

/** A subject as a page item — it must live on the same folderfoo host/tenant pages are kept on. */
function pageItemFor(deps: RemoteDeps, host: { server: string; tenantId: string }, subject: ShareSubject): PublicPageItem {
  const target = resolveSubject(deps, subject);
  if (target.server !== host.server || target.tenantId !== host.tenantId) {
    throw new SharingError(`"${subject.id}" lives on a different folderfoo deployment than this app's — it can't go on a public page`, 400);
  }
  return { path: target.path, type: target.type, kind: target.kind };
}

const sameItem = (a: PublicPageItem, b: PublicPageItem) => a.path === b.path && a.type === b.type;

export async function listPages(deps: RemoteDeps): Promise<PageView[]> {
  const host = pageHost(deps);
  return (await listPublicPages(host.server, deps.config.baseDir, host.tenantId)).map((page) => pageView(host.server, page));
}

async function findPage(deps: RemoteDeps, host: { server: string; tenantId: string }, pageId: string): Promise<PublicPage> {
  const page = (await listPublicPages(host.server, deps.config.baseDir, host.tenantId)).find((p) => p.id === pageId);
  if (!page || page.revoked) throw new SharingError(`no live public page with id "${pageId}"`, 404);
  return page;
}

export async function createPage(deps: RemoteDeps, title: string, subjects: ShareSubject[], expiresInDays?: number): Promise<PageView> {
  const host = pageHost(deps);
  const items = subjects.map((subject) => pageItemFor(deps, host, subject));
  const { id } = await createPublicPage(host.server, deps.config.baseDir, host.tenantId, title, items, expiresInDays);
  return pageView(host.server, await findPage(deps, host, id));
}

/** Adds and/or removes items (and optionally retitles); the page's link stays the same. */
export async function editPage(deps: RemoteDeps, pageId: string, change: { add?: ShareSubject[]; remove?: ShareSubject[]; title?: string }): Promise<PageView> {
  const host = pageHost(deps);
  const page = await findPage(deps, host, pageId);
  let items = page.items;
  for (const subject of change.remove ?? []) {
    const gone = pageItemFor(deps, host, subject);
    items = items.filter((item) => !sameItem(item, gone));
  }
  for (const subject of change.add ?? []) {
    const added = pageItemFor(deps, host, subject);
    if (!items.some((item) => sameItem(item, added))) items = [...items, added];
  }
  if (items.length === 0) throw new SharingError('a public page needs at least one item — revoke the page instead', 400);
  await updatePublicPage(host.server, deps.config.baseDir, host.tenantId, pageId, { items, ...(change.title ? { title: change.title } : {}) });
  return pageView(host.server, await findPage(deps, host, pageId));
}

export async function revokePage(deps: RemoteDeps, pageId: string): Promise<void> {
  const host = pageHost(deps);
  await revokePublicPage(host.server, deps.config.baseDir, host.tenantId, pageId);
}

/** The live pages, each marked with whether `subject` is on it — the share form's "Public pages" list. */
export async function pagesFor(deps: RemoteDeps, subject: ShareSubject): Promise<Array<PageView & { included: boolean }>> {
  const host = pageHost(deps);
  const item = pageItemFor(deps, host, subject);
  return (await listPages(deps)).filter((p) => !p.revoked).map((p) => ({ ...p, included: p.items.some((i) => sameItem(i, item)) }));
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
