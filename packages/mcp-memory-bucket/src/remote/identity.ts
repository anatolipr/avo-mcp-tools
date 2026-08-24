import type { FolderfooMode, RemoteFolder } from '../config.js';

/**
 * Decodes the `username` claim out of a folderfoo JWT's payload — no
 * signature verification, since this only reads a claim from a token the
 * server already trusts enough to use against folderfoo itself (see
 * credentials.ts). folderfoo's signToken() payload shape is
 * {username, fullname, origIat, iat, exp} (folderfoo's own server.js) — no
 * sub/id/email/tenantId claim exists, so username is the stable identity key.
 */
export function decodeUsername(jwt: string): string {
  const payloadSegment = jwt.split('.')[1];
  if (!payloadSegment) throw new Error('malformed folderfoo token: missing payload segment');
  const payload = JSON.parse(Buffer.from(payloadSegment, 'base64').toString('utf-8')) as { username?: string };
  if (!payload.username) throw new Error('malformed folderfoo token: missing username claim');
  return payload.username;
}

export interface CurrentIdentity {
  mode: FolderfooMode;
  /** null = nobody logged in (fresh start, post-logout, or mode "off"). */
  username: string | null;
}

/**
 * Process-wide "who's currently logged in" tracker. `mode` is fixed for the
 * process's lifetime (only changes via a restart with a different
 * --folderfoo-mode flag, per the settled design) - only `username` is
 * mutable, driven by the browser's login/logout signals via
 * /api/folderfoo/login and /api/folderfoo/logout. There is no per-tab or
 * per-MCP-client identity: multiple browser tabs and MCP clients share this
 * one process-wide value, and the most recent login anywhere wins for all of
 * them (settled design decision — not a per-connection scope).
 */
export class IdentityTracker {
  private username: string | null = null;
  private listeners = new Set<(identity: CurrentIdentity) => void>();

  constructor(private readonly mode: FolderfooMode) {}

  current(): CurrentIdentity {
    return { mode: this.mode, username: this.username };
  }

  setUsername(username: string): void {
    if (this.username === username) return;
    this.username = username;
    this.emit();
  }

  clearUsername(): void {
    if (this.username === null) return;
    this.username = null;
    this.emit();
  }

  onIdentityChange(cb: (identity: CurrentIdentity) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    const identity = this.current();
    for (const cb of this.listeners) cb(identity);
  }
}

/** True when `folder` was connected under the identity currently logged in. */
export function matchesCurrentIdentity(folder: RemoteFolder, identity: CurrentIdentity): boolean {
  return identity.username !== null && folder.mode === identity.mode && folder.username === identity.username;
}

/** Local (non-remote) folders are always visible; a remote folder only when it matches the current identity. */
export function isFolderVisible(remote: RemoteFolder | undefined, identity: CurrentIdentity): boolean {
  return remote === undefined || matchesCurrentIdentity(remote, identity);
}
