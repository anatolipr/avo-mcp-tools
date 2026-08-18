import path from 'node:path';

/** Joins `baseDir` with an optional caller-supplied subfolder, rejecting any attempt to escape baseDir. */
export function resolveWithinBase(baseDir: string, folder: string | undefined, fileName: string): string {
  const target = folder ? path.join(baseDir, folder, fileName) : path.join(baseDir, fileName);
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new Error(`folder "${folder}" escapes the source directory`);
  }
  return resolvedTarget;
}
