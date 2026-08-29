import type { AttachmentEntry } from './attachments/types.js';

// Free-form label, not a closed enum — conventional values are 'stable' | 'beta' | 'unreviewed',
// but any lowercase-hyphenated string is accepted (see shared/status.ts).
export type SkillStatus = string;

/**
 * Frontmatter for a skill's SKILL.md, per the agentskills.io open standard:
 * https://agentskills.io/specification
 *
 * `name` and `description` are the two spec-required fields — `name` must
 * equal the parent folder name (lowercase, hyphenated, <=64 chars) and is
 * this project's stable id. Everything memory-bucket needs beyond the spec
 * (owner/status/extends) lives in the spec's `metadata` string-map field, a
 * standard extension point clients are expected to ignore if unrecognized.
 * `tags`/`trigger_phrases` are arrays, so they can't live in `metadata`
 * (string values only) — they're extra top-level frontmatter keys instead,
 * which the spec permits alongside its own fields.
 */
export interface SkillFrontmatter {
  name: string; // required by spec; also the folder name and this project's id
  description: string; // required by spec
  license?: string;
  compatibility?: string;
  tags: string[];
  trigger_phrases: string[];
  attachments?: AttachmentEntry[];
  metadata: {
    owner: string | null;
    status: SkillStatus;
    extends: string | null;
    [key: string]: string | null; // spec allows arbitrary additional string-valued keys
  };
  deprecated?: boolean; // independent of metadata.status; defaults to false
  created_at?: string; // ISO date string, stamped once at create() time; absent on files predating this field
  source_path: string; // filled in at runtime, not authored — path to the SKILL.md file
  folder: string; // filled in at runtime, not authored — name of the configured folder this file lives under
}

// `paused` lives only in the SQLite cache (see SkillRepository#setPaused) — it is deliberately
// not part of SkillFrontmatter so it never gets written into SKILL.md's frontmatter.
export type SkillDoc = SkillFrontmatter & { body: string; paused: boolean };

export type MemoryKeyType = 'ticket' | 'freeform';
export type MemoryDocType =
  | 'plan'
  | 'spec'
  | 'sql'
  | 'testing-todo'
  | 'discovery'
  | 'session-summary'
  | 'other';
// Free-form label, not a closed enum — conventional values are 'active' | 'shipped' | 'abandoned',
// but any lowercase-hyphenated string is accepted (see shared/status.ts).
export type MemoryStatus = string;

export interface MemoryFrontmatter {
  key: string;
  key_type: MemoryKeyType;
  description: string;
  doc_type: MemoryDocType;
  tags: string[];
  attachments?: AttachmentEntry[];
  status: MemoryStatus;
  related_to: string | null;
  deprecated?: boolean; // independent of status; defaults to false
  created_at?: string; // ISO date string, stamped once at create() time; absent on docs predating this field
  source_path: string;
  folder: string;
}

// `paused` lives only in the SQLite cache (see MemoryRepository#setPaused) — it is deliberately
// not part of MemoryFrontmatter so it never gets written into the doc's markdown frontmatter.
export type MemoryDoc = MemoryFrontmatter & { body: string; paused: boolean };

/** Normalizes a lookup key the same way for authoring and querying: uppercase, hyphenated. */
export function normalizeKey(key: string): string {
  return key.trim().toUpperCase().replace(/\s+/g, '-');
}
