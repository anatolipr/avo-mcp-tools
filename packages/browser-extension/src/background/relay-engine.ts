// Orchestrates a chat-relay session: automates the human's role in
// human-mcp-relay's manual copy/paste loop between a "chat tab" (an
// arbitrary chat UI, driven per its recipe) and an "app tab" (running
// human-mcp-relay, which exposes window.__humanMcpRelay.runCall for
// programmatic HUMAN-MCP CALL/RESULT dispatch - see relay.js).
//
// The background service worker is the only thing that can see both tabs at
// once (no content-script-to-content-script or tab-to-tab messaging path
// exists anywhere in this codebase) - this module is that mediator. Each
// round trip is a sequence of single chrome.scripting.executeScript
// round-trips (relay-completion-strategies.ts for the chat tab,
// injectScriptOnce for the app tab), never background-side DOM polling.
//
// Sessions are in-memory only, same as connected-tabs.ts - not persisted to
// chrome.storage, since a service-worker restart mid-session means the
// human just restarts the bridge from the popup (the same recovery a
// stalled MANUAL relay would need a human to notice and do by hand).
import { injectScriptOnce } from './script-injection.js';
import { sendMessageInTab, waitForReplyInTab } from './relay-completion-strategies.js';
import { getRecipe } from './relay-recipes-storage.js';
import { extractSentinelBlock } from '../shared/human-mcp-relay-protocol.js';
import { acquireSessionKeepalive, releaseSessionKeepalive } from './session-keepalive.js';
import type { Recipe, RelaySession } from '../shared/recipe-types.js';

const sessions = new Map<string, RelaySession>();
const stopFlags = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) cb();
}

export function onRelaySessionsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function listRelaySessions(): RelaySession[] {
  return [...sessions.values()];
}

function setStatus(sessionId: string, status: RelaySession['status'], patch?: Partial<RelaySession>): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  Object.assign(session, { status }, patch);
  notify();
}

let sessionCounter = 0;

export async function startRelaySession(
  chatTabId: number,
  appTabId: number,
  recipeId: string
): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  const recipe = await getRecipe(recipeId);
  if (!recipe) return { ok: false, error: `No recipe found with id "${recipeId}".` };

  const sessionId = `relay-${++sessionCounter}-${Date.now()}`;
  const session: RelaySession = { id: sessionId, chatTabId, appTabId, recipeId, status: 'idle' };
  sessions.set(sessionId, session);
  notify();

  void runSessionLoop(sessionId, recipe);

  return { ok: true, sessionId };
}

export function stopRelaySession(sessionId: string): void {
  stopFlags.add(sessionId);
}

// Forwards a HUMAN-MCP CALL/RESULT text block into the app tab's
// window.__humanMcpRelay.runCall (see human-mcp-relay's relay.js) and
// returns the formatted HUMAN-MCP RESULT text it resolves with.
async function forwardToAppTab(appTabId: number, callText: string): Promise<string> {
  // injectScriptOnce runs this string as `new Function(source)()` - a bare
  // expression statement at the top level of a function BODY is not
  // returned automatically (unlike an arrow function's implicit-return
  // expression body), so the leading `return` here is required, not
  // stylistic. Its absence was found live: this call silently resolved to
  // undefined/null with no thrown error every time, even though the same
  // logic worked correctly when manually wrapped with an explicit `return`.
  const code = `
    return (async () => {
      if (!window.__humanMcpRelay) {
        throw new Error('window.__humanMcpRelay not found on this tab - is human-mcp-relay loaded here?');
      }
      return await window.__humanMcpRelay.runCall(${JSON.stringify(callText)});
    })();
  `;
  const result = await injectScriptOnce(appTabId, code);
  if (typeof result !== 'string') {
    throw new Error(`forwardToAppTab: window.__humanMcpRelay.runCall did not return a string result (got ${typeof result}: ${JSON.stringify(result)}).`);
  }
  return result;
}

async function runSessionLoop(sessionId: string, recipe: Recipe): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  const startSentinel = recipe.callBlock?.startSentinel ?? 'HUMAN-MCP CALL';
  const endSentinel = recipe.callBlock?.endSentinel ?? 'HUMAN-MCP END';

  // The human is expected to have already pasted the primer into the chat
  // tab once, out of band, before starting this session - this loop begins
  // by waiting for whatever reply is already in flight (or about to be),
  // never by injecting the primer itself.
  let nextMessageForChat: string | undefined;

  // Held for the session's entire lifetime, not just around individual
  // executeScript calls - see session-keepalive.ts's header comment for why
  // a chrome.alarms wake alone isn't enough to prevent a worker suspension
  // from orphaning an in-flight wait.
  acquireSessionKeepalive(sessionId);
  try {
    for (;;) {
      if (stopFlags.has(sessionId)) {
        stopFlags.delete(sessionId);
        setStatus(sessionId, 'stopped');
        return;
      }

      if (nextMessageForChat !== undefined) {
        setStatus(sessionId, 'sending-result-to-chat');
        await sendMessageInTab(session.chatTabId, {
          inputSelector: recipe.input.selector,
          setVia: recipe.input.setVia,
          submitSelector: recipe.submit.selector,
          messageText: nextMessageForChat,
        });
        nextMessageForChat = undefined;
      }

      setStatus(sessionId, 'waiting-for-reply');
      const replyText = await waitForReplyInTab(session.chatTabId, {
        replyContainerSelector: recipe.reply.containerSelector,
        completion: recipe.completion,
      });

      const match = extractSentinelBlock(replyText, startSentinel, endSentinel);
      if (!match) {
        // Fail closed: never loop against non-protocol chat chatter. A
        // human must intervene rather than the extension silently hammering
        // the chat UI in a retry loop.
        setStatus(sessionId, 'error', {
          lastError: `No "${startSentinel}"..."${endSentinel}" block found in the chat's reply.`,
        });
        return;
      }

      setStatus(sessionId, 'forwarding-to-app', { lastCallAt: Date.now() });
      const resultText = await forwardToAppTab(session.appTabId, `${startSentinel}${match.tag ? `[${match.tag}]` : ''}\n${match.body}\n${endSentinel}`);

      nextMessageForChat = resultText;
    }
  } catch (e) {
    setStatus(sessionId, 'error', { lastError: e instanceof Error ? e.message : String(e) });
  } finally {
    releaseSessionKeepalive(sessionId);
  }
}
