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
  mtime_ms: number;
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
}

export interface Facets {
  tags: string[];
  statuses: string[];
  owners: string[];
  doc_types: string[];
  key_types: string[];
}

export interface Selection {
  table: 'skills' | 'memory_docs';
  id: string;
}

export type TypeFilter = 'all' | 'skill' | 'memory';
