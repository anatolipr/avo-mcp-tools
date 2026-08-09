// Same manifest contract as js-bridge-mcp's window.__mcpTools / mindfoo's
// mcpbridge.ts, adapted for a server-side (not in-browser) tool: a flat
// params object of primitive types, a real function reference, and an
// optional example call. See BRIDGING.md-equivalent notes in tools/registry.ts.

export type ParamType = 'string' | 'number' | 'boolean';

export interface ParamSpec {
  type: ParamType;
  description?: string;
  optional?: boolean;
}

export type ToolFn = (args: Record<string, unknown>) => unknown | Promise<unknown>;

export interface ToolDef {
  name: string;
  description: string;
  params: Record<string, ParamSpec>;
  example?: Record<string, unknown>;
  /** Destructive/risky tools (write/delete/run_command) require confirmation unless --yes was passed. */
  destructive?: boolean;
  fn: ToolFn;
}

export interface ToolCallResult {
  tool: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}
