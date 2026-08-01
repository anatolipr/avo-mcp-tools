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

export interface ToolManifestEntry {
  name: string;
  description: string;
  target: string; // window.* function name the page exposes
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
  target: string;
  args: unknown;
}

export interface CallResultMessage {
  type: 'call_result';
  id: string;
  result?: unknown;
  error?: string;
}

export type ClientMessage = SetMessage | SubmitMessage | InterruptMessage | RegisterToolsMessage | CallResultMessage;
