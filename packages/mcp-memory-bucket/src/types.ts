export type SkillStatus = 'stable' | 'beta' | 'unreviewed';

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
  metadata: {
    owner: string | null;
    status: SkillStatus;
    extends: string | null;
    [key: string]: string | null; // spec allows arbitrary additional string-valued keys
  };
  source_path: string; // filled in at runtime, not authored — path to the SKILL.md file
}

export type SkillDoc = SkillFrontmatter & { body: string };

export type MemoryKeyType = 'ticket' | 'freeform';
export type MemoryDocType =
  | 'plan'
  | 'spec'
  | 'sql'
  | 'testing-todo'
  | 'discovery'
  | 'session-summary'
  | 'other';
export type MemoryStatus = 'active' | 'shipped' | 'abandoned';

export interface MemoryFrontmatter {
  id: string;
  key: string;
  key_type: MemoryKeyType;
  description: string;
  doc_type: MemoryDocType;
  tags: string[];
  status: MemoryStatus;
  related_to: string | null;
  source_path: string;
}

export type MemoryDoc = MemoryFrontmatter & { body: string };

/** Normalizes a lookup key the same way for authoring and querying: uppercase, hyphenated. */
export function normalizeKey(key: string): string {
  return key.trim().toUpperCase().replace(/\s+/g, '-');
}
