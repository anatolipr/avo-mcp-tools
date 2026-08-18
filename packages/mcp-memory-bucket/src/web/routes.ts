import type { Router, Request, Response } from 'express';
import express from 'express';
import type Database from 'better-sqlite3';

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
  mtime_ms: number;
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

function queryEntries(db: Database.Database, req: Request): EntryRow[] {
  const type = (req.query.type as EntryType) ?? 'all';
  const tags = asArray(req.query.tag);
  const statuses = asArray(req.query.status);
  const owners = asArray(req.query.owner);
  const docTypes = asArray(req.query.doc_type);
  const keyTypes = asArray(req.query.key_type);
  const q = (req.query.q as string | undefined)?.trim();

  const matchedIds: { skills: Set<string>; memory_docs: Set<string> } | null = q
    ? matchSearch(db, q)
    : null;
  if (q && matchedIds && matchedIds.skills.size === 0 && matchedIds.memory_docs.size === 0) {
    return [];
  }

  const results: EntryRow[] = [];

  if (type === 'skill' || type === 'all') {
    results.push(...queryTable(db, 'skills', { tags, statuses, owners, docTypes: [], keyTypes: [] }, matchedIds?.skills));
  }
  if (type === 'memory' || type === 'all') {
    results.push(
      ...queryTable(db, 'memory_docs', { tags, statuses, owners: [], docTypes, keyTypes }, matchedIds?.memory_docs)
    );
  }

  const sort = (req.query.sort as string | undefined) ?? 'mtime_desc';
  results.sort((a, b) => {
    if (sort === 'mtime_asc') return a.mtime_ms - b.mtime_ms;
    if (sort === 'name_asc') return a.name.localeCompare(b.name);
    return b.mtime_ms - a.mtime_ms; // mtime_desc, default
  });

  return results;
}

function queryTable(
  db: Database.Database,
  table: 'skills' | 'memory_docs',
  filters: { tags: string[]; statuses: string[]; owners: string[]; docTypes: string[]; keyTypes: string[] },
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
  if (restrictToIds) {
    where += ` AND id IN (${[...restrictToIds].map(() => '?').join(', ')})`;
    params.push(...restrictToIds);
  }

  if (table === 'skills') {
    const rows = db
      .prepare(`SELECT id, description, owner, status, tags, mtime_ms FROM skills WHERE ${where}`)
      .all(...params) as Array<{
      id: string;
      description: string;
      owner: string | null;
      status: string;
      tags: string;
      mtime_ms: number;
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
      mtime_ms: r.mtime_ms,
    }));
  }

  const rows = db
    .prepare(`SELECT id, key, description, doc_type, key_type, status, tags, mtime_ms FROM memory_docs WHERE ${where}`)
    .all(...params) as Array<{
    id: string;
    key: string;
    description: string;
    doc_type: string;
    key_type: string;
    status: string;
    tags: string;
    mtime_ms: number;
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
    mtime_ms: r.mtime_ms,
  }));
}

/** Runs the FTS5 query once and buckets matching ids by source table. */
function matchSearch(db: Database.Database, q: string): { skills: Set<string>; memory_docs: Set<string> } {
  const skills = new Set<string>();
  const memory_docs = new Set<string>();
  let rows: Array<{ ref_table: 'skills' | 'memory_docs'; ref_id: string }>;
  try {
    rows = db
      .prepare(`SELECT ref_table, ref_id FROM search_index WHERE search_index MATCH ? ORDER BY rank`)
      .all(q) as typeof rows;
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

  if (type === 'skill' || type === 'all') {
    const rows = db.prepare(`SELECT tags, status, owner FROM skills`).all() as Array<{
      tags: string;
      status: string;
      owner: string | null;
    }>;
    for (const r of rows) {
      (JSON.parse(r.tags) as string[]).forEach((t) => tags.add(t));
      statuses.add(r.status);
      if (r.owner) owners.add(r.owner);
    }
  }
  if (type === 'memory' || type === 'all') {
    const rows = db.prepare(`SELECT tags, status, doc_type, key_type FROM memory_docs`).all() as Array<{
      tags: string;
      status: string;
      doc_type: string;
      key_type: string;
    }>;
    for (const r of rows) {
      (JSON.parse(r.tags) as string[]).forEach((t) => tags.add(t));
      statuses.add(r.status);
      docTypes.add(r.doc_type);
      keyTypes.add(r.key_type);
    }
  }

  return {
    tags: [...tags].sort(),
    statuses: [...statuses].sort(),
    owners: [...owners].sort(),
    doc_types: [...docTypes].sort(),
    key_types: [...keyTypes].sort(),
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

export function buildWebRouter(db: Database.Database): Router {
  const router = express.Router();

  router.get('/api/entries', (req: Request, res: Response) => {
    res.json(queryEntries(db, req));
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
    res.json({ ...row, tags, trigger_phrases });
  });

  router.get('/api/facets', (req: Request, res: Response) => {
    const type = (req.query.type as EntryType) ?? 'all';
    res.json(buildFacets(db, type));
  });

  router.get('/api/health', (_req: Request, res: Response) => {
    res.json(buildHealth(db));
  });

  return router;
}
