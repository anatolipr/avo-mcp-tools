// human-mcp-relay ships plain, undeclared .js (no .d.ts) - these ambient
// declarations cover only the two subpaths this package actually imports
// (see host-tool-relay.ts). Never add relay.js here - it's a CDN-importing,
// self-mounting UI element not meant to be bundled (see host-tool-relay.ts's
// header comment).
declare module 'human-mcp-relay/src/protocol.js' {
  export function parseCall(text: string, expectedSession?: string): { tool: string; args: Record<string, unknown> };
  export function formatResult(
    result: { tool: string; ok: boolean; data?: unknown; error?: string },
    sessionName?: string
  ): string;
}

declare module 'human-mcp-relay/src/primer.js' {
  export function buildPrimer(
    tools: Array<{ name: string; description?: string; params?: Record<string, { type: string; description?: string }>; example?: unknown }>,
    context?: { appName?: string; summary?: string; sessionName?: string }
  ): string;
}
