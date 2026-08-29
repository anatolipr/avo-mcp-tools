import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { MemoryRepository } from '../memory/repository.js';
import type { SkillRepository } from '../skills/repository.js';
import type { AttachmentEntry } from './types.js';
import { attachmentsDirFor, buildAttachmentEntry, guessMimeType, listAttachmentFiles, type DocKind } from './storage.js';
import { resolveWithinBase } from '../store/safe-path.js';
import { writeRemoteThenLocal } from '../remote/write-order.js';

export class AttachmentRepository {
  // db is optional — only needed by repairUnlistedInFolder's own doc enumeration (server.ts's
  // remote-poll heal hook). Every other method reaches docs through memoryRepo/skillRepo, which
  // already own their own db reference.
  constructor(private memoryRepo: MemoryRepository, private skillRepo: SkillRepository, private db?: Database.Database) {}

  private async getDoc(kind: DocKind, folder: string | undefined, docIdOrName: string) {
    const doc = kind === 'memory' ? await this.memoryRepo.get(folder, docIdOrName) : await this.skillRepo.get(docIdOrName, folder);
    if (!doc) throw new Error(`${kind} doc "${docIdOrName}" not found`);
    return doc;
  }

  private async saveAttachmentsList(kind: DocKind, folder: string | undefined, docIdOrName: string, attachments: AttachmentEntry[]): Promise<void> {
    if (kind === 'memory') {
      await this.memoryRepo.update(folder, docIdOrName, { attachments });
    } else {
      await this.skillRepo.update(docIdOrName, { attachments }, undefined, undefined, folder);
    }
  }

  /**
   * Pushes an attachment's binary content to folderfoo if the doc lives in a remote folder —
   * no-op for a local folder (both repos' pushAttachmentIfNeeded already guard on that).
   */
  private async pushAttachmentToRemoteIfNeeded(kind: DocKind, folder: string, filePath: string, data: Buffer, mimeType: string): Promise<void> {
    if (kind === 'memory') {
      await this.memoryRepo.pushAttachmentIfNeeded(folder, filePath, data, mimeType);
    } else {
      await this.skillRepo.pushAttachmentIfNeeded(folder, filePath, data, mimeType);
    }
  }

  /**
   * Trashes an attachment's remote copy on folderfoo if the doc lives in a remote folder — no-op
   * for a local folder (both repos' trashAttachmentIfNeeded already guard on that).
   */
  private async trashAttachmentOnRemoteIfNeeded(kind: DocKind, folder: string, filePath: string): Promise<void> {
    if (kind === 'memory') {
      await this.memoryRepo.trashAttachmentIfNeeded(folder, filePath);
    } else {
      await this.skillRepo.trashAttachmentIfNeeded(folder, filePath);
    }
  }

  async add(kind: DocKind, folder: string | undefined, docIdOrName: string, filename: string, data: Buffer): Promise<AttachmentEntry> {
    const doc = await this.getDoc(kind, folder, docIdOrName);
    const dir = attachmentsDirFor(doc.source_path, kind);
    // Collision-avoidance (buildAttachmentEntry) is a pure disk STAT, not a write — safe before
    // any write, remote or local. Remote-first — see MemoryRepository.create()'s comment on why
    // (remote/write-order.ts).
    const entry = buildAttachmentEntry(dir, filename, data);
    await writeRemoteThenLocal(
      () => this.pushAttachmentToRemoteIfNeeded(kind, doc.folder, path.join(dir, entry.filename), data, guessMimeType(entry.filename)),
      () => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(resolveWithinBase(dir, undefined, entry.filename), data);
      }
    );
    const existing = doc.attachments ?? [];
    await this.saveAttachmentsList(kind, folder, docIdOrName, [...existing, entry]);
    return entry;
  }

  async get(kind: DocKind, folder: string | undefined, docIdOrName: string, filename: string): Promise<AttachmentEntry | undefined> {
    const doc = await this.getDoc(kind, folder, docIdOrName);
    return (doc.attachments ?? []).find((a) => a.filename === filename);
  }

  async update(kind: DocKind, folder: string | undefined, docIdOrName: string, filename: string, data: Buffer): Promise<AttachmentEntry> {
    const doc = await this.getDoc(kind, folder, docIdOrName);
    const dir = attachmentsDirFor(doc.source_path, kind);
    const existingEntry = (doc.attachments ?? []).find((a) => a.filename === filename);
    if (!existingEntry) throw new Error(`attachment "${filename}" not found on ${kind} doc "${docIdOrName}"`);
    // filename is an existing, already-collision-resolved name — no need to re-run uniqueFilename,
    // just recompute added_at for the new bytes.
    const written: AttachmentEntry = {
      filename,
      path: path.join('attachments', filename),
      added_at: new Date().toISOString(),
    };
    const safePath = resolveWithinBase(dir, undefined, filename);
    await writeRemoteThenLocal(
      () => this.pushAttachmentToRemoteIfNeeded(kind, doc.folder, safePath, data, guessMimeType(filename)),
      () => {
        fs.rmSync(safePath, { force: true });
        fs.writeFileSync(safePath, data);
      }
    );
    // Full replace: preserve position, overwrite metadata for this filename entry.
    const next = (doc.attachments ?? []).map((a) => (a.filename === filename ? written : a));
    await this.saveAttachmentsList(kind, folder, docIdOrName, next);
    return written;
  }

  async remove(kind: DocKind, folder: string | undefined, docIdOrName: string, filename: string): Promise<void> {
    const doc = await this.getDoc(kind, folder, docIdOrName);
    const dir = attachmentsDirFor(doc.source_path, kind);
    const safePath = resolveWithinBase(dir, undefined, filename);
    // Trash the remote copy FIRST, before touching anything local — same ordering/rationale as
    // MemoryRepository.delete()'s own trashRemoteFile call: soft-delete (recoverable via
    // folderfoo's own trash UI), and doing it before the local removal means a failure here
    // doesn't leave the doc's declared attachments list out of sync with what's actually still on
    // disk locally.
    await this.trashAttachmentOnRemoteIfNeeded(kind, doc.folder, safePath);
    fs.rmSync(safePath, { force: true });
    const next = (doc.attachments ?? []).filter((a) => a.filename !== filename);
    await this.saveAttachmentsList(kind, folder, docIdOrName, next);
    if (listAttachmentFiles(dir).length === 0) {
      fs.rmSync(dir, { recursive: true, force: true });
      if (kind === 'memory') {
        // Memory docs get a sibling wrapper directory solely to hold attachments/ (see
        // attachmentsDirFor) - remove it too once it's empty.
        const wrapperDir = path.dirname(dir);
        if (fs.existsSync(wrapperDir) && fs.readdirSync(wrapperDir).length === 0) {
          fs.rmdirSync(wrapperDir);
        }
      }
    }
  }

  async list(kind: DocKind, folder: string | undefined, docIdOrName: string): Promise<AttachmentEntry[]> {
    return (await this.getDoc(kind, folder, docIdOrName)).attachments ?? [];
  }

  /** Absolute filesystem path for an attachment's file, for callers (e.g. MCP tools) that need to Read it. */
  async absolutePathFor(kind: DocKind, folder: string | undefined, docIdOrName: string, filename: string): Promise<string> {
    const doc = await this.getDoc(kind, folder, docIdOrName);
    return path.join(attachmentsDirFor(doc.source_path, kind), filename);
  }

  async reconcile(kind: DocKind, folder: string | undefined, docIdOrName: string): Promise<{ orphans: string[]; unlisted: string[] }> {
    const doc = await this.getDoc(kind, folder, docIdOrName);
    const dir = attachmentsDirFor(doc.source_path, kind);
    const declared = new Set((doc.attachments ?? []).map((a) => a.filename));
    const onDisk = new Set(listAttachmentFiles(dir));
    const orphans = [...declared].filter((f) => !onDisk.has(f));
    const unlisted = [...onDisk].filter((f) => !declared.has(f));
    return { orphans, unlisted };
  }

  /**
   * Makes a doc's declared attachments list exactly match what's physically present on disk under
   * its attachments/ dir — the disk-is-truth counterpart to reconcile()'s report-only diff. Appends
   * every "unlisted" file (present on disk, not declared — e.g. restored from folderfoo's trash
   * after an earlier attachment_remove, or dropped in by hand) and drops every "orphan" entry
   * (declared but the file is gone — e.g. deleted directly on disk/folderfoo without going through
   * attachment_remove). folderfoo has no concept of "this file belongs to that doc's attachment
   * list," so nothing else would ever keep the two in sync on its own. No-op (no update() call at
   * all) if declared already exactly matches disk.
   */
  async reconcileToDisk(kind: DocKind, folder: string | undefined, docIdOrName: string): Promise<{ added: AttachmentEntry[]; removed: string[] }> {
    const doc = await this.getDoc(kind, folder, docIdOrName);
    const dir = attachmentsDirFor(doc.source_path, kind);
    const declared = doc.attachments ?? [];
    const onDisk = new Set(listAttachmentFiles(dir));
    const stillPresent = declared.filter((a) => onDisk.has(a.filename));
    const removed = declared.filter((a) => !onDisk.has(a.filename)).map((a) => a.filename);
    const declaredNames = new Set(declared.map((a) => a.filename));
    const unlistedNames = [...onDisk].filter((f) => !declaredNames.has(f));
    const added = unlistedNames.map((filename) => ({ filename, path: path.join('attachments', filename), added_at: new Date().toISOString() }));
    if (added.length === 0 && removed.length === 0) return { added: [], removed: [] };
    await this.saveAttachmentsList(kind, folder, docIdOrName, [...stillPresent, ...added]);
    return { added, removed };
  }

  /**
   * Runs reconcileToDisk across every doc in one configured folder — the batch entry point wired as
   * remote-sync.ts's startRemotePolling onSynced hook (see server.ts), so the next resync of that
   * remote source automatically keeps every doc's declared attachments in sync with whatever's
   * actually on disk, without needing anyone to open the doc or call attachment_reconcile by hand.
   * Deliberately reads docs straight from the cache table (not memoryRepo/skillRepo's own list-style
   * methods, which don't exist) since this only needs source_path/id + folder, both already indexed
   * columns — reconcileToDisk above does the real frontmatter-aware work per doc. Local (non-remote)
   * folders never call this: the whole point is reacting to remote resync, which only exists for
   * remote sources.
   */
  async repairUnlistedInFolder(table: 'skills' | 'memory_docs', folderName: string): Promise<void> {
    if (!this.db) return;
    const kind: DocKind = table === 'skills' ? 'skill' : 'memory';
    const idCol = table === 'skills' ? 'id' : 'source_path';
    const rows = this.db.prepare(`SELECT ${idCol} AS id, source_path FROM ${table} WHERE folder = ?`).all(folderName) as Array<{
      id: string;
      source_path: string;
    }>;
    for (const row of rows) {
      // Skills address by their frontmatter `name` (row.id) regardless of directory depth. Memory
      // docs address by (folder, filename) — filename must be the path RELATIVE TO THE FOLDER ROOT,
      // not just the basename: a doc living in a subfolder of this remote source (e.g.
      // "sub/DOC.md") would otherwise resolve to the wrong (nonexistent) path at the folder root
      // and 404 in getDoc, exactly like memoryRepo.get()'s own sourcePathFor doc comment warns
      // against — splitSourcePath is the same helper the web UI's splitMemoryId route handler uses
      // for this identical problem.
      const docIdOrName = table === 'skills' ? row.id : this.memoryRepo.splitSourcePath(row.source_path)?.filename;
      if (!docIdOrName) {
        console.error(`[memory-bucket] failed to repair attachments for ${row.source_path}: not under any configured memory folder`);
        continue;
      }
      try {
        await this.reconcileToDisk(kind, folderName, docIdOrName);
      } catch (err) {
        console.error(`[memory-bucket] failed to repair attachments for ${row.source_path}:`, err);
      }
    }
  }
}

export { attachmentsDirFor };
