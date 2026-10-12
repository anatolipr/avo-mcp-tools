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
  /** Per-call timeout for this proxy's tools, in ms. Absent means the default (PROXY_CALL_TIMEOUT_MS, 60s) — see proxy-manager.ts's proxyCallTimeoutMs. */
  callTimeoutMs?: number;
  /**
   * sse / streamableHttp only. Authorizes against the upstream with OAuth
   * (the MCP authorization flow: discovery, dynamic client registration,
   * PKCE, token refresh) instead of, or as well as, static `headers`. `true`
   * is enough for a server that supports dynamic client registration; give
   * the object form a pre-registered `clientId` for one that does not. A
   * proxy that still needs a human to approve it reports `authUrl` in its
   * status — see proxy-manager.ts's completeProxyAuth.
   */
  oauth?: boolean | ProxyOAuthOptions;
  /**
   * When true the proxy exposes two tools — `list_tools` and `call_tool` —
   * instead of one per upstream tool, so a large upstream server costs two
   * descriptions in every session's tools/list, not hundreds. The upstream
   * tools are unchanged and all reachable through `call_tool`.
   */
  lazy?: boolean;
  paused: boolean;
}

export interface ProxyOAuthOptions {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
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
  /** Present when the proxy runs in lazy mode (see ProxyConfig.lazy); `toolCount` then still counts the upstream's tools. */
  lazy?: boolean;
  /** Present while an OAuth proxy waits for a human: open this URL in a browser to authorize it. */
  authUrl?: string;
}
