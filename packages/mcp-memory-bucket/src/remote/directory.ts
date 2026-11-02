import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { walkFilesRecursive } from '../attachments/storage.js';
import { writeFileAtomic } from '../store/atomic-write.js';
import { TENANT_ID } from '../shared/folderfoo-tenant.js';
import { FolderfooRequestError, directoryFile, directoryListing, directoryCategories, publishListing, type DirectoryListing } from './folderfoo-client.js';
import { SharingError, type RemoteDeps } from './connect.js';
import { resolveSubject, type ShareSubject } from './sharing.js';

// Public skills: folderfoo's public directory, from this app's side. mem-bucket runs on each
// user's machine, so folderfoo hosts the browsing page (/d/membkt) and its "Add to my Memory
// Bucket" button opens a review screen here.
//
// A skill is instructions an agent follows, and nobody but the adopter reviews it. So an import
// always arrives paused with status 'unreviewed', after a screen listing every file, and an update
// is never applied silently: it shows what changed and returns the skill to paused. There are
// deliberately no MCP tools here: an agent must not install or publish skills on its own, and
// publishing can leak secrets that cannot be recalled.

const IMPORTS_FILE = 'directory-imports.json';

interface ImportSnapshot {
  content: string;
  /** Text files by path; null for a file nobody can read. */
  files: Record<string, string | null>;
}

export interface DirectoryImport {
  listingId: string;
  server: string;
  tenantId: string;
  skill: string;
  folder: string;
  version: number;
  /** The listing was hidden or removed, and the local copy was paused for it. */
  gone?: boolean;
  snapshot: ImportSnapshot;
}

export interface DiffLine {
  type: 'same' | 'added' | 'removed';
  text: string;
}

export interface PreviewFile {
  path: string;
  kind: 'image' | 'text' | 'binary';
  size: number;
  text?: string;
  /** Against what was imported last, when this is an update. */
  change?: 'new' | 'changed' | 'unchanged';
  diff?: DiffLine[];
}

export interface ListingPreview {
  id: string;
  owner: string;
  title: string;
  description: string;
  license: string;
  version: number;
  content: string;
  contentDiff?: DiffLine[];
  files: PreviewFile[];
  removedFiles: string[];
  /** The skill this would update; null when it would be a new import. */
  updates: string | null;
}

const MAX_DIFF_LINES = 2000;

/** A line diff by longest common subsequence. Very long inputs show as replaced whole. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [...a.map((text) => ({ type: 'removed' as const, text })), ...b.map((text) => ({ type: 'added' as const, text }))];
  }
  const lengths = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i]![j] = a[i] === b[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i]! });
      i++;
      j++;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      out.push({ type: 'removed', text: a[i++]! });
    } else {
      out.push({ type: 'added', text: b[j++]! });
    }
  }
  while (i < a.length) out.push({ type: 'removed', text: a[i++]! });
  while (j < b.length) out.push({ type: 'added', text: b[j++]! });
  return out;
}

/** A listing's file path, joined under a directory. A remote path can never leave that directory. */
export function safeJoin(dir: string, relPath: string): string {
  const target = path.resolve(dir, relPath);
  if (relPath === 'SKILL.md' || !target.startsWith(path.resolve(dir) + path.sep)) {
    throw new SharingError(`unsafe file path in listing: ${relPath}`, 422);
  }
  return target;
}

function importsPath(deps: RemoteDeps): string {
  return path.join(deps.config.baseDir, IMPORTS_FILE);
}

export function readImports(deps: RemoteDeps): DirectoryImport[] {
  try {
    return JSON.parse(fs.readFileSync(importsPath(deps), 'utf-8')) as DirectoryImport[];
  } catch {
    return [];
  }
}

function writeImports(deps: RemoteDeps, imports: DirectoryImport[]): void {
  writeFileAtomic(importsPath(deps), JSON.stringify(imports, null, 1));
}

/** Only the folderfoo this bucket is configured for: a link cannot point the review screen elsewhere. */
function serverOf(deps: RemoteDeps): string {
  if (!deps.config.folderfooHost) throw new SharingError('folderfoo integration is off — start with --folderfoo-mode', 400);
  return deps.config.folderfooHost;
}

/** Fetches every file. A binary file needs a folderfoo login, so without one it is left out and named. */
async function fetchFiles(deps: RemoteDeps, server: string, listing: DirectoryListing): Promise<{ fetched: Array<{ path: string; data: Buffer }>; skipped: string[] }> {
  const fetched: Array<{ path: string; data: Buffer }> = [];
  const skipped: string[] = [];
  for (const file of listing.files) {
    try {
      fetched.push({ path: file.path, data: await directoryFile(server, deps.config.baseDir, TENANT_ID, listing.id, file.path, file.kind === 'binary') });
    } catch (err) {
      if (file.kind !== 'binary') throw err;
      skipped.push(file.path);
    }
  }
  return { fetched, skipped };
}

export async function previewListing(deps: RemoteDeps, id: string): Promise<ListingPreview> {
  const server = serverOf(deps);
  const listing = await directoryListing(server, TENANT_ID, id);
  const previous = readImports(deps).find((row) => row.listingId === id && row.server === server);
  const files: PreviewFile[] = [];
  for (const file of listing.files) {
    const row: PreviewFile = { path: file.path, kind: file.kind, size: file.size };
    if (file.kind === 'text') {
      const text = (await directoryFile(server, deps.config.baseDir, TENANT_ID, id, file.path, false)).toString('utf-8');
      row.text = text;
      if (previous) {
        const before = previous.snapshot.files[file.path];
        if (typeof before !== 'string') row.change = 'new';
        else if (before === text) row.change = 'unchanged';
        else {
          row.change = 'changed';
          row.diff = lineDiff(before, text);
        }
      }
    }
    files.push(row);
  }
  return {
    id: listing.id,
    owner: listing.owner,
    title: listing.title,
    description: listing.description,
    license: listing.license,
    version: listing.version,
    content: listing.content,
    ...(previous && previous.snapshot.content !== listing.content ? { contentDiff: lineDiff(previous.snapshot.content, listing.content) } : {}),
    files,
    removedFiles: previous ? Object.keys(previous.snapshot.files).filter((p) => !listing.files.some((f) => f.path === p)) : [],
    updates: previous ? previous.skill : null,
  };
}

function skillNameFrom(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'public-skill';
}

/**
 * Imports a listing, or applies a new version of one imported before. Either way the skill ends up
 * paused and 'unreviewed'. If it cannot be paused it is removed again: an active skill nobody
 * reviewed is the one outcome this must never leave behind.
 */
export async function importListing(deps: RemoteDeps, id: string, folder?: string): Promise<{ skill: string; folder: string; skippedFiles: string[] }> {
  const server = serverOf(deps);
  const listing = await directoryListing(server, TENANT_ID, id);
  const imports = readImports(deps);
  const previous = imports.find((row) => row.listingId === id && row.server === server);
  const parsed = matter(listing.content);
  const fm = parsed.data as { name?: string; description?: string; tags?: string[]; trigger_phrases?: string[] };
  const description = fm.description || listing.description || listing.title;
  // Checked before anything is created, so a bad listing leaves nothing behind.
  for (const file of listing.files) safeJoin(deps.config.baseDir, file.path);
  const { fetched, skipped } = await fetchFiles(deps, server, listing);

  let name: string;
  let targetFolder: string;
  if (previous) {
    const existing = await deps.skillRepo.get(previous.skill, previous.folder);
    if (!existing) throw new SharingError(`"${previous.skill}" no longer exists here. Remove it from public imports to add it again.`, 409);
    const paused = await deps.skillRepo.setPaused([previous.skill], true);
    if (!paused[0]?.ok) throw new SharingError(`Could not pause "${previous.skill}", so it was not updated: ${paused[0]?.error ?? 'unknown error'}`, 500);
    await deps.skillRepo.update(previous.skill, { description, status: 'unreviewed' }, parsed.content.trim(), undefined, previous.folder);
    name = previous.skill;
    targetFolder = previous.folder;
  } else {
    name = fm.name || skillNameFrom(listing.title);
    if (await deps.skillRepo.get(name).catch(() => null)) {
      throw new SharingError(`You already have a skill called "${name}". Rename yours to add this one.`, 409);
    }
    const created = await deps.skillRepo.create({ name, description, tags: fm.tags, trigger_phrases: fm.trigger_phrases, status: 'unreviewed' }, parsed.content.trim(), undefined, folder);
    targetFolder = created.folder;
    const paused = await deps.skillRepo.setPaused([name], true);
    if (!paused[0]?.ok) {
      await deps.skillRepo.delete(name, targetFolder);
      throw new SharingError(`Could not pause "${name}", so it was not added: ${paused[0]?.error ?? 'unknown error'}`, 500);
    }
  }

  const doc = await deps.skillRepo.get(name, targetFolder);
  if (!doc) throw new SharingError(`"${name}" could not be read back after import`, 500);
  const skillDir = path.dirname(doc.source_path);
  const snapshotFiles: Record<string, string | null> = {};
  const incoming = new Set(fetched.map((f) => f.path));
  for (const file of fetched) {
    const dest = safeJoin(skillDir, file.path);
    await deps.skillRepo.pushSkillSiblingFileIfNeeded(targetFolder, dest, file.data);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.data);
    const meta = listing.files.find((f) => f.path === file.path);
    snapshotFiles[file.path] = meta?.kind === 'text' ? file.data.toString('utf-8') : null;
  }
  // Files the author dropped go too, so the skill matches what was reviewed.
  if (previous) {
    for (const rel of walkFilesRecursive(skillDir)) {
      const posix = rel.split(path.sep).join('/');
      if (posix !== 'SKILL.md' && !incoming.has(posix)) fs.rmSync(path.join(skillDir, rel), { force: true });
    }
  }

  const record: DirectoryImport = { listingId: id, server, tenantId: TENANT_ID, skill: name, folder: targetFolder, version: listing.version, snapshot: { content: listing.content, files: snapshotFiles } };
  writeImports(deps, [...imports.filter((row) => row !== previous), record]);
  return { skill: name, folder: targetFolder, skippedFiles: skipped };
}

export interface ImportStatus {
  listingId: string;
  skill: string;
  folder: string;
  version: number;
  latestVersion: number | null;
  updateAvailable: boolean;
  gone: boolean;
}

/**
 * What became of what was imported. Anonymous reads cannot tell a hidden listing from one its
 * author removed, and either way nobody stands behind it any more, so both pause the local copy,
 * once: if the user turns it back on, it stays on.
 */
export async function importStatuses(deps: RemoteDeps): Promise<ImportStatus[]> {
  const imports = readImports(deps);
  const out: ImportStatus[] = [];
  let changed = false;
  for (const row of imports) {
    let latestVersion: number | null = null;
    try {
      latestVersion = (await directoryListing(row.server, row.tenantId, row.listingId)).version;
      if (row.gone) {
        delete row.gone;
        changed = true;
      }
    } catch (err) {
      if (err instanceof FolderfooRequestError && err.status === 404 && !row.gone) {
        await deps.skillRepo.setPaused([row.skill], true);
        row.gone = true;
        changed = true;
      } else if (!(err instanceof FolderfooRequestError && err.status === 404)) {
        latestVersion = row.version; // unreachable right now: say nothing new
      }
    }
    out.push({
      listingId: row.listingId,
      skill: row.skill,
      folder: row.folder,
      version: row.version,
      latestVersion,
      updateAvailable: latestVersion !== null && latestVersion > row.version,
      gone: !!row.gone,
    });
  }
  if (changed) writeImports(deps, imports);
  return out;
}

function skillSubject(subject: ShareSubject): void {
  if (subject.kind !== 'skill') throw new SharingError('Only single skills can be published. Memory docs and whole folders stay private.', 400);
}

/** The folderfoo address of a skill's SKILL file: a one-segment folder takes the empty-owner form. */
export function skillAddress(folderPath: string): string {
  return folderPath.includes('/') ? `${folderPath}:SKILL` : `:${folderPath}:SKILL`;
}

export async function publishPreview(deps: RemoteDeps, subject: ShareSubject): Promise<{ files: string[]; categories: string[]; title: string; description: string; group: string | null }> {
  skillSubject(subject);
  const target = resolveSubject(deps, subject);
  const doc = await deps.skillRepo.get(subject.id, subject.folder);
  if (!doc) throw new SharingError('not found', 404);
  return {
    files: walkFilesRecursive(path.dirname(doc.source_path)).map((rel) => rel.split(path.sep).join('/')).sort(),
    categories: await directoryCategories(target.server, target.tenantId),
    title: doc.name,
    description: doc.description,
    group: doc.metadata?.group ?? null,
  };
}

export async function publishSkill(
  deps: RemoteDeps,
  subject: ShareSubject,
  form: { title?: unknown; description?: unknown; category?: unknown; license?: unknown; tags?: unknown; confirmSecrets?: unknown }
): Promise<{ id: string; version: number; status: string; heldReason: string | null; url: string }> {
  skillSubject(subject);
  const target = resolveSubject(deps, subject);
  const result = await publishListing(target.server, deps.config.baseDir, target.tenantId, {
    name: skillAddress(target.path),
    bundle: target.path,
    title: typeof form.title === 'string' && form.title.trim() ? form.title.trim() : subject.id,
    ...(typeof form.description === 'string' ? { description: form.description } : {}),
    ...(typeof form.category === 'string' && form.category ? { category: form.category } : {}),
    ...(typeof form.license === 'string' && form.license ? { license: form.license } : {}),
    ...(Array.isArray(form.tags) ? { tags: form.tags } : {}),
    ...(form.confirmSecrets === true ? { confirmSecrets: true } : {}),
  });
  return { ...result, url: `${target.server}/d/${encodeURIComponent(target.tenantId)}/${encodeURIComponent(result.id)}` };
}
