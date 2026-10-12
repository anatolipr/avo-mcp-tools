import fs from 'node:fs';
import path from 'node:path';
import type { DynamicToolStore } from './tenant.js';
import type { ToolManifestEntry } from './types.js';

interface PersistedEntry {
  tools: ToolManifestEntry[];
  updatedAt: number;
}

/** An entry nobody has re-saved for this long belongs to a page that is gone; dropped at load so the file cannot grow without bound. */
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * JSON-file DynamicToolStore (see setDynamicToolStore in tenant.ts). The
 * file holds agent-authored JS source, so it is written owner-only (0600)
 * and via temp-file + rename, the same way js-bridge-mcp writes its proxy
 * config. A missing or unreadable file starts empty rather than failing: a
 * lost tool is recoverable, a server that will not start is not.
 */
export function createFileDynamicToolStore(filePath: string): DynamicToolStore {
  let entries: Record<string, PersistedEntry> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const now = Date.now();
      for (const [key, value] of Object.entries(parsed as Record<string, PersistedEntry>)) {
        if (value && Array.isArray(value.tools) && typeof value.updatedAt === 'number' && now - value.updatedAt < MAX_AGE_MS) {
          entries[key] = value;
        }
      }
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') console.error(`[mcp-tenant-lib] ignoring unreadable dynamic tool store ${filePath}: ${err?.message ?? err}`);
    entries = {};
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, filePath);
    } catch (err: any) {
      console.error(`[mcp-tenant-lib] failed to write dynamic tool store ${filePath}: ${err?.message ?? err}`);
    }
  }

  return {
    get: (key) => entries[key]?.tools,
    set(key, tools) {
      // Skip the write when nothing changed: every manifest re-send lands here.
      if (JSON.stringify(entries[key]?.tools) === JSON.stringify(tools)) return;
      entries[key] = { tools, updatedAt: Date.now() };
      save();
    },
    delete(key) {
      if (!(key in entries)) return;
      delete entries[key];
      save();
    },
  };
}
