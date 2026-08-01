import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { SubmitPayload, ToolManifestEntry, CallMessage } from './types.js';

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
  lastActivityAt: number;
  toolManifest: ToolManifestEntry[] = [];
  pendingCalls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  manifestToolRegistry?: { sync(): void };

  constructor(id: string, initialSchema: TSchema, initialValues: TValues) {
    this.id = id;
    this.schema = initialSchema;
    this.store = new Store(initialValues);
    this.submitBus = new EventEmitter();
    this.submitBus.setMaxListeners(0);
    this.wsClients = new Set();
    this.lastActivityAt = Date.now();
    this.store.onChange((field, value) => this.broadcastUpdate(field, value));
  }

  setToolManifest(manifest: ToolManifestEntry[]) {
    this.toolManifest = manifest;
    this.manifestToolRegistry?.sync();
  }

  call(name: string, args: unknown, timeoutMs = 10_000): Promise<unknown> {
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
    for (const client of this.wsClients) {
      if (client.readyState === client.OPEN) client.send(raw);
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
    for (const [, pending] of this.pendingCalls) {
      pending.reject(new Error('tenant disposed'));
    }
    this.pendingCalls.clear();
    for (const client of this.wsClients) client.close();
    this.wsClients.clear();
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
