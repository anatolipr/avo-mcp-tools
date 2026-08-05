import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { SubmitPayload, ToolManifestEntry, CallMessage } from './types.js';

/**
 * One WS connection's own tool manifest/summary/label, addressable
 * independently of other connections sharing the same tenant (e.g. two
 * browser tabs pasted the same embed snippet). See manifest-tools.ts for
 * how multiple connections' tools get name-disambiguated.
 */
export interface TenantConnection {
  id: string;
  socket: WebSocket;
  label?: string;
  manifest: ToolManifestEntry[];
  summary?: string;
}

export class Store<TValues> {
  #values: TValues;
  #subscribers = new Set<(name: string, value: unknown) => void>();

  constructor(initial: TValues) {
    this.#values = initial;
  }

  has(name: string) { return Object.prototype.hasOwnProperty.call(this.#values as object, name); }
  get(name: string) { return (this.#values as Record<string, unknown>)[name]; }

  set(name: string, value: unknown) {
    (this.#values as Record<string, unknown>)[name] = value;
    for (const fn of this.#subscribers) fn(name, value);
  }

  snapshot(): TValues { return { ...this.#values }; }

  onChange(fn: (name: string, value: unknown) => void) {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  dispose() { this.#subscribers.clear(); }
}

/**
 * TSchema is set once per applyState call and is not itself reactive
 * (e.g. field definitions/labels). TValues is the reactive value bag
 * backing `store`, broadcast field-by-field over the WS `update` message.
 * Consumers with no separate schema concept can pass `undefined` for TSchema.
 */
export class Tenant<TSchema, TValues> {
  id: string;
  schema: TSchema;
  store: Store<TValues>;
  submitBus: EventEmitter;
  wsClients: Set<WebSocket>;
  connections = new Map<string, TenantConnection>();
  #legacyManifest?: ToolManifestEntry[];
  #legacySummary?: string;
  lastActivityAt: number;
  pendingCalls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  manifestToolRegistry?: { sync(): void };
  /**
   * Emits a 'connected' event with a TenantConnection the first time that
   * connection registers a non-empty tool manifest (see
   * updateConnectionManifest below) — i.e. the moment a pasted embed
   * snippet has actually finished handshaking, not just opened a socket.
   * wait_for_connection (js-bridge-mcp) blocks on this so an agent that
   * just handed out get_embed_snippet can learn what connected and
   * immediately follow up with describe_tools, instead of the connection
   * happening silently in the background.
   */
  connectionBus: EventEmitter;

  /**
   * Back-compat view over the per-connection manifests below: single flat
   * array/summary, meaningful for the 0-1-connection case (the overwhelming
   * majority — a single page/tab on this tenant). With 2+ connections this
   * flattens everything, which loses which tool belongs to which
   * connection — multi-connection-aware code (manifest-tools.ts) reads
   * `connections` directly instead.
   */
  get toolManifest(): ToolManifestEntry[] {
    if (this.connections.size === 0) return this.#legacyManifest ?? [];
    if (this.connections.size === 1) return [...this.connections.values()][0]!.manifest;
    return [...this.connections.values()].flatMap((c) => c.manifest);
  }

  get toolManifestSummary(): string | undefined {
    if (this.connections.size === 1) return [...this.connections.values()][0]!.summary;
    return this.#legacySummary;
  }

  constructor(id: string, initialSchema: TSchema, initialValues: TValues) {
    this.id = id;
    this.schema = initialSchema;
    this.store = new Store(initialValues);
    this.submitBus = new EventEmitter();
    this.submitBus.setMaxListeners(0);
    this.connectionBus = new EventEmitter();
    this.connectionBus.setMaxListeners(0);
    this.wsClients = new Set();
    this.lastActivityAt = Date.now();
    this.store.onChange((field, value) => this.broadcastUpdate(field, value));
  }

  /**
   * Legacy/no-WS path: registers a manifest with no real connection behind
   * it. Used directly by tests that construct a bare Tenant, and left in
   * place for any caller that doesn't (yet) know about individual
   * connections. Real WS-driven registration goes through
   * registerConnection/updateConnectionManifest instead (see ws.ts).
   */
  setToolManifest(manifest: ToolManifestEntry[], summary?: string) {
    this.#legacyManifest = manifest;
    this.#legacySummary = summary;
    this.manifestToolRegistry?.sync();
  }

  registerConnection(id: string, socket: WebSocket) {
    this.connections.set(id, { id, socket, manifest: [], summary: undefined, label: undefined });
    this.wsClients.add(socket);
  }

  updateConnectionManifest(id: string, manifest: ToolManifestEntry[], summary?: string, label?: string) {
    const conn = this.connections.get(id);
    if (!conn) return; // connection closed/unknown — ignore a late message
    const isFirstRegister = conn.manifest.length === 0;
    conn.manifest = manifest;
    conn.summary = summary;
    conn.label = label;
    this.manifestToolRegistry?.sync();
    if (isFirstRegister) this.connectionBus.emit('connected', conn);
  }

  /**
   * Updates only a connection's display label, leaving its manifest/summary
   * untouched — used by RenameConnectionMessage so a page can rename itself
   * (e.g. via __mcpRename) without resending its whole tool manifest.
   * Re-syncs so tool-name prefixes (computeSlugs in manifest-tools.ts)
   * reflect the new label immediately.
   */
  renameConnection(id: string, label: string) {
    const conn = this.connections.get(id);
    if (!conn) return; // connection closed/unknown — ignore a late message
    conn.label = label;
    this.manifestToolRegistry?.sync();
  }

  removeConnection(id: string) {
    const conn = this.connections.get(id);
    if (conn) this.wsClients.delete(conn.socket);
    this.connections.delete(id);
    this.manifestToolRegistry?.sync();
  }

  /**
   * `connectionId` targets the call at one specific connection's socket
   * (thrown if it's gone) — this is what lets multiple tabs share a tenant
   * without racing on each other's responses. Passing `undefined`
   * broadcasts to every socket on the tenant, same as the old behavior;
   * kept for the legacy/no-connections test path.
   */
  call(connectionId: string | undefined, name: string, args: unknown, timeoutMs = 10_000): Promise<unknown> {
    const id = randomUUID();
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pendingCalls.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pendingCalls.delete(id)) reject(new Error(`call to "${name}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
    });
    const payload: CallMessage = { type: 'call', id, name, args };
    const raw = JSON.stringify(payload);

    if (connectionId) {
      const conn = this.connections.get(connectionId);
      if (!conn) {
        this.pendingCalls.delete(id);
        throw new Error(`connection "${connectionId}" is no longer connected`);
      }
      if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(raw);
    } else {
      for (const client of this.wsClients) {
        if (client.readyState === client.OPEN) client.send(raw);
      }
    }
    return promise;
  }

  resolveCall(id: string, result: unknown) {
    const pending = this.pendingCalls.get(id);
    if (!pending) return;
    this.pendingCalls.delete(id);
    pending.resolve(result);
  }

  rejectCall(id: string, error: string) {
    const pending = this.pendingCalls.get(id);
    if (!pending) return;
    this.pendingCalls.delete(id);
    pending.reject(new Error(error));
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  applyState(schema: TSchema, values: TValues) {
    this.store.dispose();
    this.schema = schema;
    this.store = new Store(values);
    this.store.onChange((field, value) => this.broadcastUpdate(field, value));
    this.broadcastReinit();
  }

  broadcastReinit() {
    const payload = JSON.stringify({ type: 'reinit', schema: this.schema, state: this.store.snapshot() });
    for (const client of this.wsClients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  broadcastUpdate(field: string, value: unknown) {
    const payload = JSON.stringify({ type: 'update', field, value });
    for (const client of this.wsClients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  dispose() {
    this.submitBus.emit('submit', { __interrupted: true, __disposed: true, ...(this.store.snapshot() as object) } as SubmitPayload);
    this.store.dispose();
    this.submitBus.removeAllListeners();
    this.connectionBus.emit('disposed');
    this.connectionBus.removeAllListeners();
    for (const [, pending] of this.pendingCalls) {
      pending.reject(new Error('tenant disposed'));
    }
    this.pendingCalls.clear();
    for (const client of this.wsClients) client.close();
    this.wsClients.clear();
    this.connections.clear();
  }
}

const tenants = new Map<string, Tenant<any, any>>();

function getOrCreateTenant<TSchema, TValues>(id: string, initialSchema: TSchema, initialValues: TValues): Tenant<TSchema, TValues> {
  let tenant = tenants.get(id);
  if (!tenant) {
    tenant = new Tenant(id, initialSchema, initialValues);
    tenants.set(id, tenant);
  }
  return tenant;
}

function disposeTenant(id: string) {
  tenants.get(id)?.dispose();
  tenants.delete(id);
}

function envMs(name: string, defaultMs: number): number {
  const raw = process.env[name];
  if (!raw) return defaultMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : defaultMs;
}

const TENANT_IDLE_TIMEOUT_MS = envMs('TENANT_IDLE_TIMEOUT_MS', 30 * 60 * 1000);
const TENANT_SWEEP_INTERVAL_MS = envMs('TENANT_SWEEP_INTERVAL_MS', 5 * 60 * 1000);

function startIdleSweep(onSweep: (id: string) => void) {
  const sweepInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, tenant] of tenants) {
      if (id === 'default') continue;
      if (now - tenant.lastActivityAt > TENANT_IDLE_TIMEOUT_MS) {
        onSweep(id);
        disposeTenant(id);
      }
    }
  }, TENANT_SWEEP_INTERVAL_MS);
  sweepInterval.unref();
  return sweepInterval;
}

export { tenants, getOrCreateTenant, disposeTenant, startIdleSweep };
