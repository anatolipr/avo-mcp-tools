// Identifies mcp-memory-bucket's own web UI to folderfoo (X-Tenant-Id) —
// this is memory-bucket's identity as a folderfoo-consuming app, distinct
// from the per-remote-source `tenantId` a user types into the connect-a-
// folder flow (add-folder-modal.ts), which addresses which folderfoo
// TENANT'S DATA a given remote skill/memory folder pulls from — could be
// this same tenant, or a different app's (mindfoo, bulletino), since
// memory-bucket mounts folders from other apps' storage, not just its own.
export const TENANT_ID = 'membkt';

export type FolderfooMode = 'off' | 'dev' | 'cloud';

export interface FolderfooConfig {
  folderfooMode: FolderfooMode;
  folderfooHost: string | null;
}

// Unlike mindfoo/bulletino/avotuner (each always browser-served from a
// fixed dev-vs-prod URL, so `hostname.includes('local')` reliably tells
// the two apart), mcp-memory-bucket's own page is ALWAYS localhost — it's
// a CLI tool a user runs on their own machine via npx/npm start,
// regardless of which folderfoo deployment (if any) they actually want.
// So this can't be a client-side hostname check like every other
// consuming app's server-config.ts; the server resolves the explicit
// --folderfoo-mode flag/FOLDERFOO_MODE env var (see config.ts) and the
// client just asks it via /api/config. Cached after the first call since
// this never changes for the lifetime of a page load.
let cached: Promise<FolderfooConfig> | undefined;

export function getFolderfooConfig(): Promise<FolderfooConfig> {
  if (!cached) {
    cached = fetch('/api/config')
      .then((res) => res.json())
      .catch(() => ({ folderfooMode: 'off' as const, folderfooHost: null }));
  }
  return cached;
}
