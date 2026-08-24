import { getCredential, setCredential, clearCredential } from './credentials.js';

/** Thrown when a folderfoo call fails auth (expired/invalid token, refresh also failed). Callers should surface this as "reconnect via the web UI", not retry silently. */
export class FolderfooAuthError extends Error {
  constructor(server: string) {
    super(`folderfoo session expired for ${server} - reconnect via the web UI`);
    this.name = 'FolderfooAuthError';
  }
}

interface LoginResult {
  jwt: string;
}

export async function login(server: string, username: string, password: string): Promise<LoginResult> {
  const res = await fetch(`${server}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`folderfoo login failed: ${(body as { error?: string }).error ?? res.statusText}`);
  }
  const { token } = (await res.json()) as { token: string };
  return { jwt: token };
}

/**
 * Reissues a fresh token from the current one - folderfoo's POST /refresh
 * accepts even an expired bearer token (verified server-side with
 * ignoreExpiration: true) and reissues a new one as long as the original
 * login is within its age window (origIat-based). There is no separate
 * refresh-token concept to pass here - see credentials.ts's doc comment.
 */
async function refresh(server: string, jwt: string): Promise<string> {
  const res = await fetch(`${server}/refresh`, {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) throw new FolderfooAuthError(server);
  const { token } = (await res.json()) as { token: string };
  return token;
}

/**
 * Resolves a usable, current JWT for `server`: returns the stored one, or
 * throws FolderfooAuthError if none is stored (the caller must direct the
 * user through the web UI's login flow - this module never prompts for
 * credentials itself). Does NOT proactively refresh; callers hit this once
 * per call and rely on withAuth's 401-retry-once instead, since a token
 * that still works needs no refresh round trip.
 */
function requireCredential(server: string, baseDir: string): string {
  const credential = getCredential(baseDir, server);
  if (!credential) throw new FolderfooAuthError(server);
  return credential.jwt;
}

/**
 * Wraps one folderfoo call: on a 401, attempts exactly one refresh-and-
 * retry (persisting the refreshed token so subsequent calls reuse it),
 * and on a second 401 (or a refresh failure) clears the stored credential
 * and throws FolderfooAuthError - per the settled design, a failure here
 * must surface loudly, never fall back to stale cached data or queue
 * silently.
 */
async function withAuth<T>(server: string, baseDir: string, call: (jwt: string) => Promise<Response>, parse: (res: Response) => Promise<T>): Promise<T> {
  const jwt = requireCredential(server, baseDir);
  let res = await call(jwt);
  if (res.status === 401) {
    let refreshed: string;
    try {
      refreshed = await refresh(server, jwt);
    } catch {
      clearCredential(baseDir, server);
      throw new FolderfooAuthError(server);
    }
    setCredential(baseDir, server, refreshed);
    res = await call(refreshed);
    if (res.status === 401) {
      clearCredential(baseDir, server);
      throw new FolderfooAuthError(server);
    }
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`folderfoo request failed (${res.status}): ${(body as { error?: string }).error ?? res.statusText}`);
  }
  return parse(res);
}

function folderQuery(tenantId: string, folderPath: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams({ folderPath, ...extra });
  return params.toString();
}

export async function getLastChanged(server: string, baseDir: string, tenantId: string, folderPath: string): Promise<number> {
  return withAuth(
    server,
    baseDir,
    (jwt) =>
      fetch(`${server}/folders/last-changed?${folderQuery(tenantId, folderPath)}`, {
        headers: { authorization: `Bearer ${jwt}`, 'x-tenant-id': tenantId },
      }),
    async (res) => ((await res.json()) as { lastChanged: number }).lastChanged
  );
}

/**
 * Lists the caller's own folderfoo folders (flat list of full paths, each
 * with a createdAt timestamp - folderfoo's own GET /folders response
 * shape) via folderfoo's existing GET /folders — used by the "connect a
 * folderfoo folder" UI to offer a picker instead of requiring the user to
 * type a raw folder path. Own folders only (no owner param) - browsing
 * INTO a shared folder someone else owns is a separate, not-yet-exposed
 * flow.
 */
export async function listFolders(server: string, baseDir: string, tenantId: string): Promise<Array<{ path: string; createdAt: string }>> {
  return withAuth(
    server,
    baseDir,
    (jwt) => fetch(`${server}/folders`, { headers: { authorization: `Bearer ${jwt}`, 'x-tenant-id': tenantId } }),
    (res) => res.json() as Promise<Array<{ path: string; createdAt: string }>>
  );
}

export interface ChangedFile {
  name: string;
  folderPath: string;
  mtime: number;
}

export async function getChangedSince(
  server: string,
  baseDir: string,
  tenantId: string,
  folderPath: string,
  since: number
): Promise<ChangedFile[]> {
  return withAuth(
    server,
    baseDir,
    (jwt) =>
      fetch(`${server}/folders/changed-since?${folderQuery(tenantId, folderPath, { since: String(since) })}`, {
        headers: { authorization: `Bearer ${jwt}`, 'x-tenant-id': tenantId },
      }),
    async (res) => ((await res.json()) as { files: ChangedFile[] }).files
  );
}

// folders.js's parseFolderFilenameParam (folderfoo's server) is ambiguous
// for a bare single-segment own-folder path: "work:name" parses as
// owner="work", not folderPath="work" (a folder path is only
// unambiguously recognized when it contains "/"). The always-safe form is
// the explicit-empty-owner 3-part grammar, ":folder/path:name" - folderfoo
// itself uses this same form in its own sharing tests for exactly this
// reason. Always use it here rather than only for the single-segment case,
// so this client doesn't need to special-case folder depth.
function filenameParam(folderPath: string, name: string): string {
  return folderPath ? `:${encodeURIComponent(folderPath)}:${name}` : name;
}

/**
 * Joins a RemoteFolder's own folderPath (its actual location on folderfoo,
 * e.g. "memz") with a path relative to the LOCAL mirror directory (e.g. a
 * subfolder the user created inside that mirror, or "." for the mirror's
 * own root). Repository call sites must always route through this rather
 * than passing the mirror-relative path alone - a bug where every remote
 * write dropped the RemoteFolder's own folderPath entirely (writing to the
 * user's folderfoo ROOT instead of the connected folder) shipped once
 * already because each of 4 call sites recomputed this by hand.
 */
export function joinRemoteFolderPath(remoteFolderPath: string, mirrorRelativeDir: string): string {
  if (mirrorRelativeDir === '.' || mirrorRelativeDir === '') return remoteFolderPath;
  return remoteFolderPath ? `${remoteFolderPath}/${mirrorRelativeDir}` : mirrorRelativeDir;
}

/** Reads one file's raw content via GET /data/:filename. */
export async function readFile(server: string, baseDir: string, tenantId: string, folderPath: string, name: string): Promise<string> {
  return withAuth(
    server,
    baseDir,
    (jwt) => fetch(`${server}/data/${filenameParam(folderPath, name)}`, { headers: { authorization: `Bearer ${jwt}`, 'x-tenant-id': tenantId } }),
    (res) => res.text()
  );
}

/** Writes one file's raw content via POST /save/:filename. */
export async function writeFile(server: string, baseDir: string, tenantId: string, folderPath: string, name: string, content: string): Promise<void> {
  await withAuth(
    server,
    baseDir,
    (jwt) =>
      fetch(`${server}/save/${filenameParam(folderPath, name)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'x-tenant-id': tenantId, 'content-type': 'text/markdown' },
        body: content,
      }),
    async () => undefined
  );
}
