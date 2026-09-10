// Types for chat-relay recipes: a JSON (not code) description of how to
// drive one chat UI's DOM - input box, submit button, reply container, and
// how to tell a reply has finished streaming - so bridging a new chat site
// (Gemini, ChatGPT, ...) into a human-mcp-relay session is pure JSON
// authoring against this fixed interface, never an extension code change.
// See relay-chat-loop.ts for how these fields are actually interpreted -
// the chat tab's own injected loop owns the whole bridging session; the
// extension background is a stateless bus with no session concept at all
// (see relay-chat-loop.ts's and message-handler.ts's header comments). See
// docs/recipe-authoring.md + relay-recipes/recipe.schema.json for the
// authoring guide and formal schema an LLM should follow when drafting a
// new recipe against a live chat site. relay-recipes/SKILL.md documents the
// actual live investigative WORKFLOW used to author deepseek.json (using
// this extension's own js-bridge-mcp "extension" channel/inject_script) -
// read it before authoring a recipe for a new site.

export type SetViaStrategy = 'native-value-setter' | 'contenteditable-text';

export type CompletionStrategy = 'idle-mutation' | 'button-reappears' | 'disabled-toggle';

interface IdleMutationCompletion {
  strategy: 'idle-mutation';
  // Resolve once reply.containerSelector's last match's textContent has
  // stayed unchanged for this many ms. Polled (see relay-chat-loop.ts),
  // not MutationObserver-based - a prior MutationObserver-based design was
  // found live to hang permanently when the chat UI's framework (e.g.
  // React) replaced the observed DOM node wholesale during a re-render,
  // silently orphaning the observer with no further events ever firing.
  // Polling re-queries the DOM fresh every tick, so it can't go stale the
  // same way. There is no `observe` selector to configure - the poll
  // always targets whichever element is CURRENTLY the last
  // reply.containerSelector match, re-resolved every tick.
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

