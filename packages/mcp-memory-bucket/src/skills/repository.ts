import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { writeMarkdownFile } from '../store/markdown-file.js';
import { assertValidSkillName } from '../store/skill-name.js';
import { resolveWithinBase } from '../store/safe-path.js';
import { upsertFile, removeFile, skillSyncSpec, type TableSyncSpec } from '../store/sync.js';
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
  body: string;
}

function rowToDoc(row: SkillRow): SkillDoc {
  return {
    name: row.id,
    description: row.description,
    tags: JSON.parse(row.tags),
    trigger_phrases: JSON.parse(row.trigger_phrases),
    metadata: { owner: row.owner, status: row.status, extends: row.extends },
    source_path: row.source_path,
    body: row.body,
  };
}

export interface SkillListItem {
  name: string;
  description: string;
  owner: string | null;
  status: SkillStatus;
  tags: string[];
}

export class SkillRepository {
  private syncSpec: TableSyncSpec<SkillFrontmatter>;

  constructor(private db: Database.Database, private sourceDir: string) {
    this.syncSpec = skillSyncSpec([sourceDir]);
  }

  list(query?: string): SkillListItem[] {
    const rows = this.db
      .prepare(`SELECT id, description, owner, status, tags, trigger_phrases FROM skills`)
      .all() as Array<Pick<SkillRow, 'id' | 'description' | 'owner' | 'status' | 'tags' | 'trigger_phrases'>>;

    const needle = query?.trim().toLowerCase();
    const items = rows.map((r) => ({
      name: r.id,
      description: r.description,
      owner: r.owner,
      status: r.status,
      tags: JSON.parse(r.tags) as string[],
      triggerPhrases: JSON.parse(r.trigger_phrases) as string[],
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

  get(name: string): SkillDoc | null {
    const row = this.db.prepare(`SELECT * FROM skills WHERE id = ?`).get(name) as SkillRow | undefined;
    return row ? rowToDoc(row) : null;
  }

  /**
   * Creates <sourceDir>/[folder/]<name>/SKILL.md — folder-per-skill, per the
   * agentskills.io spec (`name` must equal the containing folder's name).
   */
  create(
    frontmatter: { name: string; description: string; license?: string; compatibility?: string; tags?: string[]; trigger_phrases?: string[] } & {
      owner?: string | null;
      status?: SkillStatus;
      extends?: string | null;
    },
    body: string,
    folder?: string
  ): SkillDoc {
    assertValidSkillName(frontmatter.name);
    if (this.get(frontmatter.name)) {
      throw new Error(`skill with name "${frontmatter.name}" already exists`);
    }
    const skillDir = resolveWithinBase(this.sourceDir, folder, frontmatter.name);
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
      source_path: filePath,
    };
    writeMarkdownFile(filePath, stripSourcePath(fm), body);
    upsertFile(this.db, this.syncSpec, filePath);
    return { ...fm, body };
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

    const merged: SkillFrontmatter = {
      ...existing,
      ...frontmatter,
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

  /** Removes the whole skill directory, including any scripts/references/assets alongside SKILL.md. */
  delete(name: string): void {
    const existing = this.get(name);
    if (!existing) throw new Error(`skill with name "${name}" not found`);
    const skillDir = path.dirname(existing.source_path);
    fs.rmSync(skillDir, { recursive: true, force: true });
    removeFile(this.db, 'skills', existing.source_path);
  }
}

function stripSourcePath<T extends { source_path: string }>(fm: T): Omit<T, 'source_path'> {
  const { source_path: _sp, ...rest } = fm;
  return rest;
}
