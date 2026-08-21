// Vite replaces import.meta.env.VITE_* with a literal constant at build
// time, so this check (and anything gated behind it) is dead-code-eliminated
// from the npx-published bundle — only deploy.sh sets this var, so the
// folderfoo cloud-sync code never ships in the local, account-free build.
export const HOSTED = import.meta.env.VITE_SCREENMARKER_HOSTED === '1';
