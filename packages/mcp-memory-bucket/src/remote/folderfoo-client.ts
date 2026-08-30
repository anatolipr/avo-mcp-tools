import { getCredential, setCredential, clearCredential } from './credentials.js';

/** Thrown when a folderfoo call fails auth (expired/invalid token, refresh also failed). Callers should surface this as "reconnect via the web UI", not retry silently. */
export class FolderfooAuthError extends Error {
  constructor(server: string) {
    super(`folderfoo session expired for ${server} - reconnect via the web UI`);
    this.name = 'FolderfooAuthError';
  }
}

/** Thrown for any non-ok, non-401 folderfoo response — carries the HTTP status so callers can distinguish e.g. a 404 (file genuinely absent) from other failures without string-matching the message. */
export class FolderfooRequestError extends Error {
  constructor(public readonly status: number, message: string) {
    super(`folderfoo request failed (${status}): ${message}`);
    this.name = 'FolderfooRequestError';
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
    throw new FolderfooRequestError(res.status, (body as { error?: string }).error ?? res.statusText);
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

/** Thrown when a write targets a remote folder that no longer exists on folderfoo (deleted server-side since the last connect/UI-open sync). */
export class RemoteFolderGoneError extends Error {
  constructor(folderName: string) {
    super(`remote folder "${folderName}" no longer exists on folderfoo — reconnect or remove this source`);
    this.name = 'RemoteFolderGoneError';
  }
}

/**
 * Confirms `folderPath` still exists on `server` before a write proceeds. folderfoo's own
 * POST /save/:filename can never fail for a gone folder path — it unconditionally
 * `mkdirSync(userDir, { recursive: true })`s before writing, silently recreating (un-deleting) the
 * folder rather than erroring — so this is the only way to catch "the folder was deleted since we
 * last checked" before a write silently resurrects it. Per the settled design, a write into a
 * confirmed-gone folder should fail loudly (RemoteFolderGoneError), not silently recreate the
 * folder — the user may have deleted it deliberately. `folderPath === ''` (a source's own root) is
 * never gone (the user's account root always exists), so this only ever checks a non-root path.
 */
export async function assertRemoteFolderExists(server: string, baseDir: string, tenantId: string, folderPath: string, folderName: string): Promise<void> {
  if (!folderPath) return;
  const folders = await listFolders(server, baseDir, tenantId);
  if (!folders.some((f) => f.path === folderPath)) {
    throw new RemoteFolderGoneError(folderName);
  }
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

/**
 * Renames one file in place via POST /rename/:filename — a true filesystem rename on folderfoo's
 * side (handles the raw+.meta.json sidecar pair together, touches tags/search-index/watermark),
 * not a write-under-the-new-name-and-leave-the-old-one-behind. Used by MemoryRepository.rename()/
 * SkillRepository.rename() so a doc/skill renamed through this tool doesn't leave an orphaned
 * duplicate under its old name on folderfoo — the same on-disk `newPath.md`/`newDir/SKILL.md`
 * write those callers already do locally, now also propagated as a real rename remotely, instead
 * of write-new (create) + never delete-old.
 */
export async function renameFile(server: string, baseDir: string, tenantId: string, folderPath: string, name: string, newName: string): Promise<void> {
  await withAuth(
    server,
    baseDir,
    (jwt) =>
      fetch(`${server}/rename/${filenameParam(folderPath, name)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'x-tenant-id': tenantId, 'content-type': 'application/json' },
        body: JSON.stringify({ newName }),
      }),
    async () => undefined
  );
}

/**
 * Archives (soft-deletes) one file to the user's folderfoo trash via POST /trash/:filename —
 * removes it from the folder's live listing (so a future poll's changed-since/reconcileDeletions
 * no longer sees it there) without a hard, unrecoverable delete on folderfoo's own side. Used by
 * MemoryRepository.delete()/SkillRepository.delete() so deleting a doc through this tool actually
 * removes the remote copy too, instead of only the local mirror + cache row — previously the
 * remote file was never touched at all, so the NEXT poll would pull it right back in, making a
 * "deleted" doc silently reappear.
 */
export async function trashFile(server: string, baseDir: string, tenantId: string, folderPath: string, name: string): Promise<void> {
  await withAuth(
    server,
    baseDir,
    (jwt) =>
      fetch(`${server}/trash/${filenameParam(folderPath, name)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'x-tenant-id': tenantId },
      }),
    async () => undefined
  );
}

/**
 * Archives (soft-deletes) a whole folder subtree to the user's folderfoo trash via
 * DELETE /folders/<folderPath> — used by SkillRepository.delete(), since a skill's remote content
 * lives inside a directory named after the skill (<remoteFolderPath>/<skillName>/SKILL.md +
 * any attachments alongside it), not a single filename trashFile can address. `folderPath` is the
 * full tenant-relative path to trash (e.g. "memz/my-skill"), NOT query-encoded — this route takes
 * it as a wildcard path segment, unlike every other folderPath-bearing endpoint in this client
 * (which use a `?folderPath=` query param), because folderfoo's own route is DELETE /folders/*.
 */
export async function trashFolder(server: string, baseDir: string, tenantId: string, folderPath: string): Promise<void> {
  await withAuth(
    server,
    baseDir,
    (jwt) =>
      fetch(`${server}/folders/${folderPath.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${jwt}`, 'x-tenant-id': tenantId },
      }),
    async () => undefined
  );
}

/**
 * Renames/moves a whole folder subtree via POST /folders/rename — a true directory rename on
 * folderfoo's side (fs.renameSync, plus rewriting any shares nested inside it), not a
 * write-under-the-new-path-and-leave-the-old-one-behind. Used by SkillRepository.rename(), since a
 * skill's remote content lives inside a directory named after the skill
 * (<remoteFolderPath>/<skillName>/SKILL.md + any attachments alongside it) — renaming the skill
 * means renaming that whole directory, which trashFile/renameFile (single-filename operations)
 * can't address. `folderPath`/`newFolderPath` are full tenant-relative paths (e.g.
 * "memz/old-skill-name" / "memz/new-skill-name"), sent as JSON body fields per folderfoo's own
 * route (unlike the wildcard-path DELETE /folders/* trashFolder uses).
 */
export async function renameFolder(server: string, baseDir: string, tenantId: string, folderPath: string, newFolderPath: string): Promise<void> {
  await withAuth(
    server,
    baseDir,
    (jwt) =>
      fetch(`${server}/folders/rename`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'x-tenant-id': tenantId, 'content-type': 'application/json' },
        body: JSON.stringify({ folderPath, newFolderPath }),
      }),
    async () => undefined
  );
}

/**
 * Writes one file's raw BINARY content via POST /save/:filename — the attachment-file counterpart
 * to writeFile's markdown-string upload. Same endpoint, same auth/retry wrapper, just a Buffer body
 * and the attachment's own mime type instead of a fixed text/markdown content-type.
 *
 * NOT YET LIVE-VERIFIED against folderfoo: memory doc ids are deliberately stripped of hyphens
 * before ever reaching writeFile's `name` param, per a confirmed-in-production finding that
 * folderfoo's save endpoint silently drops non-[0-9a-zA-Z_] characters from the final filename
 * segment. Attachment filenames routinely contain dots and hyphens (e.g. "entity.java.hbs") that
 * this same stripping would mangle if it applies uniformly here too. This function intentionally
 * does NOT pre-sanitize the name (unlike memory ids) because that behavior hasn't been confirmed
 * for this endpoint/content-type combination from this client alone — verify with a real round-trip
 * (attach a dotted/hyphenated filename to a doc in a remote folder, then check the folderfoo UI
 * shows it unmangled) before relying on this for anything beyond best-effort.
 */
export async function writeBinaryFile(
  server: string,
  baseDir: string,
  tenantId: string,
  folderPath: string,
  name: string,
  data: Buffer,
  mimeType: string
): Promise<void> {
  await withAuth(
    server,
    baseDir,
    (jwt) =>
      fetch(`${server}/save/${filenameParam(folderPath, name)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'x-tenant-id': tenantId, 'content-type': mimeType },
        body: data,
      }),
    async () => undefined
  );
}
