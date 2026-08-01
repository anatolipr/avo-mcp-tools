export interface SubmitPayload {
  __interrupted: boolean;
  __disposed?: boolean;
  [field: string]: unknown;
}

export type ServerMessage<TSchema = unknown, TValues = unknown> =
  | { type: 'init' | 'reinit'; schema: TSchema; state: TValues }
  | { type: 'update'; field: string; value: unknown };

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

export type ClientMessage = SetMessage | SubmitMessage | InterruptMessage;
