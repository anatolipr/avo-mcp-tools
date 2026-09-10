// Types for chat-relay recipes: a JSON (not code) description of how to
// drive one chat UI's DOM - input box, submit button, reply container, and
// how to tell a reply has finished streaming - so bridging a new chat site
// (Gemini, ChatGPT, ...) into a human-mcp-relay session is pure JSON
// authoring against this fixed interface, never an extension code change.
// See relay-engine.ts for how these fields are actually interpreted, and
// docs/recipe-authoring.md + relay-recipes/recipe.schema.json for the
// authoring guide and formal schema an LLM should follow when drafting a
// new recipe against a live chat site.

export type SetViaStrategy = 'native-value-setter' | 'contenteditable-text';

export type CompletionStrategy = 'idle-mutation' | 'button-reappears' | 'disabled-toggle';

interface IdleMutationCompletion {
  strategy: 'idle-mutation';
  // Selector to observe for mutations; falls back to document.body if not found.
  observe: string;
  // Resolve once this many ms pass with no further mutations.
  idleMs: number;
  maxWaitMs: number;
}

interface ButtonReappearsCompletion {
  strategy: 'button-reappears';
  // Selector for a "stop generating"/regenerate-style button. Resolves once
  // this selector is seen present, then subsequently absent.
  watchSelector: string;
  maxWaitMs: number;
}

interface DisabledToggleCompletion {
  strategy: 'disabled-toggle';
  // Selector for an element (e.g. the submit button) whose `disabled`
  // property is watched. Resolves once it's seen disabled, then re-enabled.
  watchSelector: string;
  maxWaitMs: number;
}

export type CompletionConfig = IdleMutationCompletion | ButtonReappearsCompletion | DisabledToggleCompletion;

export interface Recipe {
  schemaVersion: 1;
  // Storage primary key - not hostname, so two recipes can target the same
  // hostname (e.g. UI variants) without colliding.
  id: string;
  hostname: string;
  displayName?: string;
  input: {
    selector: string;
    setVia: SetViaStrategy;
  };
  submit: {
    selector: string;
  };
  reply: {
    containerSelector: string;
    // Only 'last' is implemented - 'nth' is reserved/typed but rejected by
    // the validator until something actually needs it.
    pick: 'last' | 'nth';
  };
  completion: CompletionConfig;
  // Defaults to human-mcp-relay's own protocol.js sentinels
  // ('HUMAN-MCP CALL' / 'HUMAN-MCP END') when omitted.
  callBlock?: {
    startSentinel?: string;
    endSentinel?: string;
  };
}

export type RelaySessionStatus =
  | 'idle'
  | 'sending-to-chat'
  | 'waiting-for-reply'
  | 'forwarding-to-app'
  | 'sending-result-to-chat'
  | 'stopped'
  | 'error';

// Background-only runtime state, never persisted (a service-worker restart
// means the human restarts the bridge from the popup - same as a stalled
// manual relay needing a human to notice and recover).
export interface RelaySession {
  id: string;
  chatTabId: number;
  appTabId: number;
  recipeId: string;
  status: RelaySessionStatus;
  lastCallAt?: number;
  lastError?: string;
}
