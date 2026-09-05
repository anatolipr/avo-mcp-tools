import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Router, Request, Response } from 'express';
import express from 'express';
import matter from 'gray-matter';
import type Database from 'better-sqlite3';
import type { BucketConfig, RemoteFolder } from '../config.js';
import {
  saveFolder,
  saveRemoteFolder,
  removeFolder as removeFolderFromConfig,
  updateRemoteFolderPath as updateRemoteFolderPathInConfig,
  sanitizeFolderName,
  mirrorDirFor,
} from '../config.js';
import type { SkillRepository } from '../skills/repository.js';
import { stripKey, type MemoryRepository } from '../memory/repository.js';
import { initialScan, walkMarkdownFiles, type TableSyncSpec } from '../store/sync.js';
import { sanitizeFtsQuery } from '../store/search.js';
import { resolveWithinBase } from '../store/safe-path.js';
import { attachmentsDirFor, guessMimeType, ATTACHMENT_MAX_BYTES } from '../attachments/storage.js';
import type { AttachmentRepository } from '../attachments/repository.js';
import { listFolders as listFolderfooFolders } from '../remote/folderfoo-client.js';
import { setCredential } from '../remote/credentials.js';
import { pollOne, type RemotePollerHandle } from '../remote/remote-sync.js';
import { decodeUsername, isFolderVisible, type IdentityTracker } from '../remote/identity.js';
import {
  refreshSharedItems,
  listSharedItems,
  dismissRevokedSharedItem,
  addSharedItem,
  getSharedItem,
  resolveShareTarget,
} from '../remote/shared-items.js';
import { shareWithUser, unshareWithUser, createShareLink, createPublicLink, joinRemoteFolderPath, getSharedWithMe, FolderfooRequestError } from '../remote/folderfoo-client.js';
import { readMarkdownFile } from '../store/markdown-file.js';
import type { MemoryFrontmatter, SkillFrontmatter } from '../types.js';
import { getChannel, listChannels } from '../channels/store.js';

type EntryType = 'skill' | 'memory' | 'all';

interface EntryRow {
  _table: 'skills' | 'memory_docs';
  id: string; // skill name, or memory doc's source_path (globally unique; filename alone is only unique per-folder)
  name: string; // skill name, or memory doc's own filename — the primary title in the UI
  key: string | null; // memory docs only — the grouping label, shown as a secondary line under the filename
  group: string | null; // skills only — this skill's primary category (frontmatter.metadata.group)
  description: string;
  tags: string[];
  status: string;
  owner: string | null;
  doc_type: string | null;
  key_type: string | null;
  folder: string;
  mtime_ms: number;
  deprecated: boolean;
  paused: boolean;
  created_at: string | null;
}

function asArray(v: unknown): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v.map(String) : [String(v)];
}

function isTextishMime(mimeType: string): boolean {
  return mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Colors mirror public/index.html's --bg-subtle/--fg light-dark() pairs (composited over --bg,
 * since this shell has no ambient page to layer a translucent --bg-subtle over) so a text
 * attachment's inline preview reads as part of the same surface as the detail panel around it,
 * in both the app's manual theme override and the OS-level default.
 */
function renderTextAttachmentPage(content: string, theme: string): string {
  return `<!doctype html>
<html data-theme="${theme}">
<head>
<meta charset="utf-8">
<style>
  :root { color-scheme: light dark; }
  :root[data-theme='light'] { color-scheme: light; }
  :root[data-theme='dark'] { color-scheme: dark; }
  html, body { margin: 0; }
  body { background: light-dark(#f7f7f7, #262626); color: light-dark(#111111, #f0f0f0); }
  pre {
    margin: 0;
    padding: 12px;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.5;
  }
</style>
</head>
<body><pre>${escapeHtml(content)}</pre></body>
</html>`;
}

function tagWhereClause(tags: string[]): { clause: string; params: string[] } {
  if (tags.length === 0) return { clause: '', params: [] };
  const clauses = tags.map(() => `EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)`);
  return { clause: ` AND ${clauses.join(' AND ')}`, params: tags };
}

/** Names of `repo`'s remote folders that don't match the currently logged-in identity — a remote
 * folder connected under a DIFFERENT user (or while nobody is logged in) must never appear in list
 * results, same as MemoryRepository/SkillRepository's own get()/search() already enforce; this is
 * the web UI's list endpoint's equivalent, since it queries sqlite directly rather than going
 * through those repository methods. */
function hiddenRemoteFolderNames(repo: { listRemoteFolders(): RemoteFolder[] }, identity: IdentityTracker): string[] {
  const current = identity.current();
  return repo
    .listRemoteFolders()
    .filter((f) => !isFolderVisible(f, current))
    .map((f) => f.name);
}

function queryEntries(db: Database.Database, skillRepo: SkillRepository, memoryRepo: MemoryRepository, identity: IdentityTracker, req: Request): EntryRow[] {
  const type = (req.query.type as EntryType) ?? 'all';
  const tags = asArray(req.query.tag);
  const statuses = asArray(req.query.status);
  const owners = asArray(req.query.owner);
  const docTypes = asArray(req.query.doc_type);
  const keyTypes = asArray(req.query.key_type);
  const folders = asArray(req.query.folder);
  const groups = asArray(req.query.group);
  const q = (req.query.q as string | undefined)?.trim();
  const deprecatedParam = req.query.deprecated as string | undefined;
  const deprecated = deprecatedParam === '0' || deprecatedParam === '1' ? deprecatedParam : undefined;
  const pausedParam = req.query.paused as string | undefined;
  const paused = pausedParam === '0' || pausedParam === '1' ? pausedParam : undefined;
  const dateFrom = (req.query.date_from as string | undefined)?.trim() || undefined;
  const dateTo = (req.query.date_to as string | undefined)?.trim() || undefined;

  // If the typed query matches an existing key (ignoring punctuation/case), short-circuit straight
  // to "every doc under this key" for memory_docs — this bypasses FTS/bm25 ranking entirely, so a
  // doc whose body never repeats the literal key text (e.g. a session summary) still shows up.
  // Skills have no `key` concept, so they still go through the normal FTS path below when q is set.
  const keyMatch = q ? memoryRepo.suggestKeys(q, 1).find((m) => stripKey(m.key) === stripKey(q)) : undefined;

  // Always compute FTS matches when q is set, even on a keyMatch — skills still need this to stay
  // filtered by q (they have no key concept, so keyMatch only bypasses filtering for memory_docs below).
  const matchedIds: { skills: Set<string>; memory_docs: Set<string>; rank: Map<string, number> } | null = q
    ? matchSearch(db, q)
    : null;
  if (q && !keyMatch && matchedIds && matchedIds.skills.size === 0 && matchedIds.memory_docs.size === 0) {
    return [];
  }

  const dateIds: { skills: Set<string>; memory_docs: Set<string> } | null =
    dateFrom || dateTo ? matchDateRange(db, dateFrom, dateTo) : null;
  if (dateIds && dateIds.skills.size === 0 && dateIds.memory_docs.size === 0) {
    return [];
  }

  const results: EntryRow[] = [];

  if (type === 'skill' || type === 'all') {
    results.push(
      ...queryTable(
        db,
        'skills',
        { tags, statuses, owners, docTypes: [], keyTypes: [], folders, keys: [], groups, deprecated, paused },
        intersectIds(matchedIds?.skills, dateIds?.skills),
        hiddenRemoteFolderNames(skillRepo, identity)
      )
    );
  }
  if (type === 'memory' || type === 'all') {
    results.push(
      ...queryTable(
        db,
        'memory_docs',
        { tags, statuses, owners: [], docTypes, keyTypes, folders, groups: [], deprecated, paused, keys: keyMatch ? [keyMatch.key] : [] },
        keyMatch ? undefined : intersectIds(matchedIds?.memory_docs, dateIds?.memory_docs),
        hiddenRemoteFolderNames(memoryRepo, identity)
      )
    );
  }

  // Default sort is relevance (bm25) when a search query is active — otherwise a good match with
  // an old mtime (e.g. "grilling") can sink below unrelated recently-touched entries and look like
  // it's missing. Falls back to mtime_desc when there's no query to rank by. An explicit `sort`
  // param always wins over this default.
  const sort = (req.query.sort as string | undefined) ?? (q ? 'relevance' : 'mtime_desc');
  const rankOf = (r: EntryRow) => matchedIds?.rank.get(r._table === 'skills' ? skillKey(r.folder, r.id) : r.id);
  results.sort((a, b) => {
    if (sort === 'relevance') {
      const ra = rankOf(a);
      const rb = rankOf(b);
      if (ra !== undefined && rb !== undefined && ra !== rb) return ra - rb; // bm25: lower is better
      return b.mtime_ms - a.mtime_ms; // tie or no-rank (e.g. keyMatch-only memory_docs): fall back to mtime
    }
    if (sort === 'mtime_asc') return a.mtime_ms - b.mtime_ms;
    if (sort === 'name_asc') return a.name.localeCompare(b.name);
    if (sort === 'created_at_asc') {
      if (!a.created_at && !b.created_at) return 0;
      if (!a.created_at) return 1; // missing created_at sorts last
      if (!b.created_at) return -1;
      return a.created_at.localeCompare(b.created_at);
    }
    return b.mtime_ms - a.mtime_ms; // mtime_desc, default
  });

  return results;
}

function queryTable(
  db: Database.Database,
  table: 'skills' | 'memory_docs',
  filters: {
    tags: string[];
    statuses: string[];
    owners: string[];
    docTypes: string[];
    keyTypes: string[];
    folders: string[];
    keys: string[];
    groups: string[];
    deprecated?: string;
    paused?: string;
  },
  restrictToIds: Set<string> | undefined,
  hiddenFolders: string[] = []
): EntryRow[] {
  if (restrictToIds && restrictToIds.size === 0) return [];

  const params: unknown[] = [];
  let where = '1 = 1';

  if (hiddenFolders.length > 0) {
    // A remote folder connected under a DIFFERENT identity than the one currently logged in (or
    // connected while nobody was logged in) must never surface here — mirrors the same check
    // MemoryRepository/SkillRepository's own get()/search()/getByKey() already apply; this query
    // bypasses those methods (raw SQL against the cache), so it needs its own copy of the filter.
    where += ` AND folder NOT IN (${hiddenFolders.map(() => '?').join(', ')})`;
    params.push(...hiddenFolders);
  }

  const { clause: tagClause, params: tagParams } = tagWhereClause(filters.tags);
  where += tagClause;
  params.push(...tagParams);

  if (filters.statuses.length > 0) {
    where += ` AND status IN (${filters.statuses.map(() => '?').join(', ')})`;
    params.push(...filters.statuses);
  }
  if (table === 'skills' && filters.owners.length > 0) {
    where += ` AND owner IN (${filters.owners.map(() => '?').join(', ')})`;
    params.push(...filters.owners);
  }
  if (table === 'memory_docs' && filters.docTypes.length > 0) {
    where += ` AND doc_type IN (${filters.docTypes.map(() => '?').join(', ')})`;
    params.push(...filters.docTypes);
  }
  if (table === 'memory_docs' && filters.keyTypes.length > 0) {
    where += ` AND key_type IN (${filters.keyTypes.map(() => '?').join(', ')})`;
    params.push(...filters.keyTypes);
  }
  if (table === 'memory_docs' && filters.keys.length > 0) {
    where += ` AND key IN (${filters.keys.map(() => '?').join(', ')})`;
    params.push(...filters.keys);
  }
  if (table === 'skills' && filters.groups.length > 0) {
    where += ` AND skill_group IN (${filters.groups.map(() => '?').join(', ')})`;
    params.push(...filters.groups);
  }
  if (filters.folders.length > 0) {
    where += ` AND folder IN (${filters.folders.map(() => '?').join(', ')})`;
    params.push(...filters.folders);
  }
  if (filters.deprecated !== undefined) {
    where += ` AND deprecated = ?`;
    params.push(filters.deprecated === '1' ? 1 : 0);
  }
  if (filters.paused !== undefined) {
    where += ` AND paused = ?`;
    params.push(filters.paused === '1' ? 1 : 0);
  }
  if (restrictToIds) {
    // Skills restrict on the composite (folder, id) pair — see skillKey's comment — since a bare
    // `id IN (...)` could match the wrong folder's same-named skill once names are folder-scoped.
    // memory_docs restricts on source_path (its real identity — a filesystem path is globally
    // unique by construction, never collides across folders).
    if (table === 'skills') {
      // SKILL_KEY_SEP is a NUL byte, which can't be embedded in a single-quoted SQL string literal
      // (SQLite's tokenizer rejects it) — bind it as a parameter instead of interpolating it into the query text.
      where += ` AND (folder || ? || id) IN (${[...restrictToIds].map(() => '?').join(', ')})`;
      params.push(SKILL_KEY_SEP);
    } else {
      where += ` AND source_path IN (${[...restrictToIds].map(() => '?').join(', ')})`;
    }
    params.push(...restrictToIds);
  }

  if (table === 'skills') {
    const rows = db
      .prepare(`SELECT id, description, owner, status, tags, folder, mtime_ms, deprecated, paused, created_at, skill_group FROM skills WHERE ${where}`)
      .all(...params) as Array<{
      id: string;
      description: string;
      owner: string | null;
      status: string;
      tags: string;
      folder: string;
      mtime_ms: number;
      deprecated: number;
      paused: number;
      created_at: string | null;
      skill_group: string | null;
    }>;
    return rows.map((r) => ({
      _table: 'skills',
      id: r.id,
      name: r.id,
      key: null,
      group: r.skill_group,
      description: r.description,
      tags: JSON.parse(r.tags),
      status: r.status,
      owner: r.owner,
      doc_type: null,
      key_type: null,
      folder: r.folder,
      mtime_ms: r.mtime_ms,
      deprecated: !!r.deprecated,
      paused: !!r.paused,
      created_at: r.created_at,
    }));
  }

  const rows = db
    .prepare(
      `SELECT source_path, key, description, doc_type, key_type, status, tags, folder, mtime_ms, deprecated, paused, created_at FROM memory_docs WHERE ${where}`
    )
    .all(...params) as Array<{
    source_path: string;
    key: string;
    description: string;
    doc_type: string;
    key_type: string;
    status: string;
    tags: string;
    folder: string;
    mtime_ms: number;
    deprecated: number;
    paused: number;
    created_at: string | null;
  }>;
  return rows.map((r) => ({
    _table: 'memory_docs',
    id: r.source_path,
    name: path.basename(r.source_path),
    key: r.key,
    group: null,
    description: r.description,
    tags: JSON.parse(r.tags),
    status: r.status,
    owner: null,
    doc_type: r.doc_type,
    key_type: r.key_type,
    folder: r.folder,
    mtime_ms: r.mtime_ms,
    deprecated: !!r.deprecated,
    paused: !!r.paused,
    created_at: r.created_at,
  }));
}

// Skills key on (folder, id) — two different folders can legitimately share a skill name — so an
// id-only restriction set can no longer safely identify "this one skill" for filtering (it would
// either miss a real match or wrongly include the other folder's same-named skill). Skill entries in
// these restriction sets are therefore composite `folder\0id` strings; memory_docs entries stay
// plain ids (source_path — a real filesystem path is globally unique by construction, never collides).
const SKILL_KEY_SEP = ' ';
function skillKey(folder: string, id: string): string {
  return `${folder}${SKILL_KEY_SEP}${id}`;
}

/** Combines two optional id-restriction sets (e.g. from `q` and a date range) into one, when both are present. */
function intersectIds(a: Set<string> | undefined, b: Set<string> | undefined): Set<string> | undefined {
  if (!a) return b;
  if (!b) return a;
  return new Set([...a].filter((id) => b.has(id)));
}

/** Queries the `doc_dates` side table for ids whose body-extracted or created_at date falls in [from, to], bucketed by source table. */
function matchDateRange(
  db: Database.Database,
  from: string | undefined,
  to: string | undefined
): { skills: Set<string>; memory_docs: Set<string> } {
  const skills = new Set<string>();
  const memory_docs = new Set<string>();
  const params: string[] = [];
  let where = '1 = 1';
  if (from) {
    where += ' AND date >= ?';
    params.push(from);
  }
  if (to) {
    where += ' AND date <= ?';
    params.push(to);
  }
  const rows = db
    .prepare(`SELECT DISTINCT ref_table, ref_id, ref_folder FROM doc_dates WHERE ${where}`)
    .all(...params) as Array<{ ref_table: 'skills' | 'memory_docs'; ref_id: string; ref_folder: string }>;
  for (const row of rows) {
    if (row.ref_table === 'skills') skills.add(skillKey(row.ref_folder, row.ref_id));
    else memory_docs.add(row.ref_id);
  }
  return { skills, memory_docs };
}

/**
 * Runs the FTS5 query once, buckets matching ids by source table, and records each match's bm25
 * rank (lower = more relevant) keyed the same way restrictToIds is (skillKey for skills, plain id
 * for memory_docs) — used to sort search results by relevance instead of mtime by default.
 */
function matchSearch(
  db: Database.Database,
  q: string
): { skills: Set<string>; memory_docs: Set<string>; rank: Map<string, number> } {
  const skills = new Set<string>();
  const memory_docs = new Set<string>();
  const rank = new Map<string, number>();
  let rows: Array<{ ref_table: 'skills' | 'memory_docs'; ref_id: string; ref_folder: string; score: number }>;
  try {
    rows = db
      .prepare(
        `SELECT ref_table, ref_id, ref_folder, bm25(search_index) AS score FROM search_index WHERE search_index MATCH ? ORDER BY rank`
      )
      .all(sanitizeFtsQuery(q)) as typeof rows;
  } catch {
    // Bad FTS5 query syntax (e.g. a bare quote) — treat as no matches rather than 500ing.
    return { skills, memory_docs, rank };
  }
  for (const row of rows) {
    const key = row.ref_table === 'skills' ? skillKey(row.ref_folder, row.ref_id) : row.ref_id;
    if (row.ref_table === 'skills') skills.add(key);
    else memory_docs.add(key);
    rank.set(key, row.score); // bm25 is lower-is-better; stored as-is, compared ascending below
  }
  return { skills, memory_docs, rank };
}

function buildFacets(db: Database.Database, type: EntryType) {
  const tags = new Set<string>();
  const statuses = new Set<string>();
  const owners = new Set<string>();
  const docTypes = new Set<string>();
  const keyTypes = new Set<string>();
  const folders = new Set<string>();
  const groups = new Set<string>();

  if (type === 'skill' || type === 'all') {
    const rows = db.prepare(`SELECT tags, status, owner, folder, skill_group FROM skills`).all() as Array<{
      tags: string;
      status: string;
      owner: string | null;
      folder: string;
      skill_group: string | null;
    }>;
    for (const r of rows) {
      (JSON.parse(r.tags) as string[]).forEach((t) => tags.add(t));
      statuses.add(r.status);
      if (r.owner) owners.add(r.owner);
      if (r.folder) folders.add(r.folder);
      if (r.skill_group) groups.add(r.skill_group);
    }
  }
  if (type === 'memory' || type === 'all') {
    const rows = db.prepare(`SELECT tags, status, doc_type, key_type, folder FROM memory_docs`).all() as Array<{
      tags: string;
      status: string;
      doc_type: string;
      key_type: string;
      folder: string;
    }>;
    for (const r of rows) {
      (JSON.parse(r.tags) as string[]).forEach((t) => tags.add(t));
      statuses.add(r.status);
      docTypes.add(r.doc_type);
      keyTypes.add(r.key_type);
      if (r.folder) folders.add(r.folder);
    }
  }

  return {
    tags: [...tags].sort(),
    statuses: [...statuses].sort(),
    owners: [...owners].sort(),
    doc_types: [...docTypes].sort(),
    key_types: [...keyTypes].sort(),
    folders: [...folders].sort(),
    groups: [...groups].sort(),
  };
}

function buildHealth(db: Database.Database) {
  const skillIds = new Set(
    (db.prepare(`SELECT id FROM skills`).all() as Array<{ id: string }>).map((r) => r.id)
  );
  const memoryKeys = new Set(
    (db.prepare(`SELECT key FROM memory_docs`).all() as Array<{ key: string }>).map((r) => r.key)
  );

  const skills = db.prepare(`SELECT id, extends, trigger_phrases, mtime_ms FROM skills`).all() as Array<{
    id: string;
    extends: string | null;
    trigger_phrases: string;
    mtime_ms: number;
  }>;
  const danglingExtends = skills
    .filter((s) => s.extends && !skillIds.has(s.extends))
    .map((s) => ({ id: s.id, extends: s.extends }));
  const emptyTriggerPhrases = skills
    .filter((s) => (JSON.parse(s.trigger_phrases) as string[]).length === 0)
    .map((s) => s.id);

  const memoryDocs = db.prepare(`SELECT source_path, related_to, status, mtime_ms FROM memory_docs`).all() as Array<{
    source_path: string;
    related_to: string | null;
    status: string;
    mtime_ms: number;
  }>;
  // related_to is a free-text `key` reference (see its docstring in memory/tools.ts), not validated
  // on write — checked here against known keys, not against skill ids (a memory doc can't relate to
  // a skill by key, so no skillIds fallback like the old id-based check had).
  const danglingRelatedTo = memoryDocs
    .filter((m) => m.related_to && !memoryKeys.has(m.related_to))
    .map((m) => ({ id: m.source_path, related_to: m.related_to }));

  const staleCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const staleActiveMemoryDocs = memoryDocs
    .filter((m) => m.status === 'active' && m.mtime_ms < staleCutoff)
    .map((m) => m.source_path);

  return { danglingExtends, danglingRelatedTo, emptyTriggerPhrases, staleActiveMemoryDocs };
}

export function buildWebRouter(
  db: Database.Database,
  config: BucketConfig,
  skillRepo: SkillRepository,
  memoryRepo: MemoryRepository,
  skillSpec: TableSyncSpec<any>,
  memorySpec: TableSyncSpec<any>,
  identity: IdentityTracker,
  remotePollers?: { skill?: RemotePollerHandle; memory?: RemotePollerHandle },
  attachRepo?: AttachmentRepository
): Router {
  const router = express.Router();

  // Whether the doc at `table`/`id` lives in a folder visible under the CURRENTLY logged-in
  // identity — a remote folder connected under a different user (or connected while nobody was
  // logged in) must never be reachable through any entries route, not just hidden from the list
  // (see hiddenRemoteFolderNames' doc comment for the underlying rule). Returns false (not found)
  // for a row that doesn't exist at all, same as the "not found" case callers already handle.
  function isEntryVisible(table: 'skills' | 'memory_docs', id: string | undefined): boolean {
    if (!id) return false;
    const idCol = table === 'skills' ? 'id' : 'source_path';
    const row = db.prepare(`SELECT folder FROM ${table} WHERE ${idCol} = ?`).get(id) as { folder: string } | undefined;
    if (!row) return false;
    const hidden = hiddenRemoteFolderNames(table === 'skills' ? skillRepo : memoryRepo, identity);
    return !hidden.includes(row.folder);
  }

  // Resyncs every remote source FIRST (force: true - always does real work,
  // including reconcileDeletions, regardless of the watermark check), so a
  // deletion made on folderfoo shows up here even if the poller's next
  // regular tick hasn't fired yet. Without this, the wipe-and-rescan below
  // is LOCAL-ONLY - it would silently resurrect a file that was deleted on
  // folderfoo but whose stale mirror copy hadn't been reconciled away yet.
  router.post('/api/rebuild-cache', async (_req: Request, res: Response) => {
    try {
      await Promise.all([remotePollers?.skill?.resyncAll(), remotePollers?.memory?.resyncAll()]);
      db.exec(`DELETE FROM skills; DELETE FROM memory_docs; DELETE FROM search_index; DELETE FROM doc_dates;`);
      initialScan(db, skillSpec);
      initialScan(db, memorySpec);
      const skillCount = (db.prepare(`SELECT COUNT(*) AS n FROM skills`).get() as { n: number }).n;
      const memoryCount = (db.prepare(`SELECT COUNT(*) AS n FROM memory_docs`).get() as { n: number }).n;
      res.json({ skillCount, memoryCount });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/api/entries', (req: Request, res: Response) => {
    res.json(queryEntries(db, skillRepo, memoryRepo, identity, req));
  });

  router.get('/api/entries/:table/:id', (req: Request, res: Response) => {
    const { table, id } = req.params;
    if (table !== 'skills' && table !== 'memory_docs') {
      res.status(400).json({ error: 'table must be "skills" or "memory_docs"' });
      return;
    }
    if (!isEntryVisible(table, id)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    // memory_docs has no `id` column — its real identity IS source_path (the web UI's `id` for a
    // memory_docs row — see EntryRow/queryEntries above).
    const idCol = table === 'skills' ? 'id' : 'source_path';
    const row = db.prepare(`SELECT * FROM ${table} WHERE ${idCol} = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const tags = JSON.parse(row.tags as string);
    const trigger_phrases = row.trigger_phrases ? JSON.parse(row.trigger_phrases as string) : undefined;
    const attachments = row.attachments ? JSON.parse(row.attachments as string) : undefined;
    // A memory doc's cache row always looks fully populated even for a bare file (deriveFrontmatter's
    // fallback backfills id/key/etc — see sync.ts), so whether it actually has an authored
    // frontmatter block has to be checked on disk. This drives "Add frontmatter" (memory only —
    // write real values in for the first time) vs "Edit"/"Delete frontmatter". Skills have no such
    // fallback, so a skills row reaching this route always has real frontmatter; this stays false
    // only in the memory_docs case in practice.
    //
    // `raw_file` is the true on-disk content (frontmatter block + body) for the Raw view — distinct
    // from the cache's `body` column, which is always frontmatter-stripped (see readMarkdownFile).
    let has_frontmatter = true;
    let raw_file: string | undefined;
    try {
      raw_file = fs.readFileSync(row.source_path as string, 'utf-8');
      has_frontmatter = Object.keys(matter(raw_file).data).length > 0;
    } catch {
      // file unreadable/missing — treat as having frontmatter so the UI doesn't offer to "add"
      // one for a doc it can't actually reach; the existing edit/delete-doc paths will 404 instead.
    }
    // memory_docs rows have no `id` column of their own (see idCol above) — expose source_path as
    // `id` so the client's EntryDetail.id is always populated, matching the list endpoint's id.
    const responseId = table === 'skills' ? row.id : row.source_path;
    // Sharing an item (Phase 4's "Copy share link"/"Copy public link" buttons) only makes sense
    // for a doc that actually exists on folderfoo — a purely local doc has no remote counterpart
    // for folderfoo's own POST /share/POST /share-links to address. remoteInfo is the coordinates
    // detail-panel.ts needs to build that request (server/tenantId) and to compute the
    // folderfoo-relative path (folderPath + filename, via mirrorDir-relative math), without the
    // client needing its own copy of RemoteFolder-resolution logic.
    const remote = (table === 'skills' ? skillRepo : memoryRepo).listRemoteFolders().find((f) => f.name === row.folder);
    // `skill_group` is the raw column name (see SkillRow — "group" is a SQL reserved word); the
    // client-facing EntryDetail field is `group`, matching frontmatter.metadata.group's own name.
    const { skill_group, ...rowWithoutSkillGroup } = row;
    res.json({
      ...rowWithoutSkillGroup,
      id: responseId,
      group: table === 'skills' ? (skill_group ?? null) : undefined,
      tags,
      trigger_phrases,
      attachments,
      has_frontmatter,
      raw_file,
      remoteInfo: remote ? { server: remote.server, tenantId: remote.tenantId, folderPath: remote.folderPath, mirrorDir: remote.mirrorDir } : null,
    });
  });

  // Serves a single attachment file for a doc. Unauthenticated web-facing surface, so the
  // filename from the URL is validated with resolveWithinBase (same containment check
  // attachments/storage.ts uses when writing) to rule out path traversal before touching disk.
  router.get('/api/entries/:table/:id/attachments/:filename', (req: Request, res: Response) => {
    const { table, id, filename } = req.params;
    if (table !== 'skills' && table !== 'memory_docs') {
      res.status(400).json({ error: 'table must be "skills" or "memory_docs"' });
      return;
    }
    if (!filename) {
      res.status(400).json({ error: 'filename is required' });
      return;
    }
    if (!isEntryVisible(table, id)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const idCol = table === 'skills' ? 'id' : 'source_path';
    const row = db.prepare(`SELECT source_path FROM ${table} WHERE ${idCol} = ?`).get(id) as
      | { source_path: string }
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const dir = attachmentsDirFor(row.source_path, table === 'skills' ? 'skill' : 'memory');
    let filePath: string;
    try {
      filePath = resolveWithinBase(dir, undefined, filename);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    // Force a non-executable Content-Type and force-download disposition so a maliciously
    // named attachment (e.g. "notes.html" with an embedded <script>) can never render inline
    // in the browser and execute in this origin — Express/sendFile would otherwise infer
    // Content-Type from the file extension.
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) {
        res.status(404).json({ error: 'attachment not found' });
      }
    });
  });

  // Serves a single attachment for inline viewing (e.g. target="_blank" opening in a new tab
  // instead of downloading). Sends the real Content-Type with an "inline" disposition so the
  // browser renders it directly, but pairs that with `Content-Security-Policy: sandbox` — this
  // disables script execution, forms, and top-level navigation for the response regardless of
  // its Content-Type, so an HTML/SVG attachment can render inline without being able to run
  // script in this origin. Same path-containment check as the download route above.
  router.get('/api/entries/:table/:id/attachments/:filename/view', (req: Request, res: Response) => {
    const { table, id, filename } = req.params;
    if (table !== 'skills' && table !== 'memory_docs') {
      res.status(400).json({ error: 'table must be "skills" or "memory_docs"' });
      return;
    }
    if (!filename) {
      res.status(400).json({ error: 'filename is required' });
      return;
    }
    if (!isEntryVisible(table, id)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const idCol = table === 'skills' ? 'id' : 'source_path';
    const row = db.prepare(`SELECT source_path FROM ${table} WHERE ${idCol} = ?`).get(id) as
      | { source_path: string }
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const dir = attachmentsDirFor(row.source_path, table === 'skills' ? 'skill' : 'memory');
    let filePath: string;
    try {
      filePath = resolveWithinBase(dir, undefined, filename);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src *");
    const mimeType = guessMimeType(filename);

    // The client's detail-panel embeds this route in an <iframe> sized/backgrounded to match its
    // own light/dark theme (see .attachment-frame in detail-panel.ts) — but a plain text/JSON/XML
    // file sent as-is renders through the browser's own raw-text viewer, which is always
    // white-on-black-text regardless of that surrounding theme. Wrapping it in a tiny themed HTML
    // shell (same color-scheme/data-theme pattern as public/index.html, so a manual light/dark
    // pick in the app is honored, not just the OS preference) fixes that mismatch. Images/PDFs/etc.
    // are unaffected — the browser's native viewer for those is used as-is.
    if (isTextishMime(mimeType)) {
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        res.status(404).json({ error: 'attachment not found' });
        return;
      }
      const theme = req.query.theme === 'light' || req.query.theme === 'dark' ? req.query.theme : '';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
      res.send(renderTextAttachmentPage(content, theme));
      return;
    }

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
    res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) {
        res.status(404).json({ error: 'attachment not found' });
      }
    });
  });

  // Memory docs address by source_path (the web UI's `id` for a memory_docs row — see
  // client/detail-panel.ts) since filename alone is only unique per-folder, not globally. This
  // splits that back into the (folder, filename) pair MemoryRepository's methods take.
  function splitMemoryId(id: string): { folder: string; filename: string } {
    const split = memoryRepo.splitSourcePath(id);
    if (!split) throw new Error(`"${id}" is not under any configured memory folder`);
    return split;
  }

  // AttachmentRepository.add/remove take (kind, folder, docIdOrName) — for memory docs that's
  // splitMemoryId's (folder, filename) pair; for skills the route's own :id IS the name, with no
  // folder disambiguation needed here (same as the rename route above — a name collision across
  // two configured skill folders is out of scope for this route, matching every other skill route
  // in this file).
  function resolveAttachmentTarget(table: 'skills' | 'memory_docs', id: string): { kind: 'skill' | 'memory'; folder: string | undefined; docIdOrName: string } {
    if (table === 'skills') return { kind: 'skill', folder: undefined, docIdOrName: id };
    const { folder, filename } = splitMemoryId(id);
    return { kind: 'memory', folder, docIdOrName: filename };
  }

  // Uploads a new attachment onto a doc. Body is the raw file bytes (Content-Type is whatever the
  // browser sent, ignored beyond routing to this handler — the stored attachment's own served
  // Content-Type is always re-derived from its filename's extension at GET time, see guessMimeType
  // above). The filename comes from a query param, not a JSON field, since the body itself IS the
  // file content, not JSON — matches how the client's fetch call constructs this request (raw
  // File/Blob as the body, filename appended to the URL).
  router.post('/api/entries/:table/:id/attachments', express.raw({ type: '*/*', limit: ATTACHMENT_MAX_BYTES + 1024 }), async (req: Request, res: Response) => {
    const { table, id } = req.params;
    const filename = req.query.filename;
    if (table !== 'skills' && table !== 'memory_docs') {
      res.status(400).json({ error: 'table must be "skills" or "memory_docs"' });
      return;
    }
    if (!id) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    if (typeof filename !== 'string' || !filename) {
      res.status(400).json({ error: '?filename= query param is required' });
      return;
    }
    if (!isEntryVisible(table, id)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (!attachRepo) {
      res.status(501).json({ error: 'attachments are not available' });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: 'request body must be the raw file content' });
      return;
    }
    try {
      const { kind, folder, docIdOrName } = resolveAttachmentTarget(table, id);
      const entry = await attachRepo.add(kind, folder, docIdOrName, filename, req.body);
      res.json(entry);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.delete('/api/entries/:table/:id/attachments/:filename', async (req: Request, res: Response) => {
    const { table, id, filename } = req.params;
    if (table !== 'skills' && table !== 'memory_docs') {
      res.status(400).json({ error: 'table must be "skills" or "memory_docs"' });
      return;
    }
    if (!id || !filename) {
      res.status(400).json({ error: 'id and filename are required' });
      return;
    }
    if (!isEntryVisible(table, id)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (!attachRepo) {
      res.status(501).json({ error: 'attachments are not available' });
      return;
    }
    try {
      const { kind, folder, docIdOrName } = resolveAttachmentTarget(table, id);
      await attachRepo.remove(kind, folder, docIdOrName, filename);
      res.json({ removed: filename });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.patch('/api/entries/:table/:id/deprecated', async (req: Request, res: Response) => {
    const { table, id } = req.params;
    const { deprecated } = req.body as { deprecated?: boolean };
    if (table !== 'skills' && table !== 'memory_docs') {
      res.status(400).json({ error: 'table must be "skills" or "memory_docs"' });
      return;
    }
    if (!id) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    if (typeof deprecated !== 'boolean') {
      res.status(400).json({ error: 'body must be { deprecated: boolean }' });
      return;
    }
    try {
      if (table === 'skills') await skillRepo.update(id, { deprecated });
      else {
        const { folder, filename } = splitMemoryId(id);
        await memoryRepo.update(folder, filename, { deprecated });
      }
      res.json({ id, deprecated });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.post('/api/entries/:table/bulk/deprecated', async (req: Request, res: Response) => {
    const { table } = req.params;
    const { ids, deprecated } = req.body as { ids?: string[]; deprecated?: boolean };
    if (table !== 'skills' && table !== 'memory_docs') {
      res.status(400).json({ error: 'table must be "skills" or "memory_docs"' });
      return;
    }
    if (!Array.isArray(ids) || ids.length === 0 || typeof deprecated !== 'boolean') {
      res.status(400).json({ error: 'body must be { ids: string[], deprecated: boolean }' });
      return;
    }
    const results =
      table === 'skills' ? await skillRepo.bulkUpdate(ids, { deprecated }) : await memoryRepo.bulkUpdate(ids.map(splitMemoryId), { deprecated });
    res.json({ results });
  });

  // General frontmatter edit — covers both "edit an existing doc's fields" and "add frontmatter
  // to a bare file" (a bare memory doc already has a derived key from deriveFrontmatter, so
  // "add" is just this same call supplying real values). Memory `key` is editable here (update()
  // normalizes it). Skill `name` is not — SkillRepository.update() rejects it outright since
  // renaming requires a real folder move (see the rename route below).
  router.patch('/api/entries/:table/:id', async (req: Request, res: Response) => {
    const { table, id } = req.params;
    const { frontmatter } = req.body as { frontmatter?: Record<string, unknown> };
    if (table !== 'skills' && table !== 'memory_docs') {
      res.status(400).json({ error: 'table must be "skills" or "memory_docs"' });
      return;
    }
    if (!id) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    if (!frontmatter || typeof frontmatter !== 'object') {
      res.status(400).json({ error: 'body must be { frontmatter: object }' });
      return;
    }
    if (table === 'skills' && 'name' in frontmatter) {
      res.status(400).json({ error: 'name cannot be changed via this route — use rename' });
      return;
    }
    try {
      let updated;
      if (table === 'skills') {
        updated = await skillRepo.update(id, frontmatter);
      } else {
        const { folder, filename } = splitMemoryId(id);
        updated = await memoryRepo.update(folder, filename, frontmatter);
      }
      res.json(updated);
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.post('/api/entries/skills/:name/rename', async (req: Request, res: Response) => {
    const { name } = req.params;
    const { new_name } = req.body as { new_name?: string };
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (!new_name) {
      res.status(400).json({ error: 'body must be { new_name: string }' });
      return;
    }
    try {
      const renamed = await skillRepo.rename(name, new_name);
      res.json(renamed);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post('/api/entries/memory_docs/:id/rename', async (req: Request, res: Response) => {
    const { id } = req.params;
    const { new_filename } = req.body as { new_filename?: string };
    if (!id) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    if (!new_filename) {
      res.status(400).json({ error: 'body must be { new_filename: string }' });
      return;
    }
    try {
      const { folder, filename } = splitMemoryId(id);
      const renamed = await memoryRepo.rename(folder, filename, new_filename);
      res.json(renamed);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Memory docs only — skill frontmatter (name/description) is required by the agentskills.io
  // spec, so stripping it would produce a non-conformant SKILL.md no compliant agent can load.
  router.delete('/api/entries/memory_docs/:id/frontmatter', async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    try {
      const { folder, filename } = splitMemoryId(id);
      await memoryRepo.stripFrontmatter(folder, filename);
      res.json({ id, frontmatterRemoved: true });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  // `paused` is a local-only cache toggle (see SkillRepository/MemoryRepository#setPaused) — it
  // never touches the source file, so this goes through setPaused, not update()/bulkUpdate().
  router.patch('/api/entries/:table/:id/paused', async (req: Request, res: Response) => {
    const { table, id } = req.params;
    const { paused } = req.body as { paused?: boolean };
    if (table !== 'skills' && table !== 'memory_docs') {
      res.status(400).json({ error: 'table must be "skills" or "memory_docs"' });
      return;
    }
    if (!id) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    if (typeof paused !== 'boolean') {
      res.status(400).json({ error: 'body must be { paused: boolean }' });
      return;
    }
    const [result] =
      table === 'skills' ? await skillRepo.setPaused([id], paused) : await memoryRepo.setPaused([splitMemoryId(id)], paused);
    if (!result?.ok) {
      res.status(404).json({ error: result?.error ?? 'not found' });
      return;
    }
    res.json({ id, paused });
  });

  router.post('/api/entries/:table/bulk/paused', async (req: Request, res: Response) => {
    const { table } = req.params;
    const { ids, paused } = req.body as { ids?: string[]; paused?: boolean };
    if (table !== 'skills' && table !== 'memory_docs') {
      res.status(400).json({ error: 'table must be "skills" or "memory_docs"' });
      return;
    }
    if (!Array.isArray(ids) || ids.length === 0 || typeof paused !== 'boolean') {
      res.status(400).json({ error: 'body must be { ids: string[], paused: boolean }' });
      return;
    }
    const results = table === 'skills' ? await skillRepo.setPaused(ids, paused) : await memoryRepo.setPaused(ids.map(splitMemoryId), paused);
    res.json({ results });
  });

  router.delete('/api/entries/:table/:id', async (req: Request, res: Response) => {
    const { table, id } = req.params;
    if (table !== 'skills' && table !== 'memory_docs') {
      res.status(400).json({ error: 'table must be "skills" or "memory_docs"' });
      return;
    }
    if (!id) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    try {
      if (table === 'skills') {
        await skillRepo.delete(id);
      } else {
        const { folder, filename } = splitMemoryId(id);
        await memoryRepo.delete(folder, filename);
      }
      res.json({ deleted: id });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.post('/api/entries/:table/bulk/delete', async (req: Request, res: Response) => {
    const { table } = req.params;
    const { ids } = req.body as { ids?: string[] };
    if (table !== 'skills' && table !== 'memory_docs') {
      res.status(400).json({ error: 'table must be "skills" or "memory_docs"' });
      return;
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: 'body must be { ids: string[] }' });
      return;
    }
    const results = table === 'skills' ? await skillRepo.bulkDelete(ids) : await memoryRepo.bulkDelete(ids.map(splitMemoryId));
    res.json({ results });
  });

  router.get('/api/facets', (req: Request, res: Response) => {
    const type = (req.query.type as EntryType) ?? 'all';
    res.json(buildFacets(db, type));
  });

  router.get('/api/keys/suggest', (req: Request, res: Response) => {
    const q = (req.query.q as string | undefined)?.trim();
    if (!q) {
      res.json([]);
      return;
    }
    res.json(memoryRepo.suggestKeys(q, 8));
  });

  router.get('/api/health', (_req: Request, res: Response) => {
    res.json(buildHealth(db));
  });

  // Read-only view of the ephemeral in-memory channel layer (see channels/store.ts) — backs the
  // web UI's Channels view. Never touches disk; a channel that's swept for idling or never posted
  // to simply won't appear here.
  router.get('/api/channels', (_req: Request, res: Response) => {
    res.json(listChannels().map((c) => ({ name: c.name, lastActivityAt: c.lastActivityAt })));
  });

  router.get('/api/channels/:name', (req: Request, res: Response) => {
    const channel = req.params.name ? getChannel(req.params.name) : undefined;
    if (!channel) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ name: channel.name, content: channel.content, lastActivityAt: channel.lastActivityAt });
  });

  // Tells the client which folderfoo deployment (if any) to point the
  // "Connect folderfoo" flow and the page-level login widget at — see
  // config.ts's FolderfooMode doc comment for why this can't be inferred
  // from window.location.hostname the way mindfoo/bulletino/avotuner do.
  router.get('/api/config', (_req: Request, res: Response) => {
    res.json({ folderfooMode: config.folderfooMode, folderfooHost: config.folderfooHost });
  });

  router.get('/api/folders', async (_req: Request, res: Response) => {
    await pruneDeletedRemoteFolders();
    res.json({
      skill: skillRepo.listFoldersWithRemoteInfo().map((f) => ({ ...f, kind: 'skill' as const })),
      memory: memoryRepo.listFoldersWithRemoteInfo().map((f) => ({ ...f, kind: 'memory' as const })),
    });
  });

  /**
   * Checked on every web UI open/focus (this route is what the client's mount/load fetches) rather
   * than on every poll tick — a folder deleted server-side on folderfoo otherwise lingers forever
   * in mem-bucket's config/UI as a permanently-empty source: the poller's own reconcileDeletions
   * (remote-sync.ts) already correctly empties out a deleted remote folder's mirrored FILES on its
   * normal cycle, but nothing previously checked whether the folder itself still exists at all, as
   * opposed to whether its contents changed.
   *
   * Reuses folderfoo's existing GET /folders (via listFolderfooFolders) — one bulk call per
   * distinct folderfoo server returns every currently-existing folder path for the caller's OWN
   * tree, cheaper than a per-folder existence check would be for an account with many connected own
   * sources; these dedupe to one call per server (the common case — see credentials.ts, one login
   * per server). A source connected to a folder someone ELSE shared (RemoteFolder.owner set) is a
   * different case entirely — GET /folders without an owner never includes a shared folder at all,
   * so each of those is checked individually via owner+rootFolder instead (see the loop below). A
   * confirmed-gone folder is auto-removed via the same removeFolder()+removeFolderFromConfig() pair
   * the manual "✕ remove folder" route above already uses — this never touches a folder's contents,
   * only mem-bucket's own registration of it (see removeFolder's doc comment: it drops DB rows + the
   * local mirror dir, never anything the folder's write path would consider "the user's own content"
   * beyond that mirror).
   *
   * Deliberately does NOT run at write time: a write against a since-deleted remote folder instead
   * fails loudly with its own specific error (see repository create()/update()'s remote-push
   * handling) rather than silently recreating the folder — auto-recreating on write would silently
   * undo a deletion the user may have made deliberately, with no visibility that it happened.
   *
   * Only ever checks/prunes sources connected under the CURRENTLY LOGGED-IN identity (see the
   * isFolderVisible guard in the loop below) — credentials.ts stores exactly one JWT per server, so
   * a different identity's source checked against the wrong credential would always look
   * "confirmed gone" and get silently deleted the moment ANY other identity's login triggered a
   * /api/folders load. This was a real, confirmed bug: switching from user A to user B made B's own
   * previously-connected folders vanish, because A's login (or nobody's) was the only credential on
   * hand to check them with.
   */
  async function pruneDeletedRemoteFolders(): Promise<void> {
    const ownFolderSources: Array<{ kind: 'skill' | 'memory'; name: string; folderPath: string; server: string; tenantId: string }> = [];
    const sharedFolderSources: Array<{ kind: 'skill' | 'memory'; name: string; folderPath: string; server: string; tenantId: string; owner: string }> = [];
    const currentIdentity = identity.current();
    for (const [kind, repo] of [
      ['skill', skillRepo],
      ['memory', memoryRepo],
    ] as const) {
      for (const remote of repo.listRemoteFolders()) {
        // Only ever check a source connected under the IDENTITY CURRENTLY LOGGED IN — credentials.ts
        // stores exactly one JWT per server, overwritten on every login, so a source belonging to a
        // different identity (e.g. bbb's own folder, checked right after anatoli logs in) would be
        // checked with the WRONG credential: that credential's owner's tree obviously never contains
        // the other identity's folder, so it would always look "confirmed gone" and get silently
        // deleted the moment ANY other identity's login triggered a /api/folders load — exactly the
        // "my folder disappeared after switching users" bug this skip fixes. A source that doesn't
        // match is left untouched here entirely; it re-enters this check once its own identity logs
        // back in and can be verified with the right credential again.
        if (!isFolderVisible(remote, currentIdentity)) continue;
        if (remote.owner) {
          sharedFolderSources.push({ kind, name: remote.name, folderPath: remote.folderPath, server: remote.server, tenantId: remote.tenantId, owner: remote.owner });
        } else {
          ownFolderSources.push({ kind, name: remote.name, folderPath: remote.folderPath, server: remote.server, tenantId: remote.tenantId });
        }
      }
    }

    const doRemove = (source: { kind: 'skill' | 'memory'; name: string }) => {
      const repo = source.kind === 'skill' ? skillRepo : memoryRepo;
      try {
        repo.removeFolder(source.name);
        removeFolderFromConfig(config, source.kind, source.name);
      } catch (err) {
        console.error(`[memory-bucket] failed to auto-remove deleted remote folder "${source.name}":`, err);
      }
    };

    // Own-folder sources: unchanged from before — GET /folders without an owner returns the
    // caller's own flat tree in one call per distinct server (sources sharing one server share one
    // login/tenant, so any one source's tenantId is representative for the whole group).
    if (ownFolderSources.length > 0) {
      const byServer = new Map<string, typeof ownFolderSources>();
      for (const source of ownFolderSources) {
        const list = byServer.get(source.server) ?? [];
        list.push(source);
        byServer.set(source.server, list);
      }
      for (const [server, sources] of byServer) {
        let livePaths: Set<string>;
        try {
          const folders = await listFolderfooFolders(server, config.baseDir, sources[0]!.tenantId);
          livePaths = new Set(folders.map((f) => f.path));
        } catch {
          continue; // not logged in, network blip, etc. — "couldn't check" is not "confirmed gone"
        }
        for (const source of sources) {
          if (!livePaths.has(source.folderPath)) doRemove(source);
        }
      }
    }

    // Shared-folder sources: GET /folders without an owner never includes them at all (a shared
    // folder isn't part of the caller's own tree — see listFolders' doc comment), so the own-folder
    // check above would wrongly treat every one of these as "confirmed gone" on every single
    // /api/folders load if it ran against them. Each is checked individually instead, via
    // owner+rootFolder=its own folderPath — this is exactly what the share grant is for, so success
    // confirms both "the folder still exists" AND "the share still stands"; a 403 (share revoked) or
    // 404 (folder deleted) confirms gone, while any OTHER failure (not logged in, network blip)
    // again means "couldn't check," not "confirmed gone."
    for (const source of sharedFolderSources) {
      try {
        await listFolderfooFolders(source.server, config.baseDir, source.tenantId, { owner: source.owner, rootFolder: source.folderPath });
      } catch (err) {
        if (err instanceof FolderfooRequestError && (err.status === 403 || err.status === 404)) doRemove(source);
      }
    }
  }

  // Resolves a file opened via folderfoo's own File Open dialog
  // (<folderfoo-profile-circle>'s "folderfoo-file-open" event) back to a
  // memory-bucket doc, so the web UI can select it in the right panel —
  // and, since that panel's edits already push through to folderfoo for
  // any doc whose folder resolves to a remote source (see PATCH
  // /api/entries/:table/:id), frontmatter changes made there persist to
  // the cloud automatically once the right doc is open, no separate wiring
  // needed for that half.
  //
  // Only works when the opened file's (server, tenantId, folderPath) falls
  // under a folder ALREADY connected as a remote source here — folderfoo's
  // File Open dialog browses the user's whole folderfoo tree, not just
  // connected folders, so a miss (file from an unconnected folder) is a
  // real, expected case the client surfaces as a clear message, not
  // silently swallowed.
  router.post('/api/folderfoo/resolve-open', (req: Request, res: Response) => {
    const { server, tenantId, folderPath, name } = req.body as {
      server?: string;
      tenantId?: string;
      folderPath?: string;
      name?: string;
    };
    if (!server || !tenantId || !name) {
      res.status(400).json({ error: 'server, tenantId, and name are required' });
      return;
    }
    const openedFolderPath = folderPath || '';

    for (const [table, repo] of [
      ['skills', skillRepo],
      ['memory_docs', memoryRepo],
    ] as const) {
      for (const remote of repo.listRemoteFolders()) {
        if (remote.server !== server || remote.tenantId !== tenantId) continue;
        // The opened file's folder must be remote.folderPath itself, or nested inside it.
        const sourceFolder = remote.folderPath;
        let withinFolder: string;
        if (openedFolderPath === sourceFolder) {
          withinFolder = '';
        } else if (sourceFolder === '' ) {
          withinFolder = openedFolderPath;
        } else if (openedFolderPath.startsWith(`${sourceFolder}/`)) {
          withinFolder = openedFolderPath.slice(sourceFolder.length + 1);
        } else {
          continue; // not under this source
        }

        const sourcePath =
          table === 'skills'
            ? path.join(remote.mirrorDir, withinFolder, name, 'SKILL.md')
            : path.join(remote.mirrorDir, withinFolder, `${name}.md`);
        // memory_docs has no `id` column — source_path IS its id (see idCol elsewhere in this file).
        const idCol = table === 'skills' ? 'id' : 'source_path';
        const row = db.prepare(`SELECT ${idCol} AS id FROM ${table} WHERE source_path = ?`).get(sourcePath) as { id: string } | undefined;
        if (row) {
          res.json({ table, id: row.id });
          return;
        }
        // Matched the connected source but no cache row yet (e.g. the
        // poller hasn't picked it up since it was just created elsewhere) —
        // a different, more specific miss than "not connected at all".
        res.status(404).json({ error: `matched remote source "${remote.name}", but no cached doc found yet for this file — try Resync` });
        return;
      }
    }
    res.status(404).json({
      error: `this file's folder isn't connected in memory-bucket yet — add it as a remote source first`,
    });
  });

  router.post('/api/folders', (req: Request, res: Response) => {
    const { kind, name, path: dirPath } = req.body as { kind?: string; name?: string; path?: string };
    if (kind !== 'skill' && kind !== 'memory') {
      res.status(400).json({ error: 'kind must be "skill" or "memory"' });
      return;
    }
    if (!dirPath || !path.isAbsolute(dirPath)) {
      res.status(400).json({ error: 'path must be an absolute directory path' });
      return;
    }
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      res.status(400).json({ error: `not a directory: ${dirPath}` });
      return;
    }
    const folderName = sanitizeFolderName(name || path.basename(dirPath));
    if (!folderName) {
      res.status(400).json({ error: 'could not derive a valid folder name — provide one explicitly' });
      return;
    }

    const repo = kind === 'skill' ? skillRepo : memoryRepo;
    try {
      repo.addFolder({ name: folderName, path: dirPath });
      saveFolder(config, kind, { name: folderName, path: dirPath });
      res.json({ name: folderName, path: dirPath, kind });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  // Persists a folderfoo JWT the browser already obtained (see
  // credentials.ts — keyed by server URL, so every remote source pointing
  // at the same folderfoo deployment shares this one login). The actual
  // login UI is folderfoo's own <folderfoo-profile-circle> widget,
  // dynamically imported into the client page exactly like every other
  // folderfoo-consuming app (bulletino, mindfoo) — that widget stores its
  // token in THIS page's localStorage (browser-only), so the client reads
  // it back out and POSTs it here to also persist it server-side, where
  // the Node process (poller, live reads/writes) actually needs it. This
  // avoids a second username/password prompt: one login, reused for both
  // the browser tab and the backend.
  router.post('/api/folderfoo/login', async (req: Request, res: Response) => {
    const { server, token } = req.body as { server?: string; token?: string };
    if (!server || !token) {
      res.status(400).json({ error: 'server and token are required' });
      return;
    }
    setCredential(config.baseDir, server, token);
    // Updates the process-wide current identity (see identity.ts) - the most
    // recent login from ANY browser tab becomes "current" for the whole
    // process, including MCP tool calls. Logging in doesn't itself change
    // which entries are stamped with this identity (that only happens at
    // connect-time, see /api/remote-folders below) - it just changes which
    // already-stamped entries become visible.
    identity.setUsername(decodeUsername(token));
    res.json({ connected: true, server });
    // Force-resyncs every remote source now that this identity's folders are
    // visible again, rather than leaving them showing whatever was last
    // synced until the next fixed poll tick or tab-focus resync. Fired after
    // responding (best-effort, same posture as the rest of this route) so
    // login doesn't wait on a round trip to every remote source.
    Promise.all([remotePollers?.skill?.resyncAll(), remotePollers?.memory?.resyncAll()]).catch(() => {});
  });

  // Signals that the browser's folderfoo login session just ended (the page
  // detects folderfoo's own auth-change event going to logged-out) - clears
  // the process-wide current identity, which hides every remote folder
  // (everywhere: web UI and MCP tool results alike) until a new login
  // stamps a fresh identity via the route above. No server/token body: this
  // is "the browser lost its session," not scoped to one server.
  router.post('/api/folderfoo/logout', (_req: Request, res: Response) => {
    identity.clearUsername();
    res.json({ connected: false });
  });

  // Server-sent-events stream of the current identity, so an open browser
  // tab's folder list updates the instant a login/logout happens anywhere
  // (this tab or another one) - no polling, no page reload. Sends the
  // current value immediately on connect, then again on every change.
  router.get('/api/folderfoo/identity-stream', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (current: ReturnType<IdentityTracker['current']>) => res.write(`data: ${JSON.stringify(current)}\n\n`);
    send(identity.current());
    const unsubscribe = identity.onIdentityChange(send);
    req.on('close', unsubscribe);
  });

  // Lists folderfoo folders for the "connect a folder" picker, once already logged in to `server`
  // (via the route above). Own folders by default; pass `owner`+`rootFolder` (a folder from
  // GET /api/folderfoo/shared-folders below) to browse INTO a folder someone else shared instead —
  // folderfoo's own GET /folders gates that via the same hasAccess check every other shared read
  // uses, so this route just forwards the params through rather than re-checking anything itself.
  router.get('/api/folderfoo/folders', async (req: Request, res: Response) => {
    const server = req.query.server as string | undefined;
    const tenantId = req.query.tenantId as string | undefined;
    const owner = req.query.owner as string | undefined;
    const rootFolder = req.query.rootFolder as string | undefined;
    if (!server || !tenantId) {
      res.status(400).json({ error: 'server and tenantId query params are required' });
      return;
    }
    try {
      const folders = await listFolderfooFolders(server, config.baseDir, tenantId, { owner, rootFolder });
      res.json(folders);
    } catch (err) {
      res.status(401).json({ error: (err as Error).message });
    }
  });

  // Lists whole FOLDERS (not individual memory docs/skills — see /api/shared-items above for that)
  // someone has shared directly with the caller, across every owner — backs the "connect a folder"
  // picker's "Shared with me" source, so a folder like bbbmemz shows up as something to connect
  // instead of only being visible via folderfoo's own File Open UI. Filters getSharedWithMe's
  // combined file+folder list down to type:'folder' — a shared FILE has no meaning here, that's the
  // item-level sharing feature instead.
  router.get('/api/folderfoo/shared-folders', async (req: Request, res: Response) => {
    const server = req.query.server as string | undefined;
    const tenantId = req.query.tenantId as string | undefined;
    if (!server || !tenantId) {
      res.status(400).json({ error: 'server and tenantId query params are required' });
      return;
    }
    try {
      const shared = await getSharedWithMe(server, config.baseDir, tenantId);
      res.json(shared.filter((entry) => entry.type === 'folder').map((entry) => ({ owner: entry.owner, path: entry.name, role: entry.role })));
    } catch (err) {
      res.status(401).json({ error: (err as Error).message });
    }
  });

  // Registers a REMOTE (folderfoo) source — the connect-a-folder counterpart
  // to POST /api/folders above, which only ever handles local filesystem
  // paths. Creates the local mirror directory, registers it with the
  // repository (so it starts watching/scanning like any local folder), then
  // immediately triggers one poll so content shows up without waiting for
  // the first interval tick.
  router.post('/api/remote-folders', async (req: Request, res: Response) => {
    const { kind, name, server, tenantId, folderPath, owner } = req.body as {
      kind?: string;
      name?: string;
      server?: string;
      tenantId?: string;
      folderPath?: string;
      // Set when connecting a folder someone ELSE shared (see /api/folderfoo/shared-folders) rather
      // than one of the caller's own — carried onto RemoteFolder.owner so every subsequent
      // read/write against this source addresses the OWNER's tree, not the caller's own.
      owner?: string;
    };
    if (kind !== 'skill' && kind !== 'memory') {
      res.status(400).json({ error: 'kind must be "skill" or "memory"' });
      return;
    }
    if (!server || !tenantId || folderPath === undefined) {
      res.status(400).json({ error: 'server, tenantId, and folderPath are required' });
      return;
    }
    const folderName = sanitizeFolderName(name || folderPath.split('/').filter(Boolean).pop() || tenantId);
    if (!folderName) {
      res.status(400).json({ error: 'could not derive a valid folder name — provide one explicitly' });
      return;
    }
    // A folder can only be connected while logged in — the identity it's
    // stamped with (see identity.ts) is exactly the one that just made the
    // "connect a folder" picker possible in the first place.
    const current = identity.current();
    if (!current.username) {
      res.status(401).json({ error: 'not logged in to folderfoo' });
      return;
    }

    const repo = kind === 'skill' ? skillRepo : memoryRepo;
    const spec = kind === 'skill' ? skillSpec : memorySpec;
    try {
      // Resolved FIRST (before deriving mirrorDir) — auto-suffixes the requested name when it
      // collides with a folder connected under a DIFFERENT folderfoo login (e.g. two different users
      // each naturally wanting "bbbmemz"), still rejecting a collision against the CALLER's own
      // identity (a genuine naming mistake) — see resolveAvailableName's own doc comment. Everything
      // downstream (mirrorDir, the saved config entry, the response, the kind-mismatch check) uses
      // this resolved name, never the originally-requested one, so nothing reads/writes to a path
      // computed from a name that ended up not being what actually got connected.
      const resolvedName = repo.resolveAvailableName(folderName, current.username);
      const mirrorDir = mirrorDirFor(config.baseDir, current.mode, current.username, resolvedName, owner);
      const remote = { name: resolvedName, server, tenantId, folderPath, mirrorDir, mode: current.mode, username: current.username, owner };
      repo.registerRemoteFolder(remote);
      saveRemoteFolder(config, kind, { name: resolvedName, server, tenantId, folderPath, mode: current.mode, username: current.username, owner });
      await pollOne(db, spec, remote, config.baseDir);
      res.json({ name: resolvedName, server, tenantId, folderPath, kind, owner, kindMismatchWarning: detectKindMismatch(kind, mirrorDir) });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  // Cheap best-effort "did the user pick the wrong kind" heuristic, checked once right after connect
  // (content is already mirrored locally from the pollOne call above, so this is a local directory
  // walk, not another network round trip) — surfaced to the client as a dismissible warning, never a
  // hard block, since a folder can legitimately be empty or genuinely mixed. A skill's remote content
  // always lives under a fixed literal filename "SKILL.md" (see remoteFilename's own doc comment in
  // sync.ts — skills push under that name regardless of local filename), so "every .md file mirrored
  // is literally named SKILL.md" is a strong, cheap skill-shaped signal; a memory folder's files keep
  // their own varied names and are never named exactly that. Returns undefined (no warning) for an
  // empty folder — nothing synced yet is not evidence of anything.
  function detectKindMismatch(kind: 'skill' | 'memory', mirrorDir: string): string | undefined {
    let total = 0;
    let skillNamed = 0;
    for (const file of walkMarkdownFiles(mirrorDir)) {
      total++;
      if (path.basename(file) === 'SKILL.md') skillNamed++;
    }
    if (total === 0) return undefined;
    if (kind === 'memory' && skillNamed === total) {
      return `This folder looks like it contains skills (every file is a SKILL.md), not memory docs — you connected it as a memory folder. Remove and reconnect it as a skill folder instead.`;
    }
    if (kind === 'skill' && skillNamed === 0) {
      return `This folder looks like it contains memory docs, not skills (no SKILL.md files found) — you connected it as a skill folder. Remove and reconnect it as a memory folder instead.`;
    }
    return undefined;
  }

  // Triggers one immediate out-of-cycle poll for a single remote source —
  // backs the web UI's per-source "resync now" action, so a user who just
  // saved something remotely doesn't have to wait out the fixed poll
  // interval to see it reflected locally.
  router.post('/api/remote-folders/:kind/:name/resync', async (req: Request, res: Response) => {
    const { kind, name } = req.params;
    if (kind !== 'skill' && kind !== 'memory') {
      res.status(400).json({ error: 'kind must be "skill" or "memory"' });
      return;
    }
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const handle = kind === 'skill' ? remotePollers?.skill : remotePollers?.memory;
    if (!handle) {
      res.status(404).json({ error: `no remote ${kind} sources configured` });
      return;
    }
    try {
      await handle.resyncNow(name);
      res.json({ resynced: name, kind });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  // Lightweight "check every remote source for changes right now" — unlike
  // rebuild-cache (which wipes the WHOLE local cache and re-scans
  // everything, including local-only folders), this only force-resyncs the
  // remote sources' own incremental pull+reconcile, so it's cheap enough to
  // call on every tab focus without the user needing to hit rebuild-cache
  // by hand just to see a remote change (e.g. a deletion) sooner than the
  // fixed poll interval.
  router.post('/api/remote-folders/resync-all', async (_req: Request, res: Response) => {
    try {
      await Promise.all([remotePollers?.skill?.resyncAll(), remotePollers?.memory?.resyncAll()]);
      res.json({ resynced: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // "Shared with me" (item-level shares, not whole connected folders — see
  // config.ts's RemoteFolder for that separate mechanism). Deliberately NOT
  // called anywhere automatically (no poller, no auto-refresh on load/focus)
  // — GET only ever returns whatever's currently in shared_items, exactly as
  // fresh as the last time POST /refresh below was explicitly clicked. This
  // is the settled "refresh is a UI-only concept" design.
  router.get('/api/shared-items', (_req: Request, res: Response) => {
    res.json(listSharedItems(db));
  });

  // Turns a redeemed share-link/public-link (client/share-accept.ts's onSharedItemAccepted) into a
  // new shared_items row and pulls its content immediately — this one fetch is the explicit act of
  // accepting a share, not the "refresh is UI-only" background sync (see addSharedItem's own doc
  // comment). Called once per accept, never on a timer.
  router.post('/api/shared-items/accept', async (req: Request, res: Response) => {
    const { owner, path: itemPath, originId, kind, role, server, tenantId } = req.body || {};
    if (!owner || !itemPath || !originId || (kind !== 'memory' && kind !== 'skill') || !server || !tenantId) {
      res.status(400).json({ error: 'owner, path, originId, kind, server, and tenantId are required' });
      return;
    }
    try {
      await addSharedItem(db, config.baseDir, skillSpec, memorySpec, {
        owner,
        path: itemPath,
        originId,
        kind,
        role: role === 'editor' ? 'editor' : 'member',
        server,
        tenantId,
      });
      res.json({ accepted: originId });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // "Fork to mine" — writes an INDEPENDENT copy of a shared item into a folder the caller owns
  // (local bucket, or a remote folder they're connected to), via the same MemoryRepository.create/
  // SkillRepository.create path any other new doc goes through (collision-avoided by
  // uniqueFilename for memory, or a clean "already exists" error for skills — no separate fork-
  // specific write path). The fork carries NO shared_items linkage afterward: once created, it's
  // indistinguishable from a doc the user authored themselves — editing it never touches the
  // original owner's copy, unlike a live role:'editor' share.
  router.post('/api/shared-items/:originId/fork', async (req: Request, res: Response) => {
    const { originId } = req.params;
    const { folder } = req.body || {};
    if (!originId) {
      res.status(400).json({ error: 'originId is required' });
      return;
    }
    const item = getSharedItem(db, originId);
    if (!item) {
      res.status(404).json({ error: 'shared item not found' });
      return;
    }
    try {
      const parsed = readMarkdownFile<Record<string, unknown>>(item.mirror_path);
      if (item.kind === 'memory') {
        const fm = parsed.frontmatter as Partial<MemoryFrontmatter>;
        const doc = await memoryRepo.create({
          filename: path.basename(item.mirror_path),
          key: fm.key ?? path.basename(item.mirror_path, '.md'),
          key_type: fm.key_type ?? 'freeform',
          doc_type: fm.doc_type ?? 'other',
          description: fm.description ?? path.basename(item.mirror_path, '.md'),
          body: parsed.body,
          tags: fm.tags,
          status: fm.status,
          related_to: fm.related_to,
          folder,
        });
        res.json({ forked: true, table: 'memory_docs', id: doc.source_path });
      } else {
        const fm = parsed.frontmatter as Partial<SkillFrontmatter>;
        if (!fm.name || !fm.description) {
          res.status(500).json({ error: 'shared skill is missing required name/description frontmatter' });
          return;
        }
        const doc = await skillRepo.create(
          { name: fm.name, description: fm.description, tags: fm.tags, trigger_phrases: fm.trigger_phrases },
          parsed.body,
          undefined,
          folder
        );
        res.json({ forked: true, table: 'skills', id: doc.name });
      }
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // The recycle-icon button in the "Shared with me" panel calls this — also the only way a direct
  // (non-link) share ever gets discovered and added in the first place, since folderfoo's Share
  // Manager UI and bucket_share_item grant access with no redeem event for this app to react to
  // (see refreshSharedItems' own doc comment). Polls every server+tenant the caller is connected to
  // via a remote folder, not just ones already represented in shared_items, so this works even
  // before the very first share has been accepted.
  router.post('/api/shared-items/refresh', async (_req: Request, res: Response) => {
    try {
      const remoteFolders = [...skillRepo.listRemoteFolders(), ...memoryRepo.listRemoteFolders()].map((f) => ({
        server: f.server,
        tenantId: f.tenantId,
      }));
      const summary = await refreshSharedItems(db, config.baseDir, skillSpec, memorySpec, remoteFolders);
      res.json(summary);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Dismisses a revoked row from view — no-ops for a still-active share (use
  // the refresh button to detect revocation in the first place, this only
  // clears a row already marked revoked).
  router.delete('/api/shared-items/:originId', (req: Request, res: Response) => {
    const { originId } = req.params;
    if (!originId) {
      res.status(400).json({ error: 'originId is required' });
      return;
    }
    dismissRevokedSharedItem(db, originId);
    res.json({ dismissed: originId });
  });

  // Resolves a table/id EntryDetail into the folderfoo coordinates (folderPath, name — the
  // "name" folderfoo actually stores it under) needed to call shareWithUser/createShareLink/
  // createPublicLink below. Shared by all three POST routes so the "must be remote, must
  // exist under a connected folder" validation lives in exactly one place. Returns null if the
  // doc isn't remote (this app's own local-only docs have nothing on folderfoo to address).
  const resolveShareTargetHere = (table: 'skills' | 'memory_docs', id: string) => resolveShareTarget(db, { skill: skillRepo, memory: memoryRepo }, table, id);

  router.post('/api/entries/:table/:id/share', async (req: Request, res: Response) => {
    const { table, id } = req.params;
    if (table !== 'skills' && table !== 'memory_docs') {
      res.status(400).json({ error: 'table must be "skills" or "memory_docs"' });
      return;
    }
    if (!id) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    const { username, role } = req.body || {};
    if (!username) {
      res.status(400).json({ error: 'username is required' });
      return;
    }
    const target = resolveShareTargetHere(table, id);
    if (!target) {
      res.status(400).json({ error: 'this doc is not connected to a folderfoo remote folder' });
      return;
    }
    try {
      await shareWithUser(target.server, config.baseDir, target.tenantId, target.folderPath, target.name, username, target.kind, role === 'editor' ? 'editor' : 'member');
      res.json({ shared: true, username });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/api/entries/:table/:id/share/:username', async (req: Request, res: Response) => {
    const { table, id, username } = req.params;
    if (table !== 'skills' && table !== 'memory_docs') {
      res.status(400).json({ error: 'table must be "skills" or "memory_docs"' });
      return;
    }
    if (!id || !username) {
      res.status(400).json({ error: 'id and username are required' });
      return;
    }
    const target = resolveShareTargetHere(table, id);
    if (!target) {
      res.status(400).json({ error: 'this doc is not connected to a folderfoo remote folder' });
      return;
    }
    try {
      await unshareWithUser(target.server, config.baseDir, target.tenantId, target.folderPath, target.name, username);
      res.json({ unshared: true, username });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/api/entries/:table/:id/share-link', async (req: Request, res: Response) => {
    const { table, id } = req.params;
    if (table !== 'skills' && table !== 'memory_docs') {
      res.status(400).json({ error: 'table must be "skills" or "memory_docs"' });
      return;
    }
    if (!id) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    const target = resolveShareTargetHere(table, id);
    if (!target) {
      res.status(400).json({ error: 'this doc is not connected to a folderfoo remote folder' });
      return;
    }
    try {
      const link = await createShareLink(target.server, config.baseDir, target.tenantId, target.folderPath, target.name, target.kind);
      res.json(link);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/api/entries/:table/:id/public-link', async (req: Request, res: Response) => {
    const { table, id } = req.params;
    if (table !== 'skills' && table !== 'memory_docs') {
      res.status(400).json({ error: 'table must be "skills" or "memory_docs"' });
      return;
    }
    if (!id) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    const target = resolveShareTargetHere(table, id);
    if (!target) {
      res.status(400).json({ error: 'this doc is not connected to a folderfoo remote folder' });
      return;
    }
    try {
      const link = await createPublicLink(target.server, config.baseDir, target.tenantId, target.folderPath, target.name, target.kind);
      res.json(link);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/api/folders/:kind/:name', (req: Request, res: Response) => {
    const { kind, name } = req.params;
    if (kind !== 'skill' && kind !== 'memory') {
      res.status(400).json({ error: 'kind must be "skill" or "memory"' });
      return;
    }
    if (!name) {
      res.status(400).json({ error: 'folder name is required' });
      return;
    }
    const repo = kind === 'skill' ? skillRepo : memoryRepo;
    try {
      repo.removeFolder(name);
      removeFolderFromConfig(config, kind, name);
      res.json({ removed: name, kind });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  /**
   * Reacts to the embedded File Open dialog's `folderfoo-folder-changed` event (rename/move, see
   * the client's mem-bucket-app.ts listener) — repoints any registered remote source whose
   * folderPath is the renamed folder itself or nested under it, in BOTH repos (a folderPath rename
   * has no kind of its own; the same folderfoo path could in principle be connected as a skill
   * source, a memory source, or both, independently). Unlike DELETE /api/folders above, this never
   * removes anything — same content, same local mirror, just a different remote path going
   * forward — matching folderfoo's own rename semantics.
   *
   * `server` scopes the match: a folderPath string is only meaningful within one folderfoo
   * deployment, and a source connected to a different server sharing the same path string by
   * coincidence must not be touched.
   */
  router.post('/api/folders/renamed', (req: Request, res: Response) => {
    const { server, oldPath, newPath } = req.body as { server?: string; oldPath?: string; newPath?: string };
    if (!server || oldPath === undefined || !newPath) {
      res.status(400).json({ error: 'server, oldPath, and newPath are required' });
      return;
    }
    const updated: Array<{ kind: 'skill' | 'memory'; name: string; folderPath: string }> = [];
    for (const [kind, repo] of [
      ['skill', skillRepo],
      ['memory', memoryRepo],
    ] as const) {
      for (const remote of repo.listRemoteFolders()) {
        if (remote.server !== server) continue;
        if (remote.folderPath !== oldPath && !(oldPath && remote.folderPath.startsWith(`${oldPath}/`))) continue;
        repo.updateRemoteFolderPath(remote.name, oldPath, newPath);
        updateRemoteFolderPathInConfig(config, kind, remote.name, oldPath, newPath);
        updated.push({ kind, name: remote.name, folderPath: repo.listRemoteFolders().find((f) => f.name === remote.name)!.folderPath });
      }
    }
    res.json({ updated });
  });

  router.get('/api/fs/list', (req: Request, res: Response) => {
    const requested = (req.query.path as string | undefined)?.trim();
    const dirPath = requested ? path.resolve(requested) : os.homedir();

    let stat: fs.Stats;
    try {
      stat = fs.statSync(dirPath);
    } catch {
      res.status(400).json({ error: `path not found: ${dirPath}` });
      return;
    }
    if (!stat.isDirectory()) {
      res.status(400).json({ error: `not a directory: ${dirPath}` });
      return;
    }

    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (err) {
      res.status(403).json({ error: (err as Error).message });
      return;
    }

    const showHidden = req.query.hidden === '1' || req.query.hidden === 'true';
    const entries = dirents
      .filter((d) => d.isDirectory() && (showHidden || !d.name.startsWith('.')))
      .map((d) => ({ name: d.name, path: path.join(dirPath, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const parent = path.dirname(dirPath) !== dirPath ? path.dirname(dirPath) : null;
    res.json({ path: dirPath, parent, entries });
  });

  router.post('/api/fs/mkdir', (req: Request, res: Response) => {
    const { path: parentPath, name } = req.body as { path?: string; name?: string };
    if (!parentPath || !path.isAbsolute(parentPath)) {
      res.status(400).json({ error: 'path must be an absolute directory path' });
      return;
    }
    if (!name || name.trim() !== name || name.includes('/') || name === '.' || name === '..') {
      res.status(400).json({ error: 'invalid folder name' });
      return;
    }
    if (!fs.existsSync(parentPath) || !fs.statSync(parentPath).isDirectory()) {
      res.status(400).json({ error: `not a directory: ${parentPath}` });
      return;
    }
    const newDirPath = path.join(parentPath, name);
    if (fs.existsSync(newDirPath)) {
      res.status(409).json({ error: `already exists: ${newDirPath}` });
      return;
    }
    try {
      fs.mkdirSync(newDirPath);
      res.json({ path: newDirPath, name });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
