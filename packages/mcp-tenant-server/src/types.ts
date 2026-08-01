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
