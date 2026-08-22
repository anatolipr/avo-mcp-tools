export interface MemoryChannel {
  name: string;
  content: string;
  lastActivityAt: number;
}

/**
 * URL-safe slug rule for agent-chosen channel names: letters, digits,
 * underscore, hyphen only. Mirrors mcp-tenant-lib's isValidChannelName —
 * duplicated rather than imported since this package has no other
 * dependency on mcp-tenant-lib and one shared regex isn't worth adding one.
 */
export function isValidChannelName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

const channels = new Map<string, MemoryChannel>();

/** Auto-vivifies on first reference, same as mcp-tenant-lib's getOrCreateTenant. */
export function getOrCreateChannel(name: string): MemoryChannel {
  let channel = channels.get(name);
  if (!channel) {
    channel = { name, content: '', lastActivityAt: Date.now() };
    channels.set(name, channel);
  }
  return channel;
}

export function getChannel(name: string): MemoryChannel | undefined {
  return channels.get(name);
}

export function listChannels(): MemoryChannel[] {
  return [...channels.values()];
}

function envMs(name: string, defaultMs: number): number {
  const raw = process.env[name];
  if (!raw) return defaultMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : defaultMs;
}

// Long-lived by design: a cross-agent discussion may span much longer gaps
// between contributions than a live form-fill session (mcp-tenant-lib's
// tenants default to a 30-minute idle timeout) — default here is ~24h.
const MEMORY_CHANNEL_IDLE_TIMEOUT_MS = envMs('MEMORY_CHANNEL_IDLE_TIMEOUT_MS', 24 * 60 * 60 * 1000);
const MEMORY_CHANNEL_SWEEP_INTERVAL_MS = envMs('MEMORY_CHANNEL_SWEEP_INTERVAL_MS', 30 * 60 * 1000);

export function startChannelSweep(onSweep: (name: string) => void) {
  const sweepInterval = setInterval(() => {
    const now = Date.now();
    for (const [name, channel] of channels) {
      if (now - channel.lastActivityAt > MEMORY_CHANNEL_IDLE_TIMEOUT_MS) {
        onSweep(name);
        channels.delete(name);
      }
    }
  }, MEMORY_CHANNEL_SWEEP_INTERVAL_MS);
  sweepInterval.unref();
  return sweepInterval;
}

// Test-only escape hatch, mirroring how mcp-tenant-lib's tests reach into
// its module-level `tenants` Map directly (see tenant.ts's `tenants` export).
export { channels };
