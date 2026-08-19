import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { saveRoot, removeRoot as removeRootFromConfig, sanitizeRootName, type BucketConfig } from '../config.js';
import { initialScan, type TableSyncSpec } from '../store/sync.js';
import type { SkillRepository } from '../skills/repository.js';
import type { MemoryRepository } from '../memory/repository.js';

const KIND = z.enum(['skill', 'memory']);

export function registerBucketRootTools(
  mcp: McpServer,
  config: BucketConfig,
  skillRepo: SkillRepository,
  memoryRepo: MemoryRepository,
  db: Database.Database,
  skillSpec: TableSyncSpec<any>,
  memorySpec: TableSyncSpec<any>
): void {
  mcp.tool(
    'bucket_list_roots',
    'Lists the configured skill and memory roots (the named source directories skills/memory docs live under, e.g. "super-skills", "demo-skills", "builtin") — use this to see what roots exist before passing a `root` argument to a create/list/search tool, or before adding/removing one.',
    {},
    async () => {
      const skill = skillRepo.listRoots().map((r) => ({ ...r, kind: 'skill' as const }));
      const memory = memoryRepo.listRoots().map((r) => ({ ...r, kind: 'memory' as const }));
      return { content: [{ type: 'text', text: JSON.stringify({ skill, memory }, null, 2) }] };
    }
  );

  mcp.tool(
    'bucket_create_root',
    'Registers a new skill or memory root: an existing absolute directory path becomes a new named source that skill_create/memory_create can target via `root`. Scans it once and starts watching it live — never creates the directory itself, it must already exist.',
    {
      kind: KIND,
      path: z.string().describe('absolute path to an existing directory'),
      name: z.string().optional().describe('name for the root; defaults to a sanitized version of the directory\'s basename'),
    },
    async ({ kind, path: dirPath, name }) => {
      try {
        if (!path.isAbsolute(dirPath)) {
          return { content: [{ type: 'text', text: 'path must be an absolute directory path' }], isError: true };
        }
        if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
          return { content: [{ type: 'text', text: `not a directory: ${dirPath}` }], isError: true };
        }
        const rootName = sanitizeRootName(name || path.basename(dirPath));
        if (!rootName) {
          return { content: [{ type: 'text', text: 'could not derive a valid root name — provide one explicitly' }], isError: true };
        }
        const repo = kind === 'skill' ? skillRepo : memoryRepo;
        repo.addRoot({ name: rootName, path: dirPath });
        saveRoot(config, kind, { name: rootName, path: dirPath });
        return { content: [{ type: 'text', text: JSON.stringify({ name: rootName, path: dirPath, kind }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'bucket_delete_root',
    'Unregisters a skill or memory root by name: stops watching it and drops its cached entries from the index. Never touches files on disk — the directory and its contents are left in place.',
    { kind: KIND, name: z.string() },
    async ({ kind, name }) => {
      try {
        const repo = kind === 'skill' ? skillRepo : memoryRepo;
        repo.removeRoot(name);
        removeRootFromConfig(config, kind, name);
        return { content: [{ type: 'text', text: `Removed ${kind} root "${name}"` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );

  mcp.tool(
    'bucket_rebuild_cache',
    'EMERGENCY USE ONLY. Wipes the entire SQLite cache (all skills, memory docs, the full-text search index, and the date index) and rebuilds it from scratch by rescanning every configured root from disk. Source markdown files on disk are never touched — this only affects the derived cache, which is always safe to discard and regenerate. Use this only when other tools return results that contradict what you can see in the actual files (e.g. stale search hits, a doc that clearly exists on disk but skill_get/memory_get can\'t find, or search_by_date returning wrong dates) and a normal create/update/relocate call hasn\'t resolved it — this is a last resort, not a routine maintenance step. Takes a moment to complete on a large root; nothing else should be called until it returns.',
    {},
    async () => {
      try {
        db.exec(`DELETE FROM skills; DELETE FROM memory_docs; DELETE FROM search_index; DELETE FROM doc_dates;`);
        initialScan(db, skillSpec);
        initialScan(db, memorySpec);
        const skillCount = (db.prepare(`SELECT COUNT(*) AS n FROM skills`).get() as { n: number }).n;
        const memoryCount = (db.prepare(`SELECT COUNT(*) AS n FROM memory_docs`).get() as { n: number }).n;
        return {
          content: [
            { type: 'text', text: `Cache rebuilt from disk: ${skillCount} skill(s), ${memoryCount} memory doc(s) reindexed.` },
          ],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
  );
}
