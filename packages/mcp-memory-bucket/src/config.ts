import fs from 'node:fs';
import path from 'node:path';

export interface NamedRoot {
  name: string;
  path: string;
}

export interface BucketConfig {
  skillRoots: NamedRoot[];
  memoryRoots: NamedRoot[];
  cacheDbPath: string;
  configPath: string;
  baseDir: string;
}

/** A config-file source entry: either a bare path string, or an explicit {name, path}. */
type SourceEntry = string | { name: string; path: string };

interface ConfigFile {
  skill_sources?: SourceEntry[];
  memory_sources?: SourceEntry[];
}

function memoryDirFlag(argv: string[]): string | undefined {
  const idx = argv.indexOf('--memory-dir');
  return idx !== -1 ? argv[idx + 1] : undefined;
}

function readConfigFile(configPath: string): ConfigFile {
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as ConfigFile;
}

function nameFromPath(p: string): string {
  return path.basename(p);
}

function resolveRoots(entries: SourceEntry[], baseDir: string): NamedRoot[] {
  const roots = entries.map((entry) => {
    if (typeof entry === 'string') {
      return { name: nameFromPath(entry), path: path.resolve(baseDir, entry) };
    }
    return { name: entry.name, path: path.resolve(baseDir, entry.path) };
  });
  // de-dupe by resolved path (e.g. default + explicit config both pointing at ./skills)
  const seen = new Set<string>();
  return roots.filter((r) => (seen.has(r.path) ? false : (seen.add(r.path), true)));
}

export function loadConfig(cwd: string = process.cwd(), argv: string[] = process.argv): BucketConfig {
  const explicitDir = memoryDirFlag(argv) ?? process.env.MEMORY_BUCKET_DIR;
  const baseDir = explicitDir ? path.resolve(cwd, explicitDir) : cwd;
  // The config file lives alongside the cache DB in baseDir (which is cwd
  // itself unless --memory-dir/MEMORY_BUCKET_DIR points elsewhere) — this
  // must match where saveRoot/removeRoot write back to.
  const configPath = path.join(baseDir, 'memory-bucket.config.json');
  const overrides = readConfigFile(configPath);

  // Without an explicit config, only default to ./skills or ./docs when that
  // directory already exists on disk — otherwise a genuinely fresh directory
  // should report zero roots and trigger the first-run "add a root" UI,
  // rather than silently registering a directory that was never created.
  const defaultSkillSources = overrides.skill_sources ?? (fs.existsSync(path.resolve(baseDir, './skills')) ? ['./skills'] : []);
  const defaultMemorySources = overrides.memory_sources ?? (fs.existsSync(path.resolve(baseDir, './docs')) ? ['./docs'] : []);

  const skillRoots = resolveRoots(defaultSkillSources, baseDir);
  const memoryRoots = resolveRoots(defaultMemorySources, baseDir);

  return {
    skillRoots,
    memoryRoots,
    cacheDbPath: path.join(baseDir, '.memory-bucket-cache.sqlite'),
    configPath,
    baseDir,
  };
}

/**
 * Appends a new named root to the config file's skill_sources/memory_sources array,
 * creating the file if absent. Existing entries (bare strings or objects) are left
 * untouched — this only ever appends, never rewrites/normalizes prior entries.
 * Path is stored relative to baseDir when possible, for a portable config file.
 */
export function saveRoot(config: BucketConfig, kind: 'skill' | 'memory', root: NamedRoot): void {
  const current = readConfigFile(config.configPath);
  const key = kind === 'skill' ? 'skill_sources' : 'memory_sources';
  // Only append to whatever's already in the file — never inject the
  // ./skills or ./docs implicit default, since that default is applied at
  // load time (loadConfig), not stored; writing it here would silently turn
  // an implicit default into an explicit, possibly-unwanted config entry.
  const existing = current[key] ?? [];

  const storedPath = path.isAbsolute(root.path) ? path.relative(config.baseDir, root.path) || '.' : root.path;
  const next: ConfigFile = {
    ...current,
    [key]: [...existing, { name: root.name, path: storedPath }],
  };
  fs.writeFileSync(config.configPath, JSON.stringify(next, null, 2) + '\n');
}

/**
 * Removes a named root from the config file by name. Matches both explicit
 * {name, path} entries and bare-string entries (via their derived name).
 * No-op if the name isn't found (e.g. it only ever existed in-memory).
 */
export function removeRoot(config: BucketConfig, kind: 'skill' | 'memory', name: string): void {
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
