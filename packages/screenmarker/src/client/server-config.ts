// Picks the folderfoo backend host based on where this page is being
// served from. Matches mindfoo/bulletino-1/avotuner's convention: any
// hostname containing "local" is treated as a dev environment.
const isLocal = window.location.hostname.indexOf('local') > -1;

export const FOLDERFOO_HOST = isLocal
  ? 'http://localhost:3000'
  : 'https://files.cuul.cc';

// Identifies this app to folderfoo (X-Tenant-Id) so its users/data stay
// isolated from other consuming apps (mfoo, btno, avtn, ...).
export const TENANT_ID = 'scmk';
