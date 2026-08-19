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
  root: string;
  mtime_ms: number;
  deprecated: boolean;
  paused: boolean;
  created_at: string | null;
}

export interface EntryDetail {
  id: string;
  name?: string;
  key?: string;
  description: string;
  tags: string[];
  status: string;
  owner?: string | null;
  body: string;
  source_path: string;
  root: string;
  deprecated?: boolean;
  paused?: boolean;
  created_at?: string | null;
}

export interface Facets {
  tags: string[];
  statuses: string[];
  owners: string[];
  doc_types: string[];
  key_types: string[];
  roots: string[];
}

export interface Root {
  name: string;
  path: string;
  kind: 'skill' | 'memory';
}

export interface RootsResponse {
  skill: Root[];
  memory: Root[];
}

export interface Selection {
  table: 'skills' | 'memory_docs';
  id: string;
}

export type TypeFilter = 'all' | 'skill' | 'memory';
