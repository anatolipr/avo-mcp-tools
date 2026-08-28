import fs from 'node:fs';
import path from 'node:path';
import type { MemoryRepository } from '../memory/repository.js';
import type { SkillRepository } from '../skills/repository.js';
import type { AttachmentEntry } from './types.js';
import { attachmentsDirFor, writeAttachmentFile, listAttachmentFiles, type DocKind } from './storage.js';
import { resolveWithinBase } from '../store/safe-path.js';

export class AttachmentRepository {
  constructor(private memoryRepo: MemoryRepository, private skillRepo: SkillRepository) {}

  private async getDoc(kind: DocKind, docIdOrName: string) {
    const doc = kind === 'memory' ? await this.memoryRepo.get(docIdOrName) : await this.skillRepo.get(docIdOrName);
    if (!doc) throw new Error(`${kind} doc "${docIdOrName}" not found`);
    return doc;
  }

  private async saveAttachmentsList(kind: DocKind, docIdOrName: string, attachments: AttachmentEntry[]): Promise<void> {
    if (kind === 'memory') {
      await this.memoryRepo.update(docIdOrName, { attachments });
    } else {
      await this.skillRepo.update(docIdOrName, { attachments });
    }
  }

  /**
   * Pushes an attachment's binary content to folderfoo if the doc lives in a remote folder —
   * no-op for a local folder (both repos' pushAttachmentIfNeeded already guard on that). Callers
   * must roll back their own local file write if this throws, same as skill/memory create() rolls
   * back its own file on a failed remote push.
   */
  private async pushAttachmentToRemoteIfNeeded(kind: DocKind, folder: string, filePath: string, mimeType: string): Promise<void> {
    if (kind === 'memory') {
      await this.memoryRepo.pushAttachmentIfNeeded(folder, filePath, mimeType);
    } else {
      await this.skillRepo.pushAttachmentIfNeeded(folder, filePath, mimeType);
    }
  }

  async add(kind: DocKind, docIdOrName: string, filename: string, data: Buffer): Promise<AttachmentEntry> {
    const doc = await this.getDoc(kind, docIdOrName);
    const dir = attachmentsDirFor(doc.source_path, kind);
    const entry = writeAttachmentFile(dir, filename, data);
    try {
      await this.pushAttachmentToRemoteIfNeeded(kind, doc.folder, path.join(dir, entry.filename), entry.mime_type);
    } catch (err) {
      // Mirrors create()'s rollback: remote push failed after the local mirror file was already
      // written — remove the orphaned local file rather than leaving it registered as if it were
      // already synced remotely.
      fs.rmSync(path.join(dir, entry.filename), { force: true });
      throw err;
    }
    const existing = doc.attachments ?? [];
    await this.saveAttachmentsList(kind, docIdOrName, [...existing, entry]);
    return entry;
  }

  async get(kind: DocKind, docIdOrName: string, filename: string): Promise<AttachmentEntry | undefined> {
    const doc = await this.getDoc(kind, docIdOrName);
    return (doc.attachments ?? []).find((a) => a.filename === filename);
  }

  async update(kind: DocKind, docIdOrName: string, filename: string, data: Buffer): Promise<AttachmentEntry> {
    const doc = await this.getDoc(kind, docIdOrName);
    const dir = attachmentsDirFor(doc.source_path, kind);
    const existingEntry = (doc.attachments ?? []).find((a) => a.filename === filename);
    if (!existingEntry) throw new Error(`attachment "${filename}" not found on ${kind} doc "${docIdOrName}"`);
    const safePath = resolveWithinBase(dir, undefined, filename);
    fs.rmSync(safePath, { force: true });
    const written = writeAttachmentFile(dir, filename, data);
    await this.pushAttachmentToRemoteIfNeeded(kind, doc.folder, path.join(dir, written.filename), written.mime_type);
    // Full replace: preserve position, overwrite metadata for this filename entry.
    const next = (doc.attachments ?? []).map((a) => (a.filename === filename ? written : a));
    await this.saveAttachmentsList(kind, docIdOrName, next);
    return written;
  }

  async remove(kind: DocKind, docIdOrName: string, filename: string): Promise<void> {
    const doc = await this.getDoc(kind, docIdOrName);
    const dir = attachmentsDirFor(doc.source_path, kind);
    const safePath = resolveWithinBase(dir, undefined, filename);
    fs.rmSync(safePath, { force: true });
    // Does NOT delete the corresponding file on folderfoo — there is no delete endpoint in
    // folderfoo-client.ts, matching the same already-flagged gap on skill/memory doc rename/delete
    // (see SkillRepository.rename()/remove() doc comments). A removed attachment leaves a stale
    // copy on the remote source until folderfoo itself gains a delete API.
    const next = (doc.attachments ?? []).filter((a) => a.filename !== filename);
    await this.saveAttachmentsList(kind, docIdOrName, next);
    if (listAttachmentFiles(dir).length === 0) {
      fs.rmSync(dir, { recursive: true, force: true });
      if (kind === 'memory') {
        // Memory docs get a sibling <id>/ wrapper solely to hold attachments/
        // (see attachmentsDirFor) - remove it too once it's empty.
        const wrapperDir = path.dirname(dir);
        if (fs.existsSync(wrapperDir) && fs.readdirSync(wrapperDir).length === 0) {
          fs.rmdirSync(wrapperDir);
        }
      }
    }
  }

  async list(kind: DocKind, docIdOrName: string): Promise<AttachmentEntry[]> {
    return (await this.getDoc(kind, docIdOrName)).attachments ?? [];
  }

  /** Absolute filesystem path for an attachment's file, for callers (e.g. MCP tools) that need to Read it. */
  async absolutePathFor(kind: DocKind, docIdOrName: string, filename: string): Promise<string> {
    const doc = await this.getDoc(kind, docIdOrName);
    return path.join(attachmentsDirFor(doc.source_path, kind), filename);
  }

  async reconcile(kind: DocKind, docIdOrName: string): Promise<{ orphans: string[]; unlisted: string[] }> {
    const doc = await this.getDoc(kind, docIdOrName);
    const dir = attachmentsDirFor(doc.source_path, kind);
    const declared = new Set((doc.attachments ?? []).map((a) => a.filename));
    const onDisk = new Set(listAttachmentFiles(dir));
    const orphans = [...declared].filter((f) => !onDisk.has(f));
    const unlisted = [...onDisk].filter((f) => !declared.has(f));
    return { orphans, unlisted };
  }
}

export { attachmentsDirFor };
