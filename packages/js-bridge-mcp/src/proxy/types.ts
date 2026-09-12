export type ProxyTransport = 'stdio' | 'sse' | 'streamableHttp';

/**
 * Persisted, user-authored configuration for one proxied upstream MCP
 * server. `slug` doubles as its root connection's name (see proxy-manager.ts
 * — every proxy is a root connection, not a dedicated channel) and as the
 * tool-name prefix (`${slug}__${upstreamToolName}`) applied by the universal
 * always-prefix mechanism (manifest-tools.ts) — one identifier for both
 * roles keeps "which proxy is this" answerable the same way everywhere
 * (admin UI, describe_connection, window.__mcpTools).
 */
export interface ProxyConfig {
  id: string;
  slug: string;
  description?: string;
  transport: ProxyTransport;
  /** stdio only. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** sse / streamableHttp only. */
  url?: string;
  headers?: Record<string, string>;
  paused: boolean;
}

/** Live, in-memory-only view of one proxy — never persisted as-is. */
export interface ProxyStatus {
  id: string;
  slug: string;
  transport: ProxyTransport;
  paused: boolean;
  connected: boolean;
  toolCount: number;
  /** Upstream tools that connected but couldn't be registered (unsupported param schema) — see proxy-manager.ts's translateTools. Empty when nothing was skipped. */
  skippedTools: string[];
  lastError?: string;
}
