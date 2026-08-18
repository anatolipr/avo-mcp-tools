import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FSWatcher } from 'chokidar';
import { writeMarkdownFile } from '../store/markdown-file.js';
import { slugify } from '../store/slug.js';
import { resolveWithinBase } from '../store/safe-path.js';
import { upsertFile, removeFile, scanSingleRoot, unregisterRoot, memorySyncSpec, type TableSyncSpec } from '../store/sync.js';
import type { NamedRoot } from '../config.js';
import { normalizeKey } from '../types.js';
import type { MemoryDoc, MemoryDocType, MemoryFrontmatter, MemoryKeyType, MemoryStatus } from '../types.js';

interface MemoryRow {
  id: string;
  key: string;
  key_type: MemoryKeyType;
  description: string;
  doc_type: MemoryDocType;
  tags: string; // JSON
  status: MemoryStatus;
  related_to: string | null;
  source_path: string;
  root: string;
  body: string;
}

function rowToDoc(row: MemoryRow): MemoryDoc {
  return {
    id: row.id,
    key: row.key,
    key_type: row.key_type,
    description: row.description,
    doc_type: row.doc_type,
    tags: JSON.parse(row.tags),
    status: row.status,
    related_to: row.related_to,
    source_path: row.source_path,
    root: row.root,
    body: row.body,
  };
}

export class MemoryRepository {
  private syncSpec: TableSyncSpec<MemoryFrontmatter>;
  private watcher?: FSWatcher;

  constructor(private db: Database.Database, private roots: NamedRoot[]) {
    this.syncSpec = memorySyncSpec(roots);
  }

  /** Attaches the live chokidar watcher so addRoot/removeRoot can mutate it without a restart. */
  setWatcher(watcher: FSWatcher): void {
    this.watcher = watcher;
  }

  listRoots(): NamedRoot[] {
    return [...this.roots];
  }

  private resolveRoot(rootName: string | undefined): NamedRoot {
    if (rootName) {
      const found = this.roots.find((r) => r.name === rootName);
      if (!found) {
        throw new Error(`unknown memory root "${rootName}" — valid roots: ${this.roots.map((r) => r.name).join(', ') || '(none configured)'}`);
      }
      return found;
    }
    if (this.roots.length === 1) return this.roots[0]!;
    if (this.roots.length === 0) {
      throw new Error('no memory root configured — add one first (see bucket_open_ui)');
    }
    throw new Error(`multiple memory roots configured — specify root: one of ${this.roots.map((r) => r.name).join(', ')}`);
  }

  /** Registers a new root: appends it, scans it once, and starts watching it live. */
  addRoot(root: NamedRoot): void {
    if (this.roots.some((r) => r.name === root.name)) {
      throw new Error(`a memory root named "${root.name}" already exists`);
    }
    this.roots.push(root);
    scanSingleRoot(this.db, this.syncSpec, root.path);
    this.watcher?.add(root.path);
  }

  /** Unregisters a root: stops watching it and drops its cached rows. Never touches files on disk. */
  removeRoot(name: string): void {
    const idx = this.roots.findIndex((r) => r.name === name);
    if (idx === -1) throw new Error(`memory root "${name}" not found`);
    const [removed] = this.roots.splice(idx, 1);
    this.watcher?.unwatch(removed!.path);
    unregisterRoot(this.db, 'memory_docs', name);
  }

  /** Exact-match lookup by normalized key, per V0 (no fuzzy matching). */
  getByKey(key: string, docType?: MemoryDocType): MemoryDoc[] {
    const normalized = normalizeKey(key);
    const rows = docType
      ? (this.db.prepare(`SELECT * FROM memory_docs WHERE key = ? AND doc_type = ?`).all(normalized, docType) as MemoryRow[])
      : (this.db.prepare(`SELECT * FROM memory_docs WHERE key = ?`).all(normalized) as MemoryRow[]);
    return rows.map(rowToDoc);
  }

  get(id: string): MemoryDoc | null {
    const row = this.db.prepare(`SELECT * FROM memory_docs WHERE id = ?`).get(id) as MemoryRow | undefined;
    return row ? rowToDoc(row) : null;
  }

  listKeys(keyPrefix?: string): Array<{ key: string; docCount: number }> {
    const rows = this.db
      .prepare(`SELECT key, COUNT(*) as doc_count FROM memory_docs GROUP BY key ORDER BY key`)
      .all() as Array<{ key: string; doc_count: number }>;
    const prefix = keyPrefix ? normalizeKey(keyPrefix) : undefined;
    return rows
      .filter((r) => !prefix || r.key.startsWith(prefix))
      .map((r) => ({ key: r.key, docCount: r.doc_count }));
  }

  create(input: {
    key: string;
    key_type: MemoryKeyType;
    doc_type: MemoryDocType;
    description: string;
    body: string;
    tags?: string[];
    related_to?: string | null;
    folder?: string;
    root?: string;
  }): MemoryDoc {
    const normalizedKey = normalizeKey(input.key);
    const id = `${slugify(normalizedKey)}-${slugify(input.description)}-${randomUUID().slice(0, 8)}`;
    const targetRoot = this.resolveRoot(input.root);
    const filePath = resolveWithinBase(targetRoot.path, input.folder, `${id}.md`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const fm: MemoryFrontmatter = {
      id,
      key: normalizedKey,
      key_type: input.key_type,
      description: input.description,
      doc_type: input.doc_type,
      tags: input.tags ?? [],
      status: 'active',
      related_to: input.related_to ?? null,
      source_path: filePath,
      root: targetRoot.name,
    };
    writeMarkdownFile(filePath, stripSourcePath(fm), input.body);
    upsertFile(this.db, this.syncSpec, filePath);
    return { ...fm, body: input.body };
  }

  update(id: string, frontmatter?: Partial<MemoryFrontmatter>, body?: string): MemoryDoc {
    const existing = this.get(id);
    if (!existing) throw new Error(`memory doc with id "${id}" not found`);

    const merged: MemoryFrontmatter = {
      ...existing,
      ...frontmatter,
      id: existing.id,
      key: frontmatter?.key ? normalizeKey(frontmatter.key) : existing.key,
    };
    const newBody = body ?? existing.body;
    writeMarkdownFile(existing.source_path, stripSourcePath(merged), newBody);
    upsertFile(this.db, this.syncSpec, existing.source_path);
    return { ...merged, body: newBody };
  }

  delete(id: string): void {
    const existing = this.get(id);
    if (!existing) throw new Error(`memory doc with id "${id}" not found`);
    fs.unlinkSync(existing.source_path);
    removeFile(this.db, 'memory_docs', existing.source_path);
  }
}

function stripSourcePath<T extends { source_path: string; root: string }>(fm: T): Omit<T, 'source_path' | 'root'> {
  const { source_path: _sp, root: _root, ...rest } = fm;
  return rest;
}
