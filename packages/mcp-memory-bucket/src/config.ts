import fs from 'node:fs';
import path from 'node:path';

export interface NamedFolder {
  name: string;
  path: string;
}

/**
 * A remote source's folderfoo coordinates, kept alongside (not inside)
 * NamedFolder — every existing consumer of NamedFolder.path (chokidar,
 * folderForFile, upsertFile's readMarkdownFile call) assumes a real local
 * directory, so a remote entry still resolves to a real local mirror
 * directory as its NamedFolder.path (see resolveFolders below); this is
 * the separate remote-specific metadata needed to poll/read/write against
 * folderfoo for that same mirror.
 */
export interface RemoteFolder {
  name: string;
  server: string;
  tenantId: string;
  folderPath: string;
  mirrorDir: string; // resolved local mirror directory - same value as the paired NamedFolder.path
}

/**
 * Which folderfoo deployment (if any) the web UI's "Connect folderfoo" flow
 * and page-level <folderfoo-profile-circle> widget point at. Unlike
 * mindfoo/bulletino/avotuner (each always browser-served from a fixed dev-
 * vs-prod URL, where `hostname.includes('local')` reliably tells the two
 * apart), mcp-memory-bucket is a CLI tool a user runs locally via npx/npm
 * start - its own page is ALWAYS localhost regardless of which folderfoo
 * deployment (if any) the user actually wants, so hostname-sniffing can't
 * distinguish "local dev" from "just running this tool locally." An
 * explicit switch instead: 'off' (default - no folderfoo integration at
 * all, matches every existing user's behavior with zero opt-in), 'dev'
 * (http://localhost:3000, folderfoo's own local dev server), 'cloud'
 * (the real hosted deployment, https://files.cuul.cc).
 */
export type FolderfooMode = 'off' | 'dev' | 'cloud';
const FOLDERFOO_DEV_HOST = 'http://localhost:3000';
const FOLDERFOO_CLOUD_HOST = 'https://files.cuul.cc';

export interface BucketConfig {
  skillFolders: NamedFolder[];
  memoryFolders: NamedFolder[];
  remoteSkillFolders: RemoteFolder[];
  remoteMemoryFolders: RemoteFolder[];
  cacheDbPath: string;
  configPath: string;
  baseDir: string;
  folderfooMode: FolderfooMode;
  folderfooHost: string | null; // resolved host for folderfooMode, or null when mode is 'off'
}

/** A config-file source entry: a bare path string, an explicit {name, path}, or a remote folderfoo folder. */
type SourceEntry =
  | string
  | { name: string; path: string }
  | { name: string; remote: { server: string; tenantId: string; folderPath: string } };

interface ConfigFile {
  skill_sources?: SourceEntry[];
  memory_sources?: SourceEntry[];
}

function isRemoteEntry(
  entry: SourceEntry
): entry is { name: string; remote: { server: string; tenantId: string; folderPath: string } } {
  return typeof entry === 'object' && 'remote' in entry;
}

/** Local mirror directory a remote source's content is synced into - see the RemoteFolder doc comment above. */
export function mirrorDirFor(baseDir: string, name: string): string {
  return path.join(baseDir, '.memory-bucket-remote-cache', sanitizeFolderName(name));
}

function memoryDirFlag(argv: string[]): string | undefined {
  const idx = argv.indexOf('--memory-dir');
  return idx !== -1 ? argv[idx + 1] : undefined;
}

function folderfooModeFlag(argv: string[]): string | undefined {
  const idx = argv.indexOf('--folderfoo-mode');
  return idx !== -1 ? argv[idx + 1] : undefined;
}

function resolveFolderfooMode(argv: string[]): FolderfooMode {
  const raw = (folderfooModeFlag(argv) ?? process.env.FOLDERFOO_MODE ?? 'off').toLowerCase();
  if (raw === 'dev' || raw === 'cloud' || raw === 'off') return raw;
  console.error(`[memory-bucket] unrecognized --folderfoo-mode/FOLDERFOO_MODE "${raw}" — expected off|dev|cloud, defaulting to "off"`);
  return 'off';
}

function folderfooHostFor(mode: FolderfooMode): string | null {
  if (mode === 'dev') return FOLDERFOO_DEV_HOST;
  if (mode === 'cloud') return FOLDERFOO_CLOUD_HOST;
  return null;
}

function readConfigFile(configPath: string): ConfigFile {
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as ConfigFile;
}

function nameFromPath(p: string): string {
  return path.basename(p);
}

/**
 * Resolves every configured source entry to a NamedFolder - for a remote
 * entry, NamedFolder.path is the local MIRROR directory (see mirrorDirFor),
 * not folderfoo itself, so every existing downstream consumer of
 * NamedFolder (chokidar, sync.ts's upsertFile/folderForFile) keeps working
 * completely unchanged. remoteFolders carries the folderfoo-specific
 * coordinates a remote entry also needs, threaded separately into the
 * poller rather than into NamedFolder/TableSyncSpec.
 */
function resolveFolders(entries: SourceEntry[], baseDir: string): { folders: NamedFolder[]; remoteFolders: RemoteFolder[] } {
  const remoteFolders: RemoteFolder[] = [];
  const folders = entries.map((entry) => {
    if (typeof entry === 'string') {
      return { name: nameFromPath(entry), path: path.resolve(baseDir, entry) };
    }
    if (isRemoteEntry(entry)) {
      const mirrorDir = mirrorDirFor(baseDir, entry.name);
      remoteFolders.push({ name: entry.name, ...entry.remote, mirrorDir });
      return { name: entry.name, path: mirrorDir };
    }
    return { name: entry.name, path: path.resolve(baseDir, entry.path) };
  });
  // de-dupe by resolved path (e.g. default + explicit config both pointing at ./skills)
  const seen = new Set<string>();
  const deduped = folders.filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)));
  return { folders: deduped, remoteFolders };
}

export function loadConfig(cwd: string = process.cwd(), argv: string[] = process.argv): BucketConfig {
  const explicitDir = memoryDirFlag(argv) ?? process.env.MEMORY_BUCKET_DIR;
  const baseDir = explicitDir ? path.resolve(cwd, explicitDir) : cwd;
  // The config file lives alongside the cache DB in baseDir (which is cwd
  // itself unless --memory-dir/MEMORY_BUCKET_DIR points elsewhere) — this
  // must match where saveFolder/removeFolder write back to.
  const configPath = path.join(baseDir, 'memory-bucket.config.json');
  const overrides = readConfigFile(configPath);

  // Without an explicit config, only default to ./skills or ./docs when that
  // directory already exists on disk — otherwise a genuinely fresh directory
  // should report zero folders and trigger the first-run "add a folder" UI,
  // rather than silently registering a directory that was never created.
  const defaultSkillSources = overrides.skill_sources ?? (fs.existsSync(path.resolve(baseDir, './skills')) ? ['./skills'] : []);
  const defaultMemorySources = overrides.memory_sources ?? (fs.existsSync(path.resolve(baseDir, './docs')) ? ['./docs'] : []);

  const { folders: skillFolders, remoteFolders: remoteSkillFolders } = resolveFolders(defaultSkillSources, baseDir);
  const { folders: memoryFolders, remoteFolders: remoteMemoryFolders } = resolveFolders(defaultMemorySources, baseDir);

  const folderfooMode = resolveFolderfooMode(argv);

  return {
    skillFolders,
    memoryFolders,
    remoteSkillFolders,
    remoteMemoryFolders,
    cacheDbPath: path.join(baseDir, '.memory-bucket-cache.sqlite'),
    configPath,
    baseDir,
    folderfooMode,
    folderfooHost: folderfooHostFor(folderfooMode),
  };
}

/**
 * Appends a new named folder to the config file's skill_sources/memory_sources array,
 * creating the file if absent. Existing entries (bare strings or objects) are left
 * untouched — this only ever appends, never rewrites/normalizes prior entries.
 * Path is stored relative to baseDir when possible, for a portable config file.
 */
export function saveFolder(config: BucketConfig, kind: 'skill' | 'memory', folder: NamedFolder): void {
  const current = readConfigFile(config.configPath);
  const key = kind === 'skill' ? 'skill_sources' : 'memory_sources';
  // Only append to whatever's already in the file — never inject the
  // ./skills or ./docs implicit default, since that default is applied at
  // load time (loadConfig), not stored; writing it here would silently turn
  // an implicit default into an explicit, possibly-unwanted config entry.
  const existing = current[key] ?? [];

  const storedPath = path.isAbsolute(folder.path) ? path.relative(config.baseDir, folder.path) || '.' : folder.path;
  const next: ConfigFile = {
    ...current,
    [key]: [...existing, { name: folder.name, path: storedPath }],
  };
  fs.writeFileSync(config.configPath, JSON.stringify(next, null, 2) + '\n');
}

/**
 * Appends a new REMOTE (folderfoo) source entry — same append-only behavior as saveFolder above,
 * but writes the `{name, remote: {...}}` shape instead of `{name, path}`. The JWT itself is never
 * written here — that's credentials.ts's job, kept in a separate untracked file (see its own doc
 * comment for why: this config file is a plain JSON file that might reasonably get committed/shared).
 */
export function saveRemoteFolder(
  config: BucketConfig,
  kind: 'skill' | 'memory',
  entry: { name: string; server: string; tenantId: string; folderPath: string }
): void {
  const current = readConfigFile(config.configPath);
  const key = kind === 'skill' ? 'skill_sources' : 'memory_sources';
  const existing = current[key] ?? [];
  const next: ConfigFile = {
    ...current,
    [key]: [
      ...existing,
      { name: entry.name, remote: { server: entry.server, tenantId: entry.tenantId, folderPath: entry.folderPath } },
    ],
  };
  fs.writeFileSync(config.configPath, JSON.stringify(next, null, 2) + '\n');
}

/** Lowercase-hyphenate a folder-derived name, same shape as skill names. */
export function sanitizeFolderName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Removes a named folder from the config file by name. Matches both explicit
 * {name, path} entries and bare-string entries (via their derived name).
 * No-op if the name isn't found (e.g. it only ever existed in-memory).
 */
export function removeFolder(config: BucketConfig, kind: 'skill' | 'memory', name: string): void {
  const current = readConfigFile(config.configPath);
  const key = kind === 'skill' ? 'skill_sources' : 'memory_sources';
  const existing = current[key];
  if (!existing) return;

  const filtered = existing.filter((entry) => {
    const entryName = typeof entry === 'string' ? nameFromPath(entry) : entry.name;
    return entryName !== name;
  });
  if (filtered.length === existing.length) return; // nothing matched, don't rewrite the file

  const next: ConfigFile = { ...current, [key]: filtered };
  fs.writeFileSync(config.configPath, JSON.stringify(next, null, 2) + '\n');
}

export const ATTACHMENT_MAX_BYTES = process.env.ATTACHMENT_MAX_BYTES
  ? Number(process.env.ATTACHMENT_MAX_BYTES)
  : 20 * 1024 * 1024; // 20MB default
