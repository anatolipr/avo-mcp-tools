// memory-bucket's own fixed identity (X-Tenant-Id) as a folderfoo-consuming app — distinct from
// which folderfoo TENANT'S DATA a given remote skill/memory folder pulls from (could be this same
// tenant, or a different app's, e.g. mindfoo/bulletino). Has no node built-ins so it's safe to
// import from both the server (registering a remote folder) and the client bundle (the connect-a-
// folder modal) — the single source of truth for both, replacing what used to be two copies of the
// same string.
export const TENANT_ID = 'membkt';
