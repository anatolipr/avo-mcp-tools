/**
 * The hosted folderfoo moved from https://files.cuul.cc to https://scaffoldify.com. Both names
 * reach the same server, accounts and tokens, so the old one is an alias: remote folders,
 * credentials and shares saved under it keep working and are treated as the new host.
 * FOLDERFOO_CLOUD_HOST overrides the cloud host (e.g. to go back to files.cuul.cc).
 */
export const FOLDERFOO_CLOUD_HOST = (process.env.FOLDERFOO_CLOUD_HOST || 'https://scaffoldify.com').replace(/\/+$/, '');

const ALIASES = ['https://files.cuul.cc', 'https://scaffoldify.com', 'https://www.scaffoldify.com'];

/** A saved server URL as the current cloud host when it is one of its names; otherwise unchanged. */
export function canonicalServer(server: string): string {
  const clean = String(server || '').replace(/\/+$/, '');
  return ALIASES.includes(clean) && ALIASES.includes(FOLDERFOO_CLOUD_HOST) ? FOLDERFOO_CLOUD_HOST : clean;
}

/** Every name a server is known by: itself plus, for the cloud host, its aliases. */
export function serverNames(server: string): string[] {
  const canonical = canonicalServer(server);
  return canonical === FOLDERFOO_CLOUD_HOST && ALIASES.includes(canonical) ? [canonical, ...ALIASES.filter((a) => a !== canonical)] : [canonical];
}
