import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../store/atomic-write.js';
import { canonicalServer, serverNames } from './hosts.js';

/**
 * Persists folderfoo JWTs across memory-bucket server restarts, in a
 * separate untracked file next to memory-bucket.config.json (not inline in
 * it, per the settled design - a secret shouldn't sit in a file that might
 * get committed/shared). Keyed by server URL: multiple remote sources
 * pointing at the same folderfoo deployment share one login, and a second
 * deployment just adds a second key.
 *
 * folderfoo has no separate refresh-token concept (confirmed against
 * server.js's POST /refresh: it takes the SAME bearer token - even an
 * expired one, verified with `ignoreExpiration: true` - and reissues a
 * fresh one as long as the original login is within its age window,
 * tracked via the token's own `origIat` claim). So there's only ever one
 * token to persist per server, not a jwt/refreshToken pair.
 */
export interface CredentialStore {
  [server: string]: { jwt: string };
}

function credentialsPath(baseDir: string): string {
  return path.join(baseDir, '.memory-bucket-credentials.json');
}

function readStore(baseDir: string): CredentialStore {
  const file = credentialsPath(baseDir);
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as CredentialStore;
}

function writeStore(baseDir: string, store: CredentialStore): void {
  // 0600: this file holds a live JWT, so it shouldn't be group/world-
  // readable the way a config file might reasonably be.
  writeFileAtomic(credentialsPath(baseDir), JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
}

// Keys are canonical server URLs (see hosts.ts); a token saved under an alias of the cloud host
// (files.cuul.cc) is found under the new name and moved to it on the next write.
export function getCredential(baseDir: string, server: string): { jwt: string } | undefined {
  const store = readStore(baseDir);
  for (const name of serverNames(server)) if (store[name]) return store[name];
  return undefined;
}

export function setCredential(baseDir: string, server: string, jwt: string): void {
  const store = readStore(baseDir);
  for (const name of serverNames(server)) delete store[name];
  store[canonicalServer(server)] = { jwt };
  writeStore(baseDir, store);
}

export function clearCredential(baseDir: string, server: string): void {
  const store = readStore(baseDir);
  const names = serverNames(server).filter((name) => name in store);
  if (!names.length) return;
  for (const name of names) delete store[name];
  writeStore(baseDir, store);
}
