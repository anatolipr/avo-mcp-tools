export { TENANT_ID } from '../shared/folderfoo-tenant.js';

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
