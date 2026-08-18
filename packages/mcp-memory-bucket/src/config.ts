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

export class MissingMemoryDirError extends Error {
  constructor() {
    super(
      'No memory folder configured. mcp-memory-bucket refuses to default to its ' +
        'launch directory, since that silently points memory at whatever folder ' +
        'the server happened to be started from.\n\n' +
        'Specify one explicitly via one of:\n' +
        "  - a memory-bucket.config.json file in the working directory (see README)\n" +
        '  - the MEMORY_BUCKET_DIR environment variable\n' +
        '  - the --memory-dir <path> CLI flag\n'
    );
    this.name = 'MissingMemoryDirError';
  }
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

  if (!hasConfigFile && !explicitDir) {
    throw new MissingMemoryDirError();
  }

  const baseDir = explicitDir ? path.resolve(cwd, explicitDir) : cwd;

  const skillSources = (overrides.skill_sources ?? ['./skills']).map((p) => path.resolve(baseDir, p));
  const memorySources = (
    overrides.memory_sources ?? ['./docs/superpowers/plans', './docs/superpowers/specs']
  ).map((p) => path.resolve(baseDir, p));

  return {
    skillSources,
    memorySources,
    cacheDbPath: path.join(cwd, '.memory-bucket-cache.sqlite'),
  };
}
