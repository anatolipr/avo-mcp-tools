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

export function loadConfig(cwd: string = process.cwd()): BucketConfig {
  const configPath = path.join(cwd, 'memory-bucket.config.json');
  let overrides: ConfigFile = {};
  if (fs.existsSync(configPath)) {
    overrides = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as ConfigFile;
  }

  const skillSources = (overrides.skill_sources ?? ['./skills']).map((p) => path.resolve(cwd, p));
  const memorySources = (
    overrides.memory_sources ?? ['./docs/superpowers/plans', './docs/superpowers/specs']
  ).map((p) => path.resolve(cwd, p));

  return {
    skillSources,
    memorySources,
    cacheDbPath: path.join(cwd, '.memory-bucket-cache.sqlite'),
  };
}
