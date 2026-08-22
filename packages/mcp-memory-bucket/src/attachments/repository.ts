import fs from 'node:fs';
import path from 'node:path';
import type { MemoryRepository } from '../memory/repository.js';
import type { SkillRepository } from '../skills/repository.js';
import type { AttachmentEntry } from './types.js';
import { attachmentsDirFor, writeAttachmentFile, listAttachmentFiles, type DocKind } from './storage.js';
import { resolveWithinBase } from '../store/safe-path.js';

export class AttachmentRepository {
  constructor(private memoryRepo: MemoryRepository, private skillRepo: SkillRepository) {}

  private getDoc(kind: DocKind, docIdOrName: string) {
    const doc = kind === 'memory' ? this.memoryRepo.get(docIdOrName) : this.skillRepo.get(docIdOrName);
    if (!doc) throw new Error(`${kind} doc "${docIdOrName}" not found`);
    return doc;
  }

  private saveAttachmentsList(kind: DocKind, docIdOrName: string, attachments: AttachmentEntry[]): void {
    if (kind === 'memory') {
      this.memoryRepo.update(docIdOrName, { attachments });
    } else {
      this.skillRepo.update(docIdOrName, { attachments });
    }
  }

  add(kind: DocKind, docIdOrName: string, filename: string, data: Buffer): AttachmentEntry {
    const doc = this.getDoc(kind, docIdOrName);
    const dir = attachmentsDirFor(doc.source_path, kind);
    const entry = writeAttachmentFile(dir, filename, data);
    const existing = doc.attachments ?? [];
    this.saveAttachmentsList(kind, docIdOrName, [...existing, entry]);
    return entry;
  }

  get(kind: DocKind, docIdOrName: string, filename: string): AttachmentEntry | undefined {
    const doc = this.getDoc(kind, docIdOrName);
    return (doc.attachments ?? []).find((a) => a.filename === filename);
  }

  update(kind: DocKind, docIdOrName: string, filename: string, data: Buffer): AttachmentEntry {
    const doc = this.getDoc(kind, docIdOrName);
    const dir = attachmentsDirFor(doc.source_path, kind);
    const existingEntry = (doc.attachments ?? []).find((a) => a.filename === filename);
    if (!existingEntry) throw new Error(`attachment "${filename}" not found on ${kind} doc "${docIdOrName}"`);
    const safePath = resolveWithinBase(dir, undefined, filename);
    fs.rmSync(safePath, { force: true });
    const written = writeAttachmentFile(dir, filename, data);
    // Full replace: preserve position, overwrite metadata for this filename entry.
    const next = (doc.attachments ?? []).map((a) => (a.filename === filename ? written : a));
    this.saveAttachmentsList(kind, docIdOrName, next);
    return written;
  }

  remove(kind: DocKind, docIdOrName: string, filename: string): void {
    const doc = this.getDoc(kind, docIdOrName);
    const dir = attachmentsDirFor(doc.source_path, kind);
    const safePath = resolveWithinBase(dir, undefined, filename);
    fs.rmSync(safePath, { force: true });
    const next = (doc.attachments ?? []).filter((a) => a.filename !== filename);
    this.saveAttachmentsList(kind, docIdOrName, next);
  }

  list(kind: DocKind, docIdOrName: string): AttachmentEntry[] {
    return this.getDoc(kind, docIdOrName).attachments ?? [];
  }

  /** Absolute filesystem path for an attachment's file, for callers (e.g. MCP tools) that need to Read it. */
  absolutePathFor(kind: DocKind, docIdOrName: string, filename: string): string {
    const doc = this.getDoc(kind, docIdOrName);
    return path.join(attachmentsDirFor(doc.source_path, kind), filename);
  }

  reconcile(kind: DocKind, docIdOrName: string): { orphans: string[]; unlisted: string[] } {
    const doc = this.getDoc(kind, docIdOrName);
    const dir = attachmentsDirFor(doc.source_path, kind);
    const declared = new Set((doc.attachments ?? []).map((a) => a.filename));
    const onDisk = new Set(listAttachmentFiles(dir));
    const orphans = [...declared].filter((f) => !onDisk.has(f));
    const unlisted = [...onDisk].filter((f) => !declared.has(f));
    return { orphans, unlisted };
  }
}

export { attachmentsDirFor };
