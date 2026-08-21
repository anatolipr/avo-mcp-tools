import { FOLDERFOO_HOST } from './server-config.js';

interface CloudUser {
  username: string;
  fullname: string;
}

interface AuthGuardModule {
  saveFile(filename: string, data: unknown, contentType?: string): Promise<void>;
  readFile(filename: string): Promise<unknown>;
  getCurrentUser(): Promise<CloudUser | null>;
}

// auth-guard.js is served live from folderfoo's own origin at runtime, not
// bundled — per folderfoo's integration guide, don't vendor these files so
// they stay current when the server's auth contract changes.
async function authGuard(): Promise<AuthGuardModule> {
  return import(/* @vite-ignore */ `${FOLDERFOO_HOST}/elements/auth-guard.js`);
}

// Saves the .smk container Blob as-is — no JSON re-encoding at this
// boundary, since the payload is binary, not text.
export async function saveToCloud(filename: string, container: Blob): Promise<void> {
  const { saveFile } = await authGuard();
  await saveFile(filename, container, 'application/octet-stream');
}

// readFile returns a Blob for files saved with a non-JSON contentType.
// Throws an Error with .status === 404 if nothing is saved under filename.
export async function loadFromCloud(filename: string): Promise<Blob> {
  const { readFile } = await authGuard();
  return (await readFile(filename)) as Blob;
}

export async function getCurrentCloudUser(): Promise<CloudUser | null> {
  const { getCurrentUser } = await authGuard();
  return getCurrentUser();
}
