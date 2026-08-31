import { getFolderfooConfig } from './server-config.js';
import { TENANT_ID } from './server-config.js';

/**
 * Detail shape folderfoo's auth-guard.js dispatches on "folderfoo-share-redeemed" — see that
 * file's own comment (and this repo's Phase 0 fix) for why this is a `document` event, not
 * `window`, unlike every OTHER event auth-guard.js dispatches (folderfoo-auth-change,
 * folderfoo-share-links-joined). origin_id/kind are present only for a share created by (or
 * pointing at) an mcp-memory-bucket item — null for a plain file/folder share from some other app.
 */
interface ShareRedeemedDetail {
  owner: string;
  path: string;
  type: 'file' | 'folder';
  role?: 'member' | 'editor' | null;
  originId?: string | null;
  kind?: 'memory' | 'skill' | null;
}

let started = false;

/**
 * Wires up folderfoo's `?shareToken=`/`?publicToken=` accept flow, mirroring exactly what
 * Bulletino/mindfoo already do (see their index.html / mind-foo-app.ts): dynamically import
 * folderfoo's hosted auth-guard.js, let IT strip the URL param and redeem/resolve it (this app
 * never touches the token itself), and react to the resulting event. Unlike those two apps —
 * which only ever act on `type: 'file'` opens and explicitly drop a `type: 'folder'` redemption on
 * the floor since they have no folder browser — mcp-memory-bucket is the first consumer to act on
 * a redemption that carries an item-share `originId`/`kind` (see shared-items.ts's addSharedItem),
 * turning it into a new row in the "Shared with me" panel instead of opening a document.
 *
 * Called once per page load from mem-bucket-app.ts's connectedCallback. No-ops entirely when
 * folderfoo integration is off (no host configured) — matches every other folderfoo widget mount
 * in this codebase (see #mountFolderfooProfileCircle's identical off-mode guard).
 */
export async function startShareAccept(onSharedItemAccepted: (entry: {
  owner: string;
  path: string;
  originId: string;
  kind: 'memory' | 'skill';
  role: 'member' | 'editor';
  server: string;
  tenantId: string;
}) => void): Promise<void> {
  if (started) return;
  started = true;

  const { folderfooMode, folderfooHost } = await getFolderfooConfig();
  if (folderfooMode === 'off' || !folderfooHost) return;

  // Only bother importing auth-guard.js at all if the URL actually carries one of its params —
  // every other page load (the overwhelming majority) skips the network round-trip entirely.
  const url = new URL(window.location.href);
  const hasShareToken = url.searchParams.has('shareToken');
  const hasPublicToken = url.searchParams.has('publicToken');
  if (!hasShareToken && !hasPublicToken) return;

  document.addEventListener('folderfoo-share-redeemed', (e) => {
    const detail = (e as CustomEvent<ShareRedeemedDetail>).detail;
    if (!detail?.owner || !detail?.path) return;
    // A type:'folder' redemption, or one with no originId/kind, isn't an item-level share this
    // app knows how to file anywhere yet (same "nothing to open here" outcome Bulletino/mindfoo
    // already reach for a folder link — see their own listeners) — silently ignored rather than
    // erroring, since the link itself redeemed successfully.
    if (detail.type !== 'file' || !detail.originId || !detail.kind) return;
    onSharedItemAccepted({
      owner: detail.owner,
      path: detail.path,
      originId: detail.originId,
      kind: detail.kind,
      role: detail.role ?? 'member',
      server: folderfooHost,
      tenantId: TENANT_ID,
    });
  });

  document.addEventListener('folderfoo-share-redeem-failed', (e) => {
    const message = (e as CustomEvent<{ message?: string }>).detail?.message;
    // eslint-disable-next-line no-alert -- matches Bulletino/mindfoo's own handling of this event
    alert(message || 'This link is invalid or has expired.');
  });

  try {
    const [authGuard, apiClient] = await Promise.all([
      import(/* @vite-ignore */ `${folderfooHost}/elements/auth-guard.js`),
      import(/* @vite-ignore */ `${folderfooHost}/elements/api-client.js`),
    ]);
    apiClient.setTenantId(TENANT_ID);
    if (hasShareToken) authGuard.redeemShareTokenFromUrl();
    if (hasPublicToken) {
      // Public links are always read-only and need no folderfoo login (see folderfoo's
      // GET /public/:token) — resolved directly here rather than through the same
      // redeemShareTokenFromUrl path, since accepting one never touches the `shares` table at all.
      const token = url.searchParams.get('publicToken')!;
      url.searchParams.delete('publicToken');
      window.history.replaceState(null, '', url.toString());
      const granted = await authGuard.getPublicLink(token).catch((err: Error) => {
        alert(err.message || 'This link is invalid or has expired.');
        return null;
      });
      if (granted?.type === 'file' && granted.originId && granted.kind) {
        onSharedItemAccepted({
          owner: granted.owner,
          path: granted.path,
          originId: granted.originId,
          kind: granted.kind,
          role: 'member',
          server: folderfooHost,
          tenantId: TENANT_ID,
        });
      }
    }
  } catch (err) {
    console.error('[memory-bucket] failed to load folderfoo share-accept widgets:', err);
  }
}
