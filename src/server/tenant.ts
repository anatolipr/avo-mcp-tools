import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import type { FieldDef, FormDef, FieldValues } from '../shared/types.js';

export interface SubmitPayload {
  __interrupted: boolean;
  __disposed?: boolean;
  [field: string]: string | boolean | undefined;
}

export class Store {
  #values = new Map<string, string>();
  #subscribers = new Set<(name: string, value: string) => void>();

  constructor(fieldConfigs: FieldDef[]) {
    for (const f of fieldConfigs) {
      if (f.type === 'html_output') continue;
      this.#values.set(f.name, f.default ?? '');
    }
  }

  has(name: string) { return this.#values.has(name); }
  get(name: string) { return this.#values.get(name); }

  set(name: string, value: string) {
    this.#values.set(name, value);
    for (const fn of this.#subscribers) fn(name, value);
  }

  snapshot(): FieldValues { return Object.fromEntries(this.#values); }

  onChange(fn: (name: string, value: string) => void) {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  dispose() { this.#subscribers.clear(); }
}

export class Tenant {
  id: string;
  formDef: FormDef;
  store: Store;
  submitBus: EventEmitter;
  wsClients: Set<WebSocket>;
  lastActivityAt: number;

  constructor(id: string, initialFormDef: FormDef) {
    this.id = id;
    this.formDef = { title: initialFormDef.title ?? '', fields: initialFormDef.fields };
    this.store = new Store(this.formDef.fields);
    this.submitBus = new EventEmitter();
    this.submitBus.setMaxListeners(0);
    this.wsClients = new Set();
    this.lastActivityAt = Date.now();
    this.store.onChange((field, value) => this.broadcastUpdate(field, value));
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  applyFormDef(def: FormDef) {
    this.store.dispose();
    this.formDef = def;
    this.store = new Store(this.formDef.fields);
    this.store.onChange((field, value) => this.broadcastUpdate(field, value));
    this.broadcastReinit();
  }

  broadcastReinit() {
    const payload = JSON.stringify({ type: 'reinit', formDef: this.formDef, state: this.store.snapshot() });
    for (const client of this.wsClients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  broadcastUpdate(field: string, value: string) {
    const payload = JSON.stringify({ type: 'update', field, value });
    for (const client of this.wsClients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  dispose() {
    this.submitBus.emit('submit', { __interrupted: true, __disposed: true, ...this.store.snapshot() });
    this.store.dispose();
    this.submitBus.removeAllListeners();
    for (const client of this.wsClients) client.close();
    this.wsClients.clear();
  }
}

const tenants = new Map<string, Tenant>();

function getOrCreateTenant(id: string, initialFormDef: FormDef): Tenant {
  let tenant = tenants.get(id);
  if (!tenant) {
    tenant = new Tenant(id, initialFormDef);
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
