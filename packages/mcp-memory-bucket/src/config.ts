import fs from 'node:fs';
import path from 'node:path';

export interface BucketConfig {
  skillSources: string[];
  memorySources: string[];
  cacheDbPath: string;
}

interface ConfigFile {
  skill_sources?: string[];
  memory_sources?: string[];
}

function memoryDirFlag(argv: string[]): string | undefined {
  const idx = argv.indexOf('--memory-dir');
  return idx !== -1 ? argv[idx + 1] : undefined;
}

export function loadConfig(cwd: string = process.cwd(), argv: string[] = process.argv): BucketConfig {
  const configPath = path.join(cwd, 'memory-bucket.config.json');
  const hasConfigFile = fs.existsSync(configPath);
  let overrides: ConfigFile = {};
  if (hasConfigFile) {
    overrides = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as ConfigFile;
  }

  const explicitDir = memoryDirFlag(argv) ?? process.env.MEMORY_BUCKET_DIR;

  const baseDir = explicitDir ? path.resolve(cwd, explicitDir) : cwd;

  const skillSources = (overrides.skill_sources ?? ['./skills']).map((p) => path.resolve(baseDir, p));
  const memorySources = (
    overrides.memory_sources ?? ['./docs/plans', './docs/specs']
  ).map((p) => path.resolve(baseDir, p));

  return {
    skillSources,
    memorySources,
    cacheDbPath: path.join(baseDir, '.memory-bucket-cache.sqlite'),
  };
}
