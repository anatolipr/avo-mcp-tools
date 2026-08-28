import type { Entry, Folder } from './types.js';

export interface TagNode {
  tag: string | null; // null = untagged bucket, always sorted last
  items: Entry[];
}

export interface FolderNode {
  folder: Folder;
  tagGroups: TagNode[];
}

/** Splits folders into local-first-then-remote sections, mirroring mem-bucket-app.ts's #allFolders(). */
export interface FolderSections {
  local: FolderNode[];
  remote: FolderNode[];
}

/**
 * Groups entries by tag only, ignoring folder — for Design C's cross-folder "Tag → Name" view. An
 * entry with N tags is pushed into every one of its tag buckets (Gmail-label style), not just its
 * first, so items from different folders sharing a tag land in the same bucket and an item can
 * appear more than once in the tree. Entries with zero tags land in a trailing `tag: null`
 * "(untagged)" bucket.
 */
export function groupByTag(entries: Entry[]): TagNode[] {
  const byTag = new Map<string | null, Entry[]>();
  for (const entry of entries) {
    const tags = entry.tags.length > 0 ? entry.tags : [null];
    for (const tag of tags) {
      const items = byTag.get(tag);
      if (items) items.push(entry);
      else byTag.set(tag, [entry]);
    }
  }
  return [...byTag.entries()]
    .map(([tag, items]) => ({ tag, items }))
    .sort((a, b) => {
      if (a.tag === null) return 1;
      if (b.tag === null) return -1;
      return a.tag.localeCompare(b.tag);
    });
}

/** Groups entries by folder for Design A (flat folder tree, no tag level). */
export function groupByFolder(entries: Entry[], allFolders: Folder[]): FolderSections {
  const byFolder = new Map<string, Entry[]>();
  for (const entry of entries) {
    const items = byFolder.get(entry.folder);
    if (items) items.push(entry);
    else byFolder.set(entry.folder, [entry]);
  }

  const local: FolderNode[] = [];
  const remote: FolderNode[] = [];
  for (const folder of allFolders) {
    const items = byFolder.get(folder.name);
    if (!items) continue;
    const node: FolderNode = { folder, tagGroups: [{ tag: null, items }] };
    (folder.remote ? remote : local).push(node);
  }
  return { local, remote };
}
