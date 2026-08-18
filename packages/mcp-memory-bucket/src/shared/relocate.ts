import fs from 'node:fs';
import path from 'node:path';
import type { SkillRepository } from '../skills/repository.js';
import type { MemoryRepository } from '../memory/repository.js';
import { isValidSkillName } from '../store/skill-name.js';
import type { MemoryDocType, MemoryKeyType, MemoryStatus, SkillStatus } from '../types.js';

const TICKET_PATTERN = /([A-Z]{2,10}-\d+)/i;

export interface RelocateInferredMemory {
  key: string;
  key_type: MemoryKeyType;
  doc_type: MemoryDocType;
  description: string;
}

/**
 * Infers key/doc_type/description from a filename following the existing
 * plan/spec naming convention, e.g.
 * "2026-08-12-pde-433-partner-configuration-management-v3.md" under a
 * "plans/" folder → { key: "PDE-433", doc_type: "plan", description: "partner configuration management v3" }.
 * Returns null on a weak/ambiguous match — caller must not guess or partially move.
 */
export function inferMemoryFrontmatter(filePath: string): RelocateInferredMemory | null {
  const base = path.basename(filePath, path.extname(filePath));
  const ticketMatch = base.match(TICKET_PATTERN);
  if (!ticketMatch) return null;

  const key = ticketMatch[1]!.toUpperCase();
  const parentDir = path.basename(path.dirname(filePath)).toLowerCase();
  const ext = path.extname(filePath).toLowerCase();

  let docType: MemoryDocType = 'other';
  if (ext === '.sql') docType = 'sql';
  else if (parentDir.includes('plan')) docType = 'plan';
  else if (parentDir.includes('spec') || parentDir.includes('design')) docType = 'spec';
  else if (parentDir.includes('test')) docType = 'testing-todo';

  // Remainder of the slug after the date prefix and ticket token, de-hyphenated.
  const withoutDate = base.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  const withoutTicket = withoutDate.replace(new RegExp(ticketMatch[1]!, 'i'), '');
  const description = withoutTicket
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, ' ')
    .trim();

  if (!description) return null; // nothing left to distinguish this doc — ambiguous

  return { key, key_type: 'ticket', doc_type: docType, description };
}

export interface RelocateResult {
  moved: boolean;
  reason?: string;
  id?: string;
  target?: 'skill' | 'memory';
}

export interface RelocateOptions {
  path: string;
  target: 'skill' | 'memory';
  keep_original?: boolean;
  overrides?: {
    name?: string;
    description?: string;
    key?: string;
    key_type?: MemoryKeyType;
    doc_type?: MemoryDocType;
    tags?: string[];
    status?: SkillStatus | MemoryStatus;
    folder?: string;
  };
}

export function relocate(
  opts: RelocateOptions,
  skillRepo: SkillRepository,
  memoryRepo: MemoryRepository
): RelocateResult {
  if (!fs.existsSync(opts.path) || !fs.statSync(opts.path).isFile()) {
    return { moved: false, reason: `file not found or not readable: ${opts.path}` };
  }

  const body = fs.readFileSync(opts.path, 'utf-8').trim();

  if (opts.target === 'skill') {
    const name = opts.overrides?.name ?? slugFromFilename(opts.path);
    const description = opts.overrides?.description;
    // The spec requires description to state what the skill does AND when to
    // use it — that can't be responsibly guessed from a filename, unlike a
    // slug-derived name. Require it explicitly rather than writing a filler
    // description that would never trigger discovery correctly.
    if (!name || !isValidSkillName(name)) {
      return { moved: false, reason: `could not infer a valid skill name from filename — provide overrides.name (lowercase, hyphenated, <=64 chars)` };
    }
    if (!description) {
      return { moved: false, reason: 'skill description cannot be inferred from a filename — provide overrides.description (what it does and when to use it)' };
    }

    const doc = skillRepo.create(
      {
        name,
        description,
        owner: null,
        status: (opts.overrides?.status as SkillStatus) ?? 'unreviewed',
        tags: opts.overrides?.tags ?? [],
        trigger_phrases: [],
        extends: null,
      },
      body,
      opts.overrides?.folder
    );

    if (!opts.keep_original) fs.unlinkSync(opts.path);
    return { moved: true, id: doc.name, target: 'skill' };
  }

  // target === 'memory'
  const inferred = inferMemoryFrontmatter(opts.path);
  const key = opts.overrides?.key ?? inferred?.key;
  const description = opts.overrides?.description ?? inferred?.description;
  const docType = opts.overrides?.doc_type ?? inferred?.doc_type ?? 'other';
  const keyType = opts.overrides?.key_type ?? inferred?.key_type ?? 'freeform';

  if (!key || !description) {
    return {
      moved: false,
      reason: `filename does not clearly match the ticket-key naming pattern — ask the user for an explicit key and description, then retry with overrides.key/overrides.description`,
    };
  }

  const already = memoryRepo.getByKey(key, docType).find((d) => d.description === description);
  if (already) {
    return { moved: false, reason: `already relocated as memory doc "${already.id}"`, id: already.id, target: 'memory' };
  }

  const doc = memoryRepo.create({
    key,
    key_type: keyType,
    doc_type: docType,
    description,
    body,
    tags: opts.overrides?.tags,
    folder: opts.overrides?.folder,
  });

  if (!opts.keep_original) fs.unlinkSync(opts.path);
  return { moved: true, id: doc.id, target: 'memory' };
}

function slugFromFilename(filePath: string): string {
  return path
    .basename(filePath, path.extname(filePath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
