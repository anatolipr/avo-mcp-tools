export interface Entry {
  _table: 'skills' | 'memory_docs';
  id: string;
  name: string;
  description: string;
  tags: string[];
  status: string;
  owner: string | null;
  doc_type: string | null;
  key_type: string | null;
  folder: string;
  mtime_ms: number;
  deprecated: boolean;
  paused: boolean;
  created_at: string | null;
}

export interface EntryDetail {
  id: string;
  name?: string; // skills only
  key?: string; // memory only
  key_type?: string; // memory only
  doc_type?: string; // memory only
  related_to?: string | null; // memory only
  extends?: string | null; // skills only
  trigger_phrases?: string[]; // skills only
  description: string;
  tags: string[];
  status: string;
  owner?: string | null; // skills only
  body: string;
  source_path: string;
  folder: string;
  deprecated?: boolean;
  paused?: boolean;
  created_at?: string | null;
  has_frontmatter?: boolean;
  /** True on-disk file content (frontmatter block + body), for the Raw view — distinct from
   * `body`, which is always frontmatter-stripped. */
  raw_file?: string;
}

export interface Facets {
  tags: string[];
  statuses: string[];
  owners: string[];
  doc_types: string[];
  key_types: string[];
  folders: string[];
}

export interface Folder {
  name: string;
  path: string;
  kind: 'skill' | 'memory';
}

export interface FoldersResponse {
  skill: Folder[];
  memory: Folder[];
}

export interface Selection {
  table: 'skills' | 'memory_docs';
  id: string;
}

export type TypeFilter = 'all' | 'skill' | 'memory';
