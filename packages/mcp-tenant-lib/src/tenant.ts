import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { SubmitPayload, ToolManifestEntry, CallMessage } from './types.js';

/**
 * Fires whenever the *shape* of the tenants map changes in a way a
 * dashboard/monitoring view would care about: a tenant created/disposed, a
 * connection opening/closing, or a connection's manifest/label changing.
 * Deliberately does NOT fire on ordinary state (Store) changes or waiting/
 * submitted flips — those are per-tenant form data, not "who's connected."
 * One process-wide emitter (not per-tenant) so a single dashboard SSE
 * stream can subscribe once for every channel rather than one listener per
 * tenant. See dashboard.ts for the consumer.
 */
export const dashboardEvents = new EventEmitter();
dashboardEvents.setMaxListeners(0);
function notifyDashboard() {
  dashboardEvents.emit('change');
}

/**
 * How long Tenant.call waits for some connection to reappear on a tenant
 * before giving up, when the connection it was targeting has already
 * vanished (see Tenant.call). Set comfortably above the client's 2s
 * reconnect retry (client-bridge.ts) so a single dropped-then-reconnected
 * socket doesn't surface as a failed call.
 */
const RECONNECT_GRACE_MS = 4_000;

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
  /**
   * Whether some caller currently has a `submitBus.once('submit', ...)`
   * listener registered — i.e. wait_for_submit / define_form({wait:true})
   * is actively blocked on this tenant right now. Tracked via submitBus's
   * own newListener/removeListener events (see constructor) rather than a
   * manual flag, so it can never drift from the real listener count.
   * Broadcast to the browser as a 'waiting' WS message so the UI can show
   * whether anyone is listening, without implying Submit is meaningless
   * when nobody currently is (see `submitted`).
   */
  waiting = false;
  /**
   * Whether the user has clicked Submit at least once since the form was
   * last (re)defined. Set unconditionally on the 'submit' WS message,
   * independent of `waiting` — the user can fill in and submit a form
   * with no agent currently waiting (e.g. it was defined with wait:false,
   * or the agent's turn ended), and a later wait_for_submit call or
   * list_fields read should be able to see that they're done.
   */
  submitted = false;
  /**
   * Timestamp of the most recent real edit to `store` (a field value
   * changing) or a successfully-applied `restoreState` (see below) —
   * distinct from `lastActivityAt`, which also counts reads/pings and
   * drives idle-sweep instead. Used solely to arbitrate `resync` messages
   * (ws.ts) when more than one browser tab reconnects to the same
   * recreated tenant: whichever tab's last edit is newer wins, rather than
   * whichever tab's resync happens to reach the server first.
   */
  lastStateChangeAt = 0;
  wsClients: Set<WebSocket>;
  connections = new Map<string, TenantConnection>();
  #legacyManifest?: ToolManifestEntry[];
  #legacySummary?: string;
  lastActivityAt: number;
  pendingCalls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  /**
   * One entry per MCP session currently bound to this tenant (each session
   * builds its own McpServer + registry via registerFn — see register.ts).
   * Under defaultTenantMode: 'shared' (http.ts), multiple concurrent MCP
   * sessions legitimately share one tenant, so this can't be a single
   * slot: overwriting it on each new session used to silently stop
   * syncing every *other* session's tool list on the next WS manifest
   * change, freezing their tools/list stale. addManifestToolRegistry /
   * removeManifestToolRegistry (called from mcp.ts around session
   * connect/close) keep this in sync with which sessions are live;
   * syncManifestToolRegistries() (called wherever the single sync() call
   * used to happen) fans out to all of them.
   */
  #manifestToolRegistries = new Set<{ sync(): void }>();

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
    this.store = new Store(initialValues); // placeholder; #attachStore below wires the real onChange listener
    this.submitBus = new EventEmitter();
    this.submitBus.setMaxListeners(0);
    this.submitBus.on('newListener', (event) => {
      if (event !== 'submit') return;
      queueMicrotask(() => this.#syncWaiting());
    });
    this.submitBus.on('removeListener', (event) => {
      if (event !== 'submit') return;
      this.#syncWaiting();
    });
    this.wsClients = new Set();
    this.lastActivityAt = Date.now();
    this.#attachStore(this.store);
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
    this.syncManifestToolRegistries();
  }

  registerConnection(id: string, socket: WebSocket) {
    this.connections.set(id, { id, socket, manifest: [], summary: undefined, label: undefined });
    this.wsClients.add(socket);
    notifyDashboard();
  }

  updateConnectionManifest(id: string, manifest: ToolManifestEntry[], summary?: string, label?: string) {
    const conn = this.connections.get(id);
    if (!conn) return; // connection closed/unknown — ignore a late message
    conn.manifest = manifest;
    conn.summary = summary;
    conn.label = label;
    this.syncManifestToolRegistries();
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
    this.syncManifestToolRegistries();
  }

  removeConnection(id: string) {
    const conn = this.connections.get(id);
    if (conn) this.wsClients.delete(conn.socket);
    this.connections.delete(id);
    this.syncManifestToolRegistries();
    notifyDashboard();
  }

  addManifestToolRegistry(registry: { sync(): void }) {
    this.#manifestToolRegistries.add(registry);
    registry.sync();
  }

  removeManifestToolRegistry(registry: { sync(): void }) {
    this.#manifestToolRegistries.delete(registry);
  }

  syncManifestToolRegistries() {
    for (const registry of this.#manifestToolRegistries) registry.sync();
    notifyDashboard();
  }

  /**
   * `connectionId` targets the call at one specific connection's socket —
   * this is what lets multiple tabs share a tenant without racing on each
   * other's responses. Passing `undefined` broadcasts to every socket on
   * the tenant, same as the old behavior; kept for the legacy/no-connections
   * test path.
   *
   * A reconnecting tab always gets a brand-new `connectionId` (see ws.ts),
   * so a call already in flight when its socket drops has no old id to
   * reconnect to. Rather than failing it immediately (the client's own 2s
   * reconnect loop — see client-bridge.ts — would very likely have
   * succeeded a moment later), we give it a short grace window to see if
   * *some* connection reappears on this tenant before giving up. This only
   * matters for the target-one-connection path: with a single-tab tenant
   * (the overwhelming common case) any reappearing connection is the same
   * tab; with multiple tabs the caller only reaches this path once the
   * specific one it wanted has already vanished, so re-targeting the sole
   * survivor (if there's exactly one) is still the best available guess.
   */
  call(connectionId: string | undefined, name: string, args: unknown, timeoutMs = 10_000, reconnectGraceMs = RECONNECT_GRACE_MS): Promise<unknown> {
    const id = randomUUID();
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pendingCalls.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.pendingCalls.delete(id)) reject(new Error(`call to "${name}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
    });

    const send = (targetConnectionId: string | undefined) => {
      const payload: CallMessage = { type: 'call', id, name, args };
      const raw = JSON.stringify(payload);

      if (targetConnectionId) {
        const conn = this.connections.get(targetConnectionId);
        if (conn && conn.socket.readyState === conn.socket.OPEN) conn.socket.send(raw);
      } else {
        for (const client of this.wsClients) {
          if (client.readyState === client.OPEN) client.send(raw);
        }
      }
    };

    if (connectionId && !this.connections.has(connectionId)) {
      this.waitForReconnect(reconnectGraceMs).then((revivedConnectionId) => {
        const pending = this.pendingCalls.get(id);
        if (!pending) return; // already timed out/resolved while we waited

        if (!revivedConnectionId) {
          this.pendingCalls.delete(id);
          pending.reject(new Error(`connection "${connectionId}" is no longer connected`));
          return;
        }
        send(revivedConnectionId);
      });
      return promise;
    }

    send(connectionId);
    return promise;
  }

  /**
   * Resolves with a live connection id once `this.connections` becomes
   * non-empty again within `graceMs`, or `undefined` on timeout. Polls
   * instead of hooking registerConnection directly to keep this
   * self-contained and cheap for the rare/short-lived window it's used in.
   */
  private waitForReconnect(graceMs: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      const deadline = Date.now() + graceMs;
      const poll = () => {
        const [first] = this.connections.keys();
        if (first) { resolve(first); return; }
        if (Date.now() >= deadline) { resolve(undefined); return; }
        setTimeout(poll, 250).unref();
      };
      poll();
    });
  }

  /**
   * Pushes an 'identify' message at one connection so its page can surface
   * something a human watching the browser will notice (alert/sound) — lets
   * an agent say "which tab is this" when several are bridged into one
   * channel. Fire-and-forget like rename_connection: no ack, and silently
   * a no-op if the connection has since closed.
   */
  identifyConnection(connectionId: string): boolean {
    const conn = this.connections.get(connectionId);
    if (!conn || conn.socket.readyState !== conn.socket.OPEN) return false;
    conn.socket.send(JSON.stringify({ type: 'identify', label: conn.label }));
    return true;
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

  #attachStore(store: Store<TValues>) {
    this.store = store;
    this.store.onChange((field, value) => {
      this.lastStateChangeAt = Date.now();
      this.broadcastUpdate(field, value);
    });
  }

  applyState(schema: TSchema, values: TValues) {
    this.store.dispose();
    this.schema = schema;
    this.#attachStore(new Store(values));
    this.submitted = false;
    this.broadcastReinit();
  }

  /**
   * Restores schema/values/submitted from a browser page's own live state
   * after this tenant was recreated empty (see the `recreated` init flag in
   * ws.ts) — unlike applyState (used by define_form to redefine a form),
   * this preserves `submitted` as reported by the page rather than always
   * resetting it, since a resync is recovering prior state, not starting a
   * new round.
   *
   * `changedAt` is the pushing page's own last-local-edit timestamp
   * (Date.now() when the user or agent last changed a field in that tab —
   * see mcp-form's client). When two tabs both reconnect to the same
   * recreated tenant, each pushes its own resync independently; without
   * this guard, whichever happens to reach the server first would win,
   * which has nothing to do with which tab actually has the fresher data.
   * Comparing against `lastStateChangeAt` (bumped by every real edit,
   * including a previously-applied resync) means an older resync arriving
   * after a newer one — or after the tenant was already touched some other
   * way, e.g. an agent's set_field — is ignored rather than clobbering it.
   * Returns whether the resync was applied.
   */
  restoreState(schema: TSchema, values: TValues, submitted: boolean, changedAt: number): boolean {
    if (changedAt < this.lastStateChangeAt) return false;
    this.store.dispose();
    this.schema = schema;
    this.#attachStore(new Store(values));
    this.submitted = submitted;
    this.lastStateChangeAt = changedAt;
    this.broadcastReinit();
    return true;
  }

  broadcastReinit() {
    const payload = JSON.stringify({ type: 'reinit', schema: this.schema, state: this.store.snapshot(), waiting: this.waiting, submitted: this.submitted });
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

  #syncWaiting() {
    const nowWaiting = this.submitBus.listenerCount('submit') > 0;
    if (nowWaiting === this.waiting) return;
    this.waiting = nowWaiting;
    const payload = JSON.stringify({ type: 'waiting', waiting: this.waiting });
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
    this.connections.clear();
  }
}

/**
 * URL-safe slug rule for agent-chosen channel names (see channel-tools.ts):
 * letters, digits, underscore, hyphen only. Channel names become part of the
 * form URL path (`/t/<id>`), so anything requiring percent-encoding is
 * rejected up front rather than silently mangled.
 */
function isValidChannelName(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

/**
 * Best-effort fixup for a browser-supplied channel name that fails
 * isValidChannelName — collapses any run of disallowed characters (spaces,
 * punctuation, etc.) into a single underscore and trims leading/trailing
 * underscores, e.g. "bulletino 222aaa" -> "bulletino_222aaa". Used only on
 * the WS connect path (ws.ts): a human renaming a bridged tab via a plain
 * `prompt()` has no reason to know or care about the exact slug rule, so
 * silently coercing their input into something valid is friendlier than a
 * hard 4404 reject with no recovery. Deliberately NOT applied to
 * join_channel (channel-tools.ts) — that's agent-driven, the tool
 * description already states the rule up front, and an agent silently
 * landing on a DIFFERENT name than it asked for is more likely to cause
 * confusion (e.g. mismatched describe_channel lookups) than a clear
 * rejection it can self-correct from.
 */
function sanitizeChannelName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
}

const tenants = new Map<string, Tenant<any, any>>();

function getOrCreateTenant<TSchema, TValues>(id: string, initialSchema: TSchema, initialValues: TValues): Tenant<TSchema, TValues> {
  let tenant = tenants.get(id);
  if (!tenant) {
    tenant = new Tenant(id, initialSchema, initialValues);
    tenants.set(id, tenant);
    notifyDashboard();
  }
  return tenant;
}

function disposeTenant(id: string) {
  tenants.get(id)?.dispose();
  tenants.delete(id);
  notifyDashboard();
}

function envMs(name: string, defaultMs: number): number {
  const raw = process.env[name];
  if (!raw) return defaultMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : defaultMs;
}

const TENANT_IDLE_TIMEOUT_MS = envMs('TENANT_IDLE_TIMEOUT_MS', 2 * 60 * 60 * 1000);
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

export { tenants, getOrCreateTenant, disposeTenant, startIdleSweep, isValidChannelName, sanitizeChannelName };
