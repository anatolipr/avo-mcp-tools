import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { FSWatcher } from 'chokidar';
import { writeMarkdownFile } from '../store/markdown-file.js';
import { assertValidSkillName } from '../store/skill-name.js';
import { resolveWithinBase } from '../store/safe-path.js';
import { upsertFile, removeFile, scanSingleRoot, unregisterRoot, skillSyncSpec, type TableSyncSpec } from '../store/sync.js';
import { SearchQueryError } from '../store/search.js';
import type { NamedRoot } from '../config.js';
import type { SkillDoc, SkillFrontmatter, SkillStatus } from '../types.js';

interface SkillRow {
  id: string;
  description: string;
  owner: string | null;
  status: SkillStatus;
  tags: string; // JSON
  trigger_phrases: string; // JSON
  extends: string | null;
  source_path: string;
  root: string;
  deprecated: number;
  created_at: string | null;
  body: string;
}

function rowToDoc(row: SkillRow): SkillDoc {
  return {
    name: row.id,
    description: row.description,
    tags: JSON.parse(row.tags),
    trigger_phrases: JSON.parse(row.trigger_phrases),
    metadata: { owner: row.owner, status: row.status, extends: row.extends },
    deprecated: !!row.deprecated,
    created_at: row.created_at ?? undefined,
    source_path: row.source_path,
    root: row.root,
    body: row.body,
  };
}

export interface SkillListItem {
  name: string;
  description: string;
  owner: string | null;
  status: SkillStatus;
  tags: string[];
  root: string;
}

export class SkillRepository {
  private syncSpec: TableSyncSpec<SkillFrontmatter>;
  private watcher?: FSWatcher;

  /** `roots[0]` is always the builtin skills dir — never exposed for create()/removal. */
  constructor(private db: Database.Database, private roots: NamedRoot[]) {
    this.syncSpec = skillSyncSpec(roots);
  }

  /** Attaches the live chokidar watcher so addRoot/removeRoot can mutate it without a restart. */
  setWatcher(watcher: FSWatcher): void {
    this.watcher = watcher;
  }

  /** User-addable roots — excludes the always-present builtin skills dir at roots[0]. */
  listRoots(): NamedRoot[] {
    return this.roots.slice(1);
  }

  private resolveRoot(rootName: string | undefined): NamedRoot {
    const userRoots = this.listRoots();
    if (rootName) {
      const found = userRoots.find((r) => r.name === rootName);
      if (!found) {
        throw new Error(`unknown skill root "${rootName}" — valid roots: ${userRoots.map((r) => r.name).join(', ') || '(none configured)'}`);
      }
      return found;
    }
    if (userRoots.length === 1) return userRoots[0]!;
    if (userRoots.length === 0) {
      throw new Error('no skill root configured — add one first (see bucket_open_ui)');
    }
    throw new Error(`multiple skill roots configured — specify root: one of ${userRoots.map((r) => r.name).join(', ')}`);
  }

  /** Registers a new root: appends it, scans it once, and starts watching it live. */
  addRoot(root: NamedRoot): void {
    if (this.roots.some((r) => r.name === root.name)) {
      throw new Error(`a skill root named "${root.name}" already exists`);
    }
    this.roots.push(root);
    scanSingleRoot(this.db, this.syncSpec, root.path);
    this.watcher?.add(root.path);
  }

  /** Unregisters a root: stops watching it and drops its cached rows. Never touches files on disk. */
  removeRoot(name: string): void {
    const idx = this.roots.findIndex((r) => r.name === name);
    if (idx <= 0) throw new Error(`skill root "${name}" not found or is not removable`); // index 0 is builtin
    const [removed] = this.roots.splice(idx, 1);
    this.watcher?.unwatch(removed!.path);
    unregisterRoot(this.db, 'skills', name);
  }

  list(query?: string, root?: string): SkillListItem[] {
    const rows = root
      ? (this.db
          .prepare(`SELECT id, description, owner, status, tags, trigger_phrases, root FROM skills WHERE root = ?`)
          .all(root) as Array<Pick<SkillRow, 'id' | 'description' | 'owner' | 'status' | 'tags' | 'trigger_phrases' | 'root'>>)
      : (this.db
          .prepare(`SELECT id, description, owner, status, tags, trigger_phrases, root FROM skills`)
          .all() as Array<Pick<SkillRow, 'id' | 'description' | 'owner' | 'status' | 'tags' | 'trigger_phrases' | 'root'>>);

    const needle = query?.trim().toLowerCase();
    const items = rows.map((r) => ({
      name: r.id,
      description: r.description,
      owner: r.owner,
      status: r.status,
      tags: JSON.parse(r.tags) as string[],
      triggerPhrases: JSON.parse(r.trigger_phrases) as string[],
      root: r.root,
    }));

    const filtered = needle
      ? items.filter(
          (item) =>
            item.description.toLowerCase().includes(needle) ||
            item.tags.some((t) => t.toLowerCase().includes(needle)) ||
            item.triggerPhrases.some((t) => t.toLowerCase().includes(needle))
        )
      : items;

    return filtered.map(({ triggerPhrases: _tp, ...rest }) => rest);
  }

  /**
   * Full-text search over skill description/body/tags via FTS5 — `query` is
   * raw FTS5 MATCH syntax (AND/OR/NOT, "phrases", prefix*). Ranked by bm25.
   * Optional metadata filters (root/status/owner/tag) apply before limit/offset,
   * so pagination stays correct even when filtering narrows the FTS hit set.
   */
  search(
    query: string,
    opts: { root?: string; status?: SkillStatus; owner?: string; tag?: string; limit?: number; offset?: number } = {}
  ): Array<{ name: string; description: string; root: string; snippet: string; score: number }> {
    const { root, status, owner, tag, limit = 20, offset = 0 } = opts;
    const conditions: string[] = [];
    const params: unknown[] = [query];
    if (root) {
      conditions.push('s.root = ?');
      params.push(root);
    }
    if (status) {
      conditions.push('s.status = ?');
      params.push(status);
    }
    if (owner) {
      conditions.push('s.owner = ?');
      params.push(owner);
    }
    if (tag) {
      conditions.push('EXISTS (SELECT 1 FROM json_each(s.tags) WHERE value = ?)');
      params.push(tag);
    }
    params.push(limit, offset);

    try {
      const rows = this.db
        .prepare(
          `SELECT s.id AS name, s.description, s.root,
                  snippet(search_index, 3, '<<', '>>', '…', 20) AS snippet,
                  -bm25(search_index) AS score
           FROM search_index
           JOIN skills s ON s.id = search_index.ref_id
           WHERE search_index.ref_table = 'skills' AND search_index MATCH ? ${conditions.map((c) => `AND ${c}`).join(' ')}
           ORDER BY bm25(search_index)
           LIMIT ? OFFSET ?`
        )
        .all(...params) as Array<{ name: string; description: string; root: string; snippet: string; score: number }>;
      return rows;
    } catch (err) {
      throw new SearchQueryError(query, err);
    }
  }

  get(name: string): SkillDoc | null {
    const row = this.db.prepare(`SELECT * FROM skills WHERE id = ?`).get(name) as SkillRow | undefined;
    return row ? rowToDoc(row) : null;
  }

  /** Fetches many skills by name in one call — e.g. hydrating full bodies for a batch of search() hits. Missing names are simply absent from the result, not errors. */
  bulkGet(names: string[]): SkillDoc[] {
    return names.map((name) => this.get(name)).filter((doc): doc is SkillDoc => doc !== null);
  }

  /**
   * Creates <root>/[folder/]<name>/SKILL.md — folder-per-skill, per the
   * agentskills.io spec (`name` must equal the containing folder's name).
   * `root` selects which configured skill root to write into; required only
   * when more than one user root is configured.
   */
  create(
    frontmatter: { name: string; description: string; license?: string; compatibility?: string; tags?: string[]; trigger_phrases?: string[] } & {
      owner?: string | null;
      status?: SkillStatus;
      extends?: string | null;
    },
    body: string,
    folder?: string,
    root?: string
  ): SkillDoc {
    assertValidSkillName(frontmatter.name);
    if (this.get(frontmatter.name)) {
      throw new Error(`skill with name "${frontmatter.name}" already exists`);
    }
    const targetRoot = this.resolveRoot(root);
    const skillDir = resolveWithinBase(targetRoot.path, folder, frontmatter.name);
    if (fs.existsSync(skillDir)) {
      throw new Error(`skill directory already exists at ${skillDir}`);
    }
    fs.mkdirSync(skillDir, { recursive: true });
    const filePath = path.join(skillDir, 'SKILL.md');

    const fm: SkillFrontmatter = {
      name: frontmatter.name,
      description: frontmatter.description,
      license: frontmatter.license,
      compatibility: frontmatter.compatibility,
      tags: frontmatter.tags ?? [],
      trigger_phrases: frontmatter.trigger_phrases ?? [],
      metadata: {
        owner: frontmatter.owner ?? null,
        status: frontmatter.status ?? 'unreviewed',
        extends: frontmatter.extends ?? null,
      },
      deprecated: false,
      created_at: new Date().toISOString(),
      source_path: filePath,
      root: targetRoot.name,
    };
    writeMarkdownFile(filePath, stripSourcePath(fm), body);
    upsertFile(this.db, this.syncSpec, filePath);
    return { ...fm, body };
  }

  /**
   * Creates many skills in one call — each entry is the same shape as create()'s
   * args. Returns per-name results so one bad entry (duplicate name, invalid
   * name, existing directory) doesn't abort the rest of the batch.
   */
  bulkCreate(
    entries: Array<{
      frontmatter: { name: string; description: string; license?: string; compatibility?: string; tags?: string[]; trigger_phrases?: string[] } & {
        owner?: string | null;
        status?: SkillStatus;
        extends?: string | null;
      };
      body: string;
      folder?: string;
      root?: string;
    }>
  ): Array<{ name: string; ok: boolean; error?: string }> {
    return entries.map((entry) => {
      try {
        this.create(entry.frontmatter, entry.body, entry.folder, entry.root);
        return { name: entry.frontmatter.name, ok: true };
      } catch (err) {
        return { name: entry.frontmatter.name, ok: false, error: (err as Error).message };
      }
    });
  }

  /** Name of the always-present, non-removable builtin root (roots[0]) — never user content, never deprecatable. */
  private isBuiltin(doc: Pick<SkillDoc, 'root'>): boolean {
    return doc.root === this.roots[0]?.name;
  }

  update(
    name: string,
    frontmatter?: Partial<Omit<SkillFrontmatter, 'name' | 'metadata'>> & {
      owner?: string | null;
      status?: SkillStatus;
      extends?: string | null;
    },
    body?: string
  ): SkillDoc {
    const existing = this.get(name);
    if (!existing) throw new Error(`skill with name "${name}" not found`);

    // Builtin skills (e.g. memory-bucket-authoring) are the server's own always-present
    // documentation, not user content — deprecating them would hide guidance every session needs.
    const deprecated = this.isBuiltin(existing) ? existing.deprecated : frontmatter?.deprecated;

    const merged: SkillFrontmatter = {
      ...existing,
      ...frontmatter,
      deprecated,
      name: existing.name, // name is immutable post-creation (it's also the folder name)
      metadata: {
        ...existing.metadata,
        owner: frontmatter?.owner !== undefined ? frontmatter.owner : existing.metadata.owner,
        status: frontmatter?.status ?? existing.metadata.status,
        extends: frontmatter?.extends !== undefined ? frontmatter.extends : existing.metadata.extends,
      },
    };
    const newBody = body ?? existing.body;
    writeMarkdownFile(existing.source_path, stripSourcePath(merged), newBody);
    upsertFile(this.db, this.syncSpec, existing.source_path);
    return { ...merged, body: newBody };
  }

  /**
   * Renames a skill: moves <sourceDir>/[folder/]<oldName>/ to .../<newName>/ (keeping any
   * scripts/references/assets alongside SKILL.md) and updates the `name` frontmatter field to match.
   */
  rename(name: string, newName: string): SkillDoc {
    assertValidSkillName(newName);
    const existing = this.get(name);
    if (!existing) throw new Error(`skill with name "${name}" not found`);
    if (newName === name) return existing;
    if (this.get(newName)) {
      throw new Error(`skill with name "${newName}" already exists`);
    }

    const oldDir = path.dirname(existing.source_path);
    const newDir = path.join(path.dirname(oldDir), newName);
    if (fs.existsSync(newDir)) {
      throw new Error(`skill directory already exists at ${newDir}`);
    }
    fs.renameSync(oldDir, newDir);
    const newFilePath = path.join(newDir, 'SKILL.md');

    const merged: SkillFrontmatter = { ...existing, name: newName };
    writeMarkdownFile(newFilePath, stripSourcePath(merged), existing.body);
    removeFile(this.db, 'skills', existing.source_path);
    upsertFile(this.db, this.syncSpec, newFilePath);
    return { ...merged, body: existing.body };
  }

  /**
   * Applies the same frontmatter change to many skills at once — e.g. add/remove
   * a tag across a batch found via search(), or flip status for a group. Tags in
   * `add_tags`/`remove_tags` are merged/subtracted per-skill; other fields (owner,
   * status, extends) overwrite uniformly when provided. Never touches body.
   * Returns per-name results so partial failures (e.g. an unknown name) don't
   * abort the rest of the batch.
   */
  bulkUpdate(
    names: string[],
    changes: {
      add_tags?: string[];
      remove_tags?: string[];
      owner?: string | null;
      status?: SkillStatus;
      extends?: string | null;
      deprecated?: boolean;
    }
  ): Array<{ name: string; ok: boolean; error?: string }> {
    return names.map((name) => {
      try {
        const existing = this.get(name);
        if (!existing) throw new Error(`skill with name "${name}" not found`);
        const builtin = this.isBuiltin(existing);
        let tags = existing.tags;
        if (changes.add_tags?.length) tags = Array.from(new Set([...tags, ...changes.add_tags]));
        if (changes.remove_tags?.length) tags = tags.filter((t) => !changes.remove_tags!.includes(t));
        this.update(name, {
          tags,
          owner: changes.owner,
          status: changes.status,
          extends: changes.extends,
          ...(changes.deprecated !== undefined && !builtin ? { deprecated: changes.deprecated } : {}),
        });
        return { name, ok: true };
      } catch (err) {
        return { name, ok: false, error: (err as Error).message };
      }
    });
  }

  /** Removes the whole skill directory, including any scripts/references/assets alongside SKILL.md. */
  delete(name: string): void {
    const existing = this.get(name);
    if (!existing) throw new Error(`skill with name "${name}" not found`);
    if (this.isBuiltin(existing)) throw new Error(`skill "${name}" is builtin and cannot be deleted`);
    const skillDir = path.dirname(existing.source_path);
    fs.rmSync(skillDir, { recursive: true, force: true });
    removeFile(this.db, 'skills', existing.source_path);
  }

  /**
   * Deletes many skills by name in one call — e.g. cleaning up a batch found
   * via search()/list(). Returns per-name results so one bad name doesn't
   * abort the rest of the batch.
   */
  bulkDelete(names: string[]): Array<{ name: string; ok: boolean; error?: string }> {
    return names.map((name) => {
      try {
        this.delete(name);
        return { name, ok: true };
      } catch (err) {
        return { name, ok: false, error: (err as Error).message };
      }
    });
  }
}

function stripSourcePath<T extends { source_path: string; root: string }>(fm: T): Omit<T, 'source_path' | 'root'> {
  const { source_path: _sp, root: _root, ...rest } = fm;
  return rest;
}
