import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Router, Request, Response } from 'express';
import express from 'express';
import matter from 'gray-matter';
import type Database from 'better-sqlite3';
import type { BucketConfig } from '../config.js';
import { saveFolder, saveRemoteFolder, removeFolder as removeFolderFromConfig, sanitizeFolderName, mirrorDirFor } from '../config.js';
import type { SkillRepository } from '../skills/repository.js';
import { stripKey, type MemoryRepository } from '../memory/repository.js';
import { initialScan, type TableSyncSpec } from '../store/sync.js';
import { sanitizeFtsQuery } from '../store/search.js';
import { resolveWithinBase } from '../store/safe-path.js';
import { attachmentsDirFor, guessMimeType } from '../attachments/storage.js';
import { listFolders as listFolderfooFolders } from '../remote/folderfoo-client.js';
import { setCredential } from '../remote/credentials.js';
import { pollOne, type RemotePollerHandle } from '../remote/remote-sync.js';

type EntryType = 'skill' | 'memory' | 'all';

interface EntryRow {
  _table: 'skills' | 'memory_docs';
  id: string;
  name: string; // skill name or memory key, whichever reads better in a list
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

function tagWhereClause(tags: string[]): { clause: string; params: string[] } {
  if (tags.length === 0) return { clause: '', params: [] };
  const clauses = tags.map(() => `EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)`);
  return { clause: ` AND ${clauses.join(' AND ')}`, params: tags };
}

function queryEntries(db: Database.Database, memoryRepo: MemoryRepository, req: Request): EntryRow[] {
  const type = (req.query.type as EntryType) ?? 'all';
  const tags = asArray(req.query.tag);
  const statuses = asArray(req.query.status);
  const owners = asArray(req.query.owner);
  const docTypes = asArray(req.query.doc_type);
  const keyTypes = asArray(req.query.key_type);
  const folders = asArray(req.query.folder);
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
  const matchedIds: { skills: Set<string>; memory_docs: Set<string> } | null = q ? matchSearch(db, q) : null;
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
        { tags, statuses, owners, docTypes: [], keyTypes: [], folders, keys: [], deprecated, paused },
        intersectIds(matchedIds?.skills, dateIds?.skills)
      )
    );
  }
  if (type === 'memory' || type === 'all') {
    results.push(
      ...queryTable(
        db,
        'memory_docs',
        { tags, statuses, owners: [], docTypes, keyTypes, folders, deprecated, paused, keys: keyMatch ? [keyMatch.key] : [] },
        keyMatch ? undefined : intersectIds(matchedIds?.memory_docs, dateIds?.memory_docs)
      )
    );
  }

  const sort = (req.query.sort as string | undefined) ?? 'mtime_desc';
  results.sort((a, b) => {
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
    deprecated?: string;
    paused?: string;
  },
  restrictToIds: Set<string> | undefined
): EntryRow[] {
  if (restrictToIds && restrictToIds.size === 0) return [];

  const params: unknown[] = [];
  let where = '1 = 1';

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
    where += ` AND id IN (${[...restrictToIds].map(() => '?').join(', ')})`;
    params.push(...restrictToIds);
  }

  if (table === 'skills') {
    const rows = db
      .prepare(`SELECT id, description, owner, status, tags, folder, mtime_ms, deprecated, paused, created_at FROM skills WHERE ${where}`)
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
    }>;
    return rows.map((r) => ({
      _table: 'skills',
      id: r.id,
      name: r.id,
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
      `SELECT id, key, description, doc_type, key_type, status, tags, folder, mtime_ms, deprecated, paused, created_at FROM memory_docs WHERE ${where}`
    )
    .all(...params) as Array<{
    id: string;
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
    id: r.id,
    name: r.key,
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
    .prepare(`SELECT DISTINCT ref_table, ref_id FROM doc_dates WHERE ${where}`)
    .all(...params) as Array<{ ref_table: 'skills' | 'memory_docs'; ref_id: string }>;
  for (const row of rows) {
    (row.ref_table === 'skills' ? skills : memory_docs).add(row.ref_id);
  }
  return { skills, memory_docs };
}

/** Runs the FTS5 query once and buckets matching ids by source table. */
function matchSearch(db: Database.Database, q: string): { skills: Set<string>; memory_docs: Set<string> } {
  const skills = new Set<string>();
  const memory_docs = new Set<string>();
  let rows: Array<{ ref_table: 'skills' | 'memory_docs'; ref_id: string }>;
  try {
    rows = db
      .prepare(`SELECT ref_table, ref_id FROM search_index WHERE search_index MATCH ? ORDER BY rank`)
      .all(sanitizeFtsQuery(q)) as typeof rows;
  } catch {
    // Bad FTS5 query syntax (e.g. a bare quote) — treat as no matches rather than 500ing.
    return { skills, memory_docs };
  }
  for (const row of rows) {
    (row.ref_table === 'skills' ? skills : memory_docs).add(row.ref_id);
  }
  return { skills, memory_docs };
}

function buildFacets(db: Database.Database, type: EntryType) {
  const tags = new Set<string>();
  const statuses = new Set<string>();
  const owners = new Set<string>();
  const docTypes = new Set<string>();
  const keyTypes = new Set<string>();
  const folders = new Set<string>();

  if (type === 'skill' || type === 'all') {
    const rows = db.prepare(`SELECT tags, status, owner, folder FROM skills`).all() as Array<{
      tags: string;
      status: string;
      owner: string | null;
      folder: string;
    }>;
    for (const r of rows) {
      (JSON.parse(r.tags) as string[]).forEach((t) => tags.add(t));
      statuses.add(r.status);
      if (r.owner) owners.add(r.owner);
      if (r.folder) folders.add(r.folder);
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
  };
}

function buildHealth(db: Database.Database) {
  const skillIds = new Set(
    (db.prepare(`SELECT id FROM skills`).all() as Array<{ id: string }>).map((r) => r.id)
  );
  const memoryIds = new Set(
    (db.prepare(`SELECT id FROM memory_docs`).all() as Array<{ id: string }>).map((r) => r.id)
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

  const memoryDocs = db.prepare(`SELECT id, related_to, status, mtime_ms FROM memory_docs`).all() as Array<{
    id: string;
    related_to: string | null;
    status: string;
    mtime_ms: number;
  }>;
  const danglingRelatedTo = memoryDocs
    .filter((m) => m.related_to && !memoryIds.has(m.related_to) && !skillIds.has(m.related_to))
    .map((m) => ({ id: m.id, related_to: m.related_to }));

  const staleCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const staleActiveMemoryDocs = memoryDocs
    .filter((m) => m.status === 'active' && m.mtime_ms < staleCutoff)
    .map((m) => m.id);

  return { danglingExtends, danglingRelatedTo, emptyTriggerPhrases, staleActiveMemoryDocs };
}

export function buildWebRouter(
  db: Database.Database,
  config: BucketConfig,
  skillRepo: SkillRepository,
  memoryRepo: MemoryRepository,
  skillSpec: TableSyncSpec<any>,
  memorySpec: TableSyncSpec<any>,
  remotePollers?: { skill?: RemotePollerHandle; memory?: RemotePollerHandle }
): Router {
  const router = express.Router();

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
    res.json(queryEntries(db, memoryRepo, req));
  });

  router.get('/api/entries/:table/:id', (req: Request, res: Response) => {
    const { table, id } = req.params;
    if (table !== 'skills' && table !== 'memory_docs') {
      res.status(400).json({ error: 'table must be "skills" or "memory_docs"' });
      return;
    }
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
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
    res.json({ ...row, tags, trigger_phrases, attachments, has_frontmatter, raw_file });
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
    const row = db.prepare(`SELECT source_path FROM ${table} WHERE id = ?`).get(id) as
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
    const row = db.prepare(`SELECT source_path FROM ${table} WHERE id = ?`).get(id) as
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
    res.setHeader('Content-Type', guessMimeType(filename));
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
    res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) {
        res.status(404).json({ error: 'attachment not found' });
      }
    });
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
      else await memoryRepo.update(id, { deprecated });
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
    const results = table === 'skills' ? await skillRepo.bulkUpdate(ids, { deprecated }) : await memoryRepo.bulkUpdate(ids, { deprecated });
    res.json({ results });
  });

  // General frontmatter edit — covers both "edit an existing doc's fields" and "add frontmatter
  // to a bare file" (a bare memory doc already has a derived id/key from deriveFrontmatter, so
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
      const updated = table === 'skills' ? await skillRepo.update(id, frontmatter) : await memoryRepo.update(id, frontmatter);
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

  // Memory docs only — skill frontmatter (name/description) is required by the agentskills.io
  // spec, so stripping it would produce a non-conformant SKILL.md no compliant agent can load.
  router.delete('/api/entries/memory_docs/:id/frontmatter', async (req: Request, res: Response) => {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    try {
      await memoryRepo.stripFrontmatter(id);
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
    const [result] = table === 'skills' ? await skillRepo.setPaused([id], paused) : await memoryRepo.setPaused([id], paused);
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
    const results = table === 'skills' ? await skillRepo.setPaused(ids, paused) : await memoryRepo.setPaused(ids, paused);
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
      if (table === 'skills') await skillRepo.delete(id);
      else await memoryRepo.delete(id);
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
    const results = table === 'skills' ? await skillRepo.bulkDelete(ids) : await memoryRepo.bulkDelete(ids);
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

  // Tells the client which folderfoo deployment (if any) to point the
  // "Connect folderfoo" flow and the page-level login widget at — see
  // config.ts's FolderfooMode doc comment for why this can't be inferred
  // from window.location.hostname the way mindfoo/bulletino/avotuner do.
  router.get('/api/config', (_req: Request, res: Response) => {
    res.json({ folderfooMode: config.folderfooMode, folderfooHost: config.folderfooHost });
  });

  router.get('/api/folders', (_req: Request, res: Response) => {
    res.json({
      skill: skillRepo.listFoldersWithRemoteInfo().map((f) => ({ ...f, kind: 'skill' as const })),
      memory: memoryRepo.listFoldersWithRemoteInfo().map((f) => ({ ...f, kind: 'memory' as const })),
    });
  });

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
        const row = db.prepare(`SELECT id FROM ${table} WHERE source_path = ?`).get(sourcePath) as { id: string } | undefined;
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
    res.json({ connected: true, server });
  });

  // Lists the caller's own folderfoo folders for the "connect a folder"
  // picker, once already logged in to `server` (via the route above).
  router.get('/api/folderfoo/folders', async (req: Request, res: Response) => {
    const server = req.query.server as string | undefined;
    const tenantId = req.query.tenantId as string | undefined;
    if (!server || !tenantId) {
      res.status(400).json({ error: 'server and tenantId query params are required' });
      return;
    }
    try {
      const folders = await listFolderfooFolders(server, config.baseDir, tenantId);
      res.json(folders);
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
    const { kind, name, server, tenantId, folderPath } = req.body as {
      kind?: string;
      name?: string;
      server?: string;
      tenantId?: string;
      folderPath?: string;
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

    const repo = kind === 'skill' ? skillRepo : memoryRepo;
    const spec = kind === 'skill' ? skillSpec : memorySpec;
    const mirrorDir = mirrorDirFor(config.baseDir, folderName);
    const remote = { name: folderName, server, tenantId, folderPath, mirrorDir };
    try {
      repo.registerRemoteFolder(remote);
      saveRemoteFolder(config, kind, { name: folderName, server, tenantId, folderPath });
      await pollOne(db, spec, remote, config.baseDir);
      res.json({ name: folderName, server, tenantId, folderPath, kind });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

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
