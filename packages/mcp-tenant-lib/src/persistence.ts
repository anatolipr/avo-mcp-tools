import fs from 'node:fs';
import path from 'node:path';
import { Tenant, tenants } from './tenant.js';

/**
 * On-disk shape of one tenant's durable state — deliberately narrow: no
 * connections, submitBus, waiting, or pendingCalls, since none of those mean
 * anything across a process restart. `submitted` is included so a form the
 * user finished filling out (but nobody has yet read via wait_for_submit)
 * doesn't silently reset to "not submitted" on restart.
 */
interface PersistedTenant<TSchema, TValues> {
  schema: TSchema;
  values: TValues;
  submitted: boolean;
  lastStateChangeAt: number;
  lastActivityAt: number;
}

/**
 * Debounce delay between a tenant edit and the write hitting disk. Keeps
 * rapid-fire field edits (typing in a text input broadcasts on every
 * keystroke) from turning into one fsync per keystroke, while staying well
 * under any timeframe a user would notice as "my edit wasn't saved".
 */
const WRITE_DEBOUNCE_MS = 500;

/**
 * Loads persisted tenant state from `filePath` (if present) and pre-seeds
 * the shared `tenants` map with it *before* any getOrCreateTenant('default')
 * call runs at boot — so a server restart comes back up with the last known
 * form schema/values already in place instead of blank defaults, without
 * requiring any browser tab to still be open to push a resync (see
 * Tenant.restoreState in tenant.ts, which only helps if a tab survived the
 * restart). Returns the set of tenant ids it seeded, purely for logging.
 *
 * Then wires a debounced save-on-change: any tenant currently in memory
 * (present or created afterward) that mutates its store gets its next
 * snapshot written back within WRITE_DEBOUNCE_MS. Polling `tenants`
 * directly (rather than requiring every getOrCreateTenant call site to opt
 * in) means callers of enablePersistence don't need to change how they
 * create tenants elsewhere in the codebase.
 */
export function enablePersistence<TSchema, TValues>(filePath: string): { seededIds: string[] } {
  const seededIds: string[] = [];

  let persisted: Record<string, PersistedTenant<TSchema, TValues>> = {};
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    persisted = JSON.parse(raw);
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      console.error(`[persistence] failed to read ${filePath}: ${err.message}`);
    }
  }

  for (const [id, state] of Object.entries(persisted)) {
    if (tenants.has(id)) continue;
    const tenant = new Tenant<TSchema, TValues>(id, state.schema, state.values);
    tenant.submitted = state.submitted;
    tenant.lastStateChangeAt = state.lastStateChangeAt;
    tenant.lastActivityAt = state.lastActivityAt;
    tenants.set(id, tenant);
    seededIds.push(id);
  }

  const writeToDisk = () => {
    const out: Record<string, PersistedTenant<TSchema, TValues>> = {};
    for (const [id, tenant] of tenants) {
      out[id] = {
        schema: tenant.schema,
        values: tenant.store.snapshot(),
        submitted: tenant.submitted,
        lastStateChangeAt: tenant.lastStateChangeAt,
        lastActivityAt: tenant.lastActivityAt,
      };
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(out));
    } catch (err: any) {
      console.error(`[persistence] failed to write ${filePath}: ${err.message}`);
    }
  };

  // Polls `lastStateChangeAt` (bumped on every real store edit or applied
  // resync — see Tenant#attachStore/restoreState) rather than subscribing
  // to each tenant's `store.onChange`, since define_form/resync/reconnect
  // all replace `tenant.store` with a brand-new Store (Tenant#attachStore),
  // which would silently drop a direct subscription. Polling at the same
  // cadence as the write debounce means a change is never more than one
  // interval late to be noticed, and comparing against a per-tenant
  // last-seen timestamp keeps this a no-op when nothing changed.
  const seen = new Map<string, number>();
  for (const [id, tenant] of tenants) seen.set(id, tenant.lastStateChangeAt);

  const pollInterval = setInterval(() => {
    let dirty = false;
    for (const [id, tenant] of tenants) {
      if (seen.get(id) !== tenant.lastStateChangeAt) {
        seen.set(id, tenant.lastStateChangeAt);
        dirty = true;
      }
    }
    for (const id of seen.keys()) {
      if (!tenants.has(id)) { seen.delete(id); dirty = true; } // tenant disposed (idle sweep)
    }
    if (dirty) writeToDisk();
  }, WRITE_DEBOUNCE_MS);
  pollInterval.unref();

  // A change followed by a kill within WRITE_DEBOUNCE_MS never reaches the
  // poll loop above, so the process's last bit of state would silently be
  // lost on an otherwise-ordinary Ctrl+C. Force one final synchronous write
  // before actually exiting so a quick restart doesn't drop it.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      writeToDisk();
      process.exit(0);
    });
  }

  return { seededIds };
}
