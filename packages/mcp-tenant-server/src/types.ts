export interface SubmitPayload {
  __interrupted: boolean;
  __disposed?: boolean;
  [field: string]: unknown;
}

export type ServerMessage<TSchema = unknown, TValues = unknown> =
  | { type: 'init' | 'reinit'; schema: TSchema; state: TValues }
  | { type: 'update'; field: string; value: unknown }
  | CallMessage;

export interface SetMessage {
  type: 'set';
  field: string;
  value: unknown;
}

export interface SubmitMessage {
  type: 'submit';
}

export interface InterruptMessage {
  type: 'interrupt';
}

export interface ToolParamSpec {
  type: 'string' | 'number' | 'boolean';
  description?: string;
  optional?: boolean;
}

/**
 * The wire form of a manifest entry, as sent to the server in a
 * RegisterToolsMessage. No function reference here — only JSON-serializable
 * fields. The page keeps the actual function (see PageToolDef in
 * client-bridge.ts) and dispatches on it locally when the server sends a
 * CallMessage back by `name`.
 */
export interface ToolManifestEntry {
  name: string;
  description: string;
  params: Record<string, ToolParamSpec>;
  example?: Record<string, unknown>;
}

export interface RegisterToolsMessage {
  type: 'register_tools';
  tools: ToolManifestEntry[];
  /**
   * Optional page-authored context shared across all tools in this manifest:
   * what kind of page/app this is, cross-tool sequencing rules ("call X
   * before Y"), and any domain concepts an agent needs before calling
   * individual tools blindly. Distinct from each tool's own `description` -
   * this is manifest-level, told once, not repeated per tool. Surfaced to
   * MCP clients via the `describe_tools` tool that createManifestToolRegistry
   * auto-registers (see manifest-tools.ts) since it arrives after the
   * McpServer is already constructed and can't be baked into static server
   * `instructions`.
   */
  summary?: string;
}

export interface CallMessage {
  type: 'call';
  id: string;
  name: string;
  args: unknown;
}

export interface CallResultMessage {
  type: 'call_result';
  id: string;
  result?: unknown;
  error?: string;
}

export type ClientMessage = SetMessage | SubmitMessage | InterruptMessage | RegisterToolsMessage | CallResultMessage;
