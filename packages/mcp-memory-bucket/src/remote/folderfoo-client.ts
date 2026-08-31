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

/**
 * `owner`, when passed, addresses a folder in someone ELSE's tree via a direct-username share —
 * every folderfoo route below that takes `owner` gates it through the same resolveUserDir/
 * hasAccess check the file-level `owner` param in filenameParam does (see that function's own
 * comment). Omitted entirely (not just falsy) for an own-folder call, matching folderfoo's own
 * `owner ? ... : caller's own dir` branching server-side.
 */
export async function getLastChanged(server: string, baseDir: string, tenantId: string, folderPath: string, owner?: string): Promise<number> {
  return withAuth(
    server,
    baseDir,
    (jwt) =>
      fetch(`${server}/folders/last-changed?${folderQuery(tenantId, folderPath, owner ? { owner } : undefined)}`, {
        headers: { authorization: `Bearer ${jwt}`, 'x-tenant-id': tenantId },
      }),
    async (res) => ((await res.json()) as { lastChanged: number }).lastChanged
  );
}

/**
 * Lists folderfoo folders via GET /folders — the caller's own when `owner`/`rootFolder` are
 * omitted, or a subtree someone else shared with the caller when both are passed (folderfoo gates
 * this via the same hasAccess check every other shared read uses, requiring `rootFolder` to be a
 * folder actually shared with the caller). Used by the "connect a folderfoo folder" UI's picker.
 */
export async function listFolders(
  server: string,
  baseDir: string,
  tenantId: string,
  options?: { owner?: string; rootFolder?: string }
): Promise<Array<{ path: string; createdAt: string }>> {
  const params = new URLSearchParams();
  if (options?.owner) params.set('owner', options.owner);
  if (options?.rootFolder) params.set('rootFolder', options.rootFolder);
  const qs = params.toString();
  return withAuth(
    server,
    baseDir,
    (jwt) => fetch(`${server}/folders${qs ? `?${qs}` : ''}`, { headers: { authorization: `Bearer ${jwt}`, 'x-tenant-id': tenantId } }),
    (res) => res.json() as Promise<Array<{ path: string; createdAt: string }>>
  );
}

export interface SharedWithMeEntry {
  name: string; // path on the owner's folderfoo, relative to their root (folderfoo's own field name)
  owner: string;
  type: 'file' | 'folder';
  size: number;
  createdAt: string;
  modifiedAt: string;
  role: 'member' | 'editor' | null;
  originId: string | null;
  kind: 'memory' | 'skill' | null;
}

/**
 * Lists everything (files and folders, from every owner) shared with the
 * current user via folderfoo's direct-username `shares` mechanism — see
 * folderfoo's GET /shared-with-me. Used ONLY by an explicit refresh action
 * (see remote/shared-items.ts's refreshSharedItems) — never polled on a
 * timer, per the settled "refresh is a UI-only concept" design. role/
 * originId/kind are null for a plain (non-mcp-memory-bucket) share, e.g. one
 * created before this feature existed or shared by a different app.
 */
export async function getSharedWithMe(server: string, baseDir: string, tenantId: string): Promise<SharedWithMeEntry[]> {
  return withAuth(
    server,
    baseDir,
    (jwt) => fetch(`${server}/shared-with-me`, { headers: { authorization: `Bearer ${jwt}`, 'x-tenant-id': tenantId } }),
    (res) => res.json() as Promise<SharedWithMeEntry[]>
  );
}

/**
 * Grants another folderfoo user direct access to one of the caller's own memory docs/skills, via
 * folderfoo's POST /share/:filename — the immediate, no-link-needed half of Phase 4's share UX
 * (paired with createShareLink/createPublicLink below for the out-of-band half). `kind` tags the
 * grant so a recipient's shared_items row (see shared-items.ts) never has to guess memory-vs-skill
 * from content — see folderfoo's shares.js v6->v7 migration for why this exists at all.
 */
export async function shareWithUser(
  server: string,
  baseDir: string,
  tenantId: string,
  folderPath: string,
  name: string,
  targetUsername: string,
  kind: 'memory' | 'skill',
  role: 'member' | 'editor'
): Promise<void> {
  await withAuth(
    server,
    baseDir,
    (jwt) =>
      fetch(`${server}/share/${filenameParam(folderPath, name)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'x-tenant-id': tenantId, 'content-type': 'application/json' },
        body: JSON.stringify({ username: targetUsername, kind, role }),
      }),
    async () => undefined
  );
}

/** Revokes a specific recipient's direct access via folderfoo's DELETE /share/:filename/:username. */
export async function unshareWithUser(
  server: string,
  baseDir: string,
  tenantId: string,
  folderPath: string,
  name: string,
  targetUsername: string
): Promise<void> {
  await withAuth(
    server,
    baseDir,
    (jwt) =>
      fetch(`${server}/share/${filenameParam(folderPath, name)}/${encodeURIComponent(targetUsername)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${jwt}`, 'x-tenant-id': tenantId },
      }),
    async () => undefined
  );
}

export interface CreatedLink {
  id: string;
  token: string;
  expiresAt: string;
}

/** Creates an out-of-band, login-required collaborator share link via folderfoo's POST /share-links. */
export async function createShareLink(
  server: string,
  baseDir: string,
  tenantId: string,
  folderPath: string,
  name: string,
  kind: 'memory' | 'skill'
): Promise<CreatedLink> {
  return withAuth(
    server,
    baseDir,
    (jwt) =>
      fetch(`${server}/share-links`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'x-tenant-id': tenantId, 'content-type': 'application/json' },
        body: JSON.stringify({ path: joinRemoteFolderPath(folderPath, name), type: 'file', kind }),
      }),
    (res) => res.json() as Promise<CreatedLink>
  );
}

/** Creates an anonymous, no-login-required public view link via folderfoo's POST /public-links. */
export async function createPublicLink(
  server: string,
  baseDir: string,
  tenantId: string,
  folderPath: string,
  name: string,
  kind: 'memory' | 'skill'
): Promise<CreatedLink> {
  return withAuth(
    server,
    baseDir,
    (jwt) =>
      fetch(`${server}/public-links`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'x-tenant-id': tenantId, 'content-type': 'application/json' },
        body: JSON.stringify({ path: joinRemoteFolderPath(folderPath, name), kind }),
      }),
    (res) => res.json() as Promise<CreatedLink>
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
export async function assertRemoteFolderExists(server: string, baseDir: string, tenantId: string, folderPath: string, folderName: string, owner?: string): Promise<void> {
  if (!folderPath) return;
  // A shared folder's OWN path never appears in listFolders' own-tree result (it isn't a
  // subdirectory of the caller's root) - list the owner's tree rooted at folderPath instead and
  // check for a non-empty (i.e. accessible) result, same "does this still resolve" intent as the
  // own-folder branch below, just via the owner-aware GET /folders shape (see listFolders' comment).
  if (owner) {
    await listFolders(server, baseDir, tenantId, { owner, rootFolder: folderPath }).catch(() => {
      throw new RemoteFolderGoneError(folderName);
    });
    return;
  }
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
  since: number,
  owner?: string
): Promise<ChangedFile[]> {
  return withAuth(
    server,
    baseDir,
    (jwt) =>
      fetch(`${server}/folders/changed-since?${folderQuery(tenantId, folderPath, { since: String(since), ...(owner ? { owner } : {}) })}`, {
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
//
// `owner`, when passed, addresses a path in someone ELSE's directory (a
// direct-username share, resolved via folderfoo's shares table rather than
// the caller's own files) - see resolveUserDir on the server side, which
// treats a bare (owner-less) filename as always the CALLER's own directory.
// Every other caller of this function addresses its own files and omits it.
function filenameParam(folderPath: string, name: string, owner?: string): string {
  if (owner) return `${encodeURIComponent(owner)}:${folderPath ? encodeURIComponent(folderPath) : ''}:${name}`;
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

/**
 * Reads one file's raw content via GET /data/:filename. `owner`, when passed, reads a file from
 * someone ELSE's directory via a direct-username share (see filenameParam's own comment) - used by
 * shared-items.ts to pull a shared item's content, since the caller here is the share's RECIPIENT,
 * not the file's owner.
 */
export async function readFile(server: string, baseDir: string, tenantId: string, folderPath: string, name: string, owner?: string): Promise<string> {
  return withAuth(
    server,
    baseDir,
    (jwt) => fetch(`${server}/data/${filenameParam(folderPath, name, owner)}`, { headers: { authorization: `Bearer ${jwt}`, 'x-tenant-id': tenantId } }),
    (res) => res.text()
  );
}

/**
 * Writes one file's raw content via POST /save/:filename. `owner`, when passed, writes into
 * someone ELSE's directory via a direct-username share (see filenameParam's own comment) — this is
 * gated 'editor'-role-only server-side (see folderfoo's resolveUserDir(..., 'editor') on this
 * route), so a 'member' (read-only) shared folder correctly 403s here rather than silently
 * succeeding against the caller's own directory instead.
 */
export async function writeFile(server: string, baseDir: string, tenantId: string, folderPath: string, name: string, content: string, owner?: string): Promise<void> {
  await withAuth(
    server,
    baseDir,
    (jwt) =>
      fetch(`${server}/save/${filenameParam(folderPath, name, owner)}`, {
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
export async function renameFile(server: string, baseDir: string, tenantId: string, folderPath: string, name: string, newName: string, owner?: string): Promise<void> {
  await withAuth(
    server,
    baseDir,
    (jwt) =>
      fetch(`${server}/rename/${filenameParam(folderPath, name, owner)}`, {
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
export async function trashFile(server: string, baseDir: string, tenantId: string, folderPath: string, name: string, owner?: string): Promise<void> {
  await withAuth(
    server,
    baseDir,
    (jwt) =>
      fetch(`${server}/trash/${filenameParam(folderPath, name, owner)}`, {
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
export async function trashFolder(server: string, baseDir: string, tenantId: string, folderPath: string, owner?: string): Promise<void> {
  const qs = owner ? `?owner=${encodeURIComponent(owner)}` : '';
  await withAuth(
    server,
    baseDir,
    (jwt) =>
      fetch(`${server}/folders/${folderPath.split('/').map(encodeURIComponent).join('/')}${qs}`, {
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
export async function renameFolder(server: string, baseDir: string, tenantId: string, folderPath: string, newFolderPath: string, owner?: string): Promise<void> {
  await withAuth(
    server,
    baseDir,
    (jwt) =>
      fetch(`${server}/folders/rename`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'x-tenant-id': tenantId, 'content-type': 'application/json' },
        body: JSON.stringify({ folderPath, newFolderPath, owner }),
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
  mimeType: string,
  owner?: string
): Promise<void> {
  await withAuth(
    server,
    baseDir,
    (jwt) =>
      fetch(`${server}/save/${filenameParam(folderPath, name, owner)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'x-tenant-id': tenantId, 'content-type': mimeType },
        body: data,
      }),
    async () => undefined
  );
}
