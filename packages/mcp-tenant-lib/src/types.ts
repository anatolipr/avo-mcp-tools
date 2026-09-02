export interface SubmitPayload {
  __interrupted: boolean;
  __disposed?: boolean;
  [field: string]: unknown;
}

export type ServerMessage<TSchema = unknown, TValues = unknown> =
  | { type: 'init'; schema: TSchema; state: TValues; waiting: boolean; submitted: boolean; recreated: boolean }
  | { type: 'reinit'; schema: TSchema; state: TValues; waiting: boolean; submitted: boolean }
  | { type: 'update'; field: string; value: unknown }
  | { type: 'waiting'; waiting: boolean }
  | { type: 'identify'; label?: string }
  | CallMessage;

export interface SetMessage {
  type: 'set';
  field: string;
  value: unknown;
}

/**
 * Sent by a page that reconnects to a tenant the server reports as
 * `recreated` (see the `init` message) — i.e. the in-memory tenant was
 * lost, most commonly an MCP server restart, while this page's own JS
 * runtime (and therefore its last-known schema/values) survived because
 * the tab itself never reloaded. Lets the still-live browser page push its
 * state back up as the source of truth instead of accepting the server's
 * freshly-recreated default state. The server applies it via the same
 * path as define_form (Tenant.applyState) and rebroadcasts `reinit` to any
 * other connected tabs.
 */
export interface ResyncMessage<TSchema = unknown, TValues = unknown> {
  type: 'resync';
  schema: TSchema;
  values: TValues;
  submitted: boolean;
  /**
   * The pushing page's own last-local-edit timestamp (Date.now()) — lets
   * the server arbitrate when two tabs both resync the same recreated
   * tenant, favoring whichever has the more recently edited data rather
   * than whichever resync message happens to arrive first. See
   * Tenant.restoreState in mcp-tenant-lib for the comparison.
   */
  changedAt: number;
}

export interface SubmitMessage {
  type: 'submit';
}

export interface InterruptMessage {
  type: 'interrupt';
}

/**
 * Sent by a page that is intentionally switching this socket off its
 * current channel (e.g. a connect-flow "rename to a different channel")
 * before it opens a fresh socket on the new one — distinct from an ordinary
 * unclean close (network drop, tab crash), which carries no such signal.
 * Lets the server dispose the old tenant immediately once this was its last
 * connection, instead of waiting out the empty-tenant grace window (see
 * Tenant.emptyAt / startEmptySweep in tenant.ts) for a channel the page
 * itself just told us it's done with. A no-op if other connections remain
 * on the tenant, or if it has already been disposed.
 */
export interface LeaveChannelMessage {
  type: 'leave_channel';
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
  /**
   * Optional page-authored app identity (e.g. document.title or
   * window.__mcpAppName). Used to disambiguate tool names and connections
   * when a tenant has more than one live WS connection. Sanitized
   * server-side into a slug; the raw value is only used as a display label.
   */
  appLabel?: string;
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

/**
 * Renames an already-registered connection's display label (and therefore
 * its tool-name prefix once re-slugged) without resending its whole
 * manifest. Fire-and-forget, like RegisterToolsMessage - no ack.
 */
export interface RenameConnectionMessage {
  type: 'rename_connection';
  appLabel: string;
}

export type ClientMessage = SetMessage | SubmitMessage | InterruptMessage | RegisterToolsMessage | CallResultMessage | RenameConnectionMessage | ResyncMessage | LeaveChannelMessage;
