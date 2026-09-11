// Source of the MAIN-world function injected once into a chat tab at
// "Start bridging" time (see message-handler.ts's start-relay-bridge
// handler). From that point on, THIS INJECTED CODE owns the entire
// session loop, running permanently in the page's own JS realm - the
// extension's background service worker has no further involvement beyond
// acting as a one-hop, opaque message bus for forwarding calls to the app
// tab(s) (see relay-bus-isolated.ts). There is no session registry in the
// extension itself: the chat tab either has this loop running or it
// doesn't, and stopping a bridge is done by reloading or closing the chat
// tab - not by any message or signal this code listens for. The ONE piece
// of session state that does exist (win.__mcpRelayAppTabs, a tag -> app
// tab id map supporting more than one bridged app tab per chat) lives only
// in this same injected page realm, for the same reason and with the same
// reload-wipes-it lifetime as everything else here - it is not a
// background-held registry.
//
// Lives under src/background/ (not src/content-scripts/), matching how the
// deleted relay-completion-strategies.ts worked: chrome.scripting.executeScript's
// `func:` parameter takes a real function reference from this module,
// serialized by source text at call time - this is NOT a
// registerContentScripts-based persistent injection (those survive future
// navigations; this is a one-shot injection for the CURRENT page load only,
// which is exactly what's wanted here).
//
// func callbacks below run in the target page's context (which has
// `window`/`document`), not this file's own service-worker context - cast
// through `globalThis as any` since this file compiles under
// tsconfig.background.json (webworker lib, no DOM lib).
import type { CompletionConfig, Recipe, SetViaStrategy } from '../shared/recipe-types.js';

export interface ChatLoopConfig {
  // The first app tab bridged at "Start bridging" time, keyed by its
  // human-mcp-relay session name/tag (see human-mcp-relay/protocol.js's
  // [sessionName] sentinel tagging) - '' if that app tab had no session name
  // set, matching the untagged-sentinel case. Additional app tabs are added
  // later via the addAppTab bus message (see below); all live entries are
  // held in the injected loop's own appTabsByTag map, not here - this is
  // only the seed for that map at injection time.
  initialAppTag: string;
  initialAppTabId: number;
  inputSelector: string;
  setVia: SetViaStrategy;
  submitSelector: string;
  replyContainerSelector: string;
  completion: CompletionConfig;
  startSentinel: string;
  endSentinel: string;
  // Primer text fetched from the app tab (window.__humanMcpRelay.getPrimer())
  // at "Start bridging" time - if present, the loop sends it as the very
  // first message before waiting for any reply, replacing the manual
  // "copy primer from app tab, paste into chat tab" step. Undefined (not
  // sent at all) if the app tab had no primer available (e.g.
  // window.__humanMcpRelay wasn't found there) - the human is expected to
  // paste it manually in that case, same as before this existed.
  initialPrimer?: string;
}

export function buildChatLoopConfig(appTabId: number, appTag: string, recipe: Recipe, initialPrimer?: string): ChatLoopConfig {
  return {
    initialAppTag: appTag,
    initialAppTabId: appTabId,
    inputSelector: recipe.input.selector,
    setVia: recipe.input.setVia,
    submitSelector: recipe.submit.selector,
    replyContainerSelector: recipe.reply.containerSelector,
    completion: recipe.completion,
    startSentinel: recipe.callBlock?.startSentinel ?? 'HUMAN-MCP CALL',
    endSentinel: recipe.callBlock?.endSentinel ?? 'HUMAN-MCP END',
    initialPrimer,
  };
}

// The MAIN-world injected function itself. Everything it needs is passed in
// via `configJson` - chrome.scripting.executeScript serializes `func` by
// source text, so this function must be fully self-contained (no closures
// over this module's outer scope reach the injected copy). Ported (not
// re-invoked per cycle via repeated executeScript calls, the OLD design)
// from the deleted relay-completion-strategies.ts's sendMessageInTab/
// waitForReplyInTab/countRepliesInTab and human-mcp-relay-protocol.ts's
// extractSentinelBlock - same proven completion-detection logic, now living
// permanently in the page instead of being re-injected by the background on
// every step.
export function chatLoopMainFunction(configJson: string): void {
  const config = JSON.parse(configJson) as {
    initialAppTag: string;
    initialAppTabId: number;
    inputSelector: string;
    setVia: string;
    submitSelector: string;
    replyContainerSelector: string;
    completion:
      | { strategy: 'idle-mutation'; idleMs: number; maxWaitMs: number }
      | { strategy: 'button-reappears'; watchSelector: string; maxWaitMs: number }
      | { strategy: 'disabled-toggle'; watchSelector: string; maxWaitMs: number };
    startSentinel: string;
    endSentinel: string;
    initialPrimer?: string;
  };

  const doc = (globalThis as any).document;
  const win = globalThis as any;

  // Duplicate-start guard: a single well-known flag, not per-session (there
  // is no session id in this design) - a second injection into a tab
  // already running the loop is a silent no-op. The only way to run a NEW
  // loop on this tab is to reload/close it first, which clears this flag
  // along with the whole JS realm.
  if (win.__mcpRelayLoopActive) return;
  win.__mcpRelayLoopActive = true;

  // The entire multi-app-tab session state: tag (human-mcp-relay session
  // name, '' if untagged) -> app tab id. Lives ONLY here, in this chat tab's
  // own JS realm - not in the background, not on any server (see this
  // file's header comment on the extension's stateless design, which this
  // extends rather than breaks). A page reload wipes it along with
  // everything else, which is the desired "refresh releases the extension
  // from this mode" behavior. Read by the popup (for the "already added"
  // list, see message-handler.ts's relay-list-app-tabs) via the same
  // one-shot injectScriptOnce read __mcpRelayStats already uses.
  win.__mcpRelayAppTabs = { [config.initialAppTag]: config.initialAppTabId };

  // Lightweight, read-only stats a human can check from the popup (via a
  // one-shot injectScriptOnce read, see message-handler.ts's
  // relay-check-status handler) - the extension itself never reads or
  // polls this; it's purely for a human to answer "is this still alive,
  // and what's it doing" without opening this tab's own DevTools console.
  win.__mcpRelayStats = {
    startedAt: Date.now(),
    pollCount: 0,
    lastPollAt: undefined as number | undefined,
    roundsCompleted: 0,
    lastError: undefined as string | undefined,
    completionStartedAt: undefined as number | undefined,
    stableSinceMs: undefined as number | undefined,
  };

  function findSentinel(text: string, sentinel: string) {
    const re = new RegExp(sentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\[([^\\]\\n]*)\\])?');
    const m = text.match(re);
    if (!m) return undefined;
    return { index: m.index ?? 0, tag: m[1] || '', matchLength: m[0].length };
  }
  function stripFence(text: string) {
    const t = text.trim();
    const fenced = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
    return fenced?.[1] ?? t;
  }
  function extractSentinelBlock(text: string, startSentinel: string, endSentinel: string) {
    const body = stripFence(text);
    const found = findSentinel(body, startSentinel);
    if (!found) return undefined;
    const endIdx = body.indexOf(endSentinel, found.index);
    if (endIdx === -1) return undefined;
    return { tag: found.tag, body: body.slice(found.index + found.matchLength, endIdx).trim() };
  }

  // Small delay between setting the input value and clicking submit -
  // needed for 'contenteditable-text' specifically: a framework (e.g.
  // Angular, as Gemini uses) that reacts to execCommand via its own change
  // detection cycle can race a same-tick click, sometimes leaving the
  // submit button not-yet-enabled or the click firing before the
  // framework's internal state has caught up with the DOM - found live
  // testing against Gemini, where a same-tick type+click occasionally
  // silently failed to send at all. 'native-value-setter' has not shown
  // this issue, but the delay is applied uniformly since it's harmless in
  // that case too.
  async function sendMessage(messageText: string): Promise<void> {
    const inputEl = doc.querySelector(config.inputSelector);
    if (!inputEl) throw new Error(`input selector not found: ${config.inputSelector}`);
    if (config.setVia === 'native-value-setter') {
      // HTMLTextAreaElement.prototype.value is an ACCESSOR property - reading
      // it directly on the bare prototype (not an instance) throws "Illegal
      // invocation" rather than returning a value, so pick the prototype via
      // the element's own tagName instead of a truthiness check on it.
      const proto = inputEl.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (!setter) throw new Error('native-value-setter: could not find a native value setter for this element.');
      setter.call(inputEl, messageText);
      inputEl.dispatchEvent(new win.Event('input', { bubbles: true }));
    } else if (config.setVia === 'contenteditable-text') {
      // document.execCommand is deprecated but still the most reliable way
      // to insert text into a contenteditable element such that a rich-text
      // editor library (Quill, as Gemini uses) updates its own internal
      // model in sync with the DOM - directly setting .textContent/.innerHTML
      // bypasses the editor's own state and can desync it from what's
      // actually submitted.
      inputEl.focus();
      doc.execCommand('selectAll', false, null);
      doc.execCommand('insertText', false, messageText);
    } else {
      throw new Error('setVia "' + config.setVia + '" not yet implemented.');
    }
    await new Promise((resolve) => win.setTimeout(resolve, 150));
    const submitEl = doc.querySelector(config.submitSelector);
    if (!submitEl) throw new Error(`submit selector not found: ${config.submitSelector}`);
    submitEl.click();
  }

  function lastReplyText(): string | undefined {
    const nodes = doc.querySelectorAll(config.replyContainerSelector);
    const last = nodes[nodes.length - 1];
    return last ? (last.textContent ?? '') : undefined;
  }

  // Waits for a genuinely new reply, then the completion signal, resolving
  // with the new reply's text. "New" is judged by TEXT CONTENT, not by
  // counting reply.containerSelector matches (a prior count-based design
  // broke on chat UIs - DeepSeek included - that VIRTUALIZE their message
  // list: older message DOM nodes get removed/recycled as the conversation
  // grows, so the total match count can plateau or even drop even as new
  // replies keep arriving, permanently stalling any "wait for count > N"
  // check). Comparing the LAST matching node's text against a snapshot
  // taken before this wait began works regardless of how many nodes exist
  // or get reused - if the text differs (or a reply exists where none did
  // before), it's new.
  //
  // The "wait for new content to appear" phase is intentionally UNBOUNDED -
  // it can mean waiting for a human to type a manual response after a
  // no-CALL-block round, which has no reasonable time limit. maxWaitMs only
  // bounds the completion-detection phase once a reply has actually started
  // appearing/changing.
  //
  // Polling-based, not MutationObserver-based (see this file's header
  // comment on why the switch was made: React-style UIs can replace a DOM
  // node wholesale during a re-render, silently orphaning an observer
  // attached to the old node reference with no further events ever firing
  // - found live as a permanent hang mid-session). A poll always re-queries
  // the DOM fresh via querySelectorAll, so it can never go stale the way a
  // held node reference can.
  //
  // Only ticks while the tab is VISIBLE (document.visibilityState),
  // pausing while the human has switched to another tab (e.g. to check the
  // app tab's results) and resuming automatically the instant they switch
  // back - no state is lost across a pause, since each tick re-reads
  // whatever the DOM currently looks like rather than tracking missed
  // events.
  // Distinguishes a deliberate interrupt (see interruptCurrentWait below)
  // from a genuine failure in loop()'s catch block, so an "Add app tab"
  // interrupting an idle wait is never logged/surfaced as if it were an
  // error - it's the intended, successful path.
  class WaitInterrupted extends Error {}

  // Set while a waitForReply() is in-flight, cleared when it settles -
  // lets outbox-push interrupt an in-progress wait (see win.__mcpRelayAddAppTab
  // and loop() below). Without this, pushing a new app's primer onto outbox
  // while the loop is idle inside waitForReply (its normal state - waiting
  // for the human/LLM's next chat message, which can take an unbounded
  // amount of time) would queue the primer correctly but never actually
  // send it until a reply happened to arrive on its own for an unrelated
  // reason - found live: "Add app tab" reported success (the tag/primer
  // fetch both worked) but nothing appeared in the chat, because the loop
  // was sitting in an open-ended wait with nothing pushing it forward.
  let interruptCurrentWait: (() => void) | undefined;

  function waitForReply(previousLastReplyText: string | undefined): Promise<string> {
    return new Promise((resolveRaw, rejectRaw) => {
      // Clearing interruptCurrentWait on every settle path (not just the
      // interrupt path itself) means a wait that finishes normally never
      // leaves a stale interrupt handler around that a LATER, unrelated
      // outbox push could mistakenly fire against a wait that already ended.
      const resolve = (text: string) => {
        interruptCurrentWait = undefined;
        resolveRaw(text);
      };
      const reject = (err: Error) => {
        interruptCurrentWait = undefined;
        rejectRaw(err);
      };
      const POLL_MS = 1000;
      interruptCurrentWait = () => {
        stop();
        reject(new WaitInterrupted());
      };
      const completion = config.completion;
      // maxWaitMs bounds ONLY the completion-detection phase (how long a
      // reply is allowed to take to finish streaming, once it has started
      // appearing) - NOT the earlier phase of waiting for a reply to START
      // appearing at all, which can mean waiting for a human to answer a
      // clarifying question with no reasonable time limit. This split was
      // deliberately fixed once already (a single timer covering both
      // phases was found live to silently kill a session the instant a
      // human took over 2 minutes to reply) - completionStartedAt stays
      // undefined until phase 1 (the new-content gate below) is satisfied,
      // and the timeout check only activates once it's set.
      let completionStartedAt: number | undefined;
      let intervalId: ReturnType<typeof setInterval> | undefined;
      let stableSinceMs: number | undefined; // idle-mutation: when the current text last changed
      let lastSeenText: string | undefined;
      let seenWatchPresent = false; // button-reappears / disabled-toggle
      let firstTick = true; // button-reappears / disabled-toggle - see finish()'s first-tick check above

      function stop() {
        if (intervalId !== undefined) clearInterval(intervalId);
        doc.removeEventListener('visibilitychange', onVisibilityChange);
      }

      function finish() {
        stop();
        const text = lastReplyText();
        if (text === undefined) {
          reject(new Error('reply container not found after completion: ' + config.replyContainerSelector));
          return;
        }
        resolve(text);
      }

      function tick() {
        win.__mcpRelayStats.pollCount += 1;
        win.__mcpRelayStats.lastPollAt = Date.now();
        win.__mcpRelayStats.completionStartedAt = completionStartedAt;
        win.__mcpRelayStats.stableSinceMs = stableSinceMs;

        // Phase 1: wait for the last reply's text to genuinely differ from
        // what it was before this wait started - no time limit of its own.
        const currentText = lastReplyText();
        if (currentText === undefined || currentText === previousLastReplyText) return;

        if (completionStartedAt === undefined) completionStartedAt = Date.now();
        if (Date.now() - completionStartedAt > completion.maxWaitMs) {
          stop();
          reject(new Error('completion wait timed out after ' + completion.maxWaitMs + 'ms (strategy: ' + completion.strategy + ')'));
          return;
        }

        if (completion.strategy === 'idle-mutation') {
          const text = currentText;
          if (text !== lastSeenText) {
            lastSeenText = text;
            stableSinceMs = Date.now();
            return;
          }
          if (stableSinceMs !== undefined && Date.now() - stableSinceMs >= completion.idleMs) {
            finish();
          }
        } else if (completion.strategy === 'button-reappears') {
          // If the watched button is already absent on the VERY FIRST tick
          // of this wait (never observed present at all), the reply had
          // already finished generating before polling started - e.g. the
          // human already had a completed reply on screen when they clicked
          // Start bridging. Waiting for a present->absent transition in
          // that case would wait forever, since that transition already
          // happened before this wait began. Found live: a session's very
          // first wait hung indefinitely with a fully-formed CALL block
          // already visible on screen.
          const present = !!doc.querySelector(completion.watchSelector);
          if (firstTick && !present) {
            finish();
            return;
          }
          firstTick = false;
          if (present) seenWatchPresent = true;
          if (seenWatchPresent && !present) finish();
        } else if (completion.strategy === 'disabled-toggle') {
          // Same first-tick reasoning as button-reappears above.
          const el = doc.querySelector(completion.watchSelector);
          const disabled = !!el?.disabled;
          if (firstTick && !disabled) {
            finish();
            return;
          }
          firstTick = false;
          if (disabled) seenWatchPresent = true;
          if (seenWatchPresent && el && !el.disabled) finish();
        } else {
          stop();
          reject(new Error('unknown completion strategy: ' + (completion as { strategy: string }).strategy));
        }
      }

      function onVisibilityChange() {
        if (doc.visibilityState === 'visible' && intervalId === undefined) {
          intervalId = setInterval(tick, POLL_MS);
          tick(); // don't wait a full POLL_MS to react to becoming visible again
        } else if (doc.visibilityState !== 'visible' && intervalId !== undefined) {
          clearInterval(intervalId);
          intervalId = undefined;
        }
      }

      doc.addEventListener('visibilitychange', onVisibilityChange);
      if (doc.visibilityState === 'visible') {
        intervalId = setInterval(tick, POLL_MS);
      }
    });
  }

  // Relays a HUMAN-MCP CALL block to the app tab matching its sentinel tag
  // via the extension bus (an OPAQUE transport - the background never
  // inspects `code`, see relay-bus-isolated.ts / message-handler.ts's
  // relay-bus-forward) and returns that app tab's HUMAN-MCP RESULT text.
  // `tag` is '' for an untagged call, matching win.__mcpRelayAppTabs' own
  // '' key for a session with no name set.
  function forwardToAppTab(tag: string, callText: string): Promise<string> {
    const targetTabId = win.__mcpRelayAppTabs[tag];
    if (targetTabId === undefined) {
      return Promise.reject(
        new Error(
          tag
            ? `No app tab is bridged under session tag "${tag}" - available tags: ${Object.keys(win.__mcpRelayAppTabs).join(', ') || '(none)'}.`
            : 'No untagged app tab is bridged, and this call has no session tag.'
        )
      );
    }
    const requestId = 'req-' + Math.random().toString(36).slice(2) + '-' + Date.now();
    const code =
      "return (async () => { if (!window.__humanMcpRelay) { throw new Error('window.__humanMcpRelay not found on this tab - is human-mcp-relay loaded here?'); } return await window.__humanMcpRelay.runCall(" +
      JSON.stringify(callText) +
      '); })();';
    return new Promise((resolve, reject) => {
      function onResponse(event: Event) {
        const detail = (event as CustomEvent).detail as { requestId: string; result?: string; error?: string };
        if (detail.requestId !== requestId) return;
        win.removeEventListener('__mcp_relay_bus_response__', onResponse);
        if (detail.error !== undefined) {
          reject(new Error(detail.error));
        } else if (typeof detail.result === 'string') {
          resolve(detail.result);
        } else {
          reject(new Error('forwardToAppTab: no result or error in bus response.'));
        }
      }
      win.addEventListener('__mcp_relay_bus_response__', onResponse);
      win.dispatchEvent(
        new win.CustomEvent('__mcp_relay_bus_request__', {
          detail: { requestId, targetTabId, code },
        })
      );
    });
  }

  // FIFO queue of messages waiting to be sent into the chat. Normally holds
  // at most one entry (the previous round's HUMAN-MCP RESULT), but
  // win.__mcpRelayAddAppTab (below) can push a second app's primer onto it
  // independently of the loop's own request/result cycle - e.g. a human
  // clicks "Add app tab" while a call is still in flight to the first app.
  // Drained strictly in order, one per loop iteration, so an added app's
  // primer is never lost or overwritten by a concurrently-arriving result.
  const outbox: string[] = config.initialPrimer !== undefined ? [config.initialPrimer] : [];

  // Exposed for the background to invoke via a one-shot injectScriptOnce
  // call (see message-handler.ts's handleAddAppTab) - the extension's ONLY
  // way to reach into an already-running loop, matching how
  // relay-check-status already reads __mcpRelayStats the same way. Adding a
  // tag that's already in win.__mcpRelayAppTabs is rejected here too
  // (defense in depth - the popup already excludes/blocks this before
  // calling), since silently overwriting an existing tag's target tab would
  // leave in-flight calls for the old tab's session ambiguous.
  win.__mcpRelayAddAppTab = (tag: string, appTabId: number, primer?: string) => {
    if (Object.prototype.hasOwnProperty.call(win.__mcpRelayAppTabs, tag)) {
      throw new Error(`Session tag "${tag}" is already bridged to a different app tab.`);
    }
    win.__mcpRelayAppTabs[tag] = appTabId;
    if (primer) {
      outbox.push(primer);
      // If the loop is currently idle inside waitForReply (its normal
      // state most of the time - see interruptCurrentWait's own comment),
      // pushing to outbox alone would queue the primer but never actually
      // send it until a reply happened to arrive on its own for an
      // unrelated reason. Interrupting the wait sends loop() back to the
      // top of its for(;;), where the outbox check now finds this primer
      // and sends it immediately. A no-op if the loop is currently doing
      // something else (mid-send, mid-forwardToAppTab) - outbox will still
      // be drained on schedule once that finishes.
      interruptCurrentWait?.();
    }
  };

  async function loop() {
    let previousLastReplyText: string | undefined = undefined;

    for (;;) {
      try {
        if (outbox.length > 0) {
          const nextMessageForChat = outbox.shift()!;
          await sendMessage(nextMessageForChat);
          // Snapshot AFTER sending (not before loop start) - whatever the
          // last reply's text is right now is "already seen," so the next
          // wait correctly requires something newer than this specific
          // send, not just newer than session start.
          previousLastReplyText = lastReplyText();
        }

        const replyText = await waitForReply(previousLastReplyText);
        previousLastReplyText = replyText;

        const match = extractSentinelBlock(replyText, config.startSentinel, config.endSentinel);
        if (!match) {
          // No CALL block this round (a clarifying question, a plain
          // answer, etc.) - never auto-send anything; just keep watching
          // for the next reply. A human can answer the chat manually in
          // the meantime; whatever they (or the model) produce next is
          // picked up automatically by the next waitForReply call.
          continue;
        }

        const resultText = await forwardToAppTab(
          match.tag,
          config.startSentinel + (match.tag ? '[' + match.tag + ']' : '') + '\n' + match.body + '\n' + config.endSentinel
        );
        outbox.push(resultText);
        win.__mcpRelayStats.roundsCompleted += 1;
      } catch (e) {
        if (e instanceof WaitInterrupted) {
          // Deliberate, successful interruption (see interruptCurrentWait) -
          // not a failure, so skip the logging/stats-recording below and go
          // straight back to the top of the loop, where the outbox check
          // now finds and sends whatever triggered the interrupt.
          continue;
        }
        // No status reporting of any kind beyond __mcpRelayStats (fully
        // stateless extension, no popup polling) - log to the page's own
        // console so a human inspecting this tab's DevTools can see what
        // happened, then keep the loop alive rather than exiting: a
        // transient failure (e.g. a selector momentarily not found during a
        // re-render) shouldn't permanently kill a session the human would
        // otherwise have to notice and manually restart. The next
        // iteration's waitForReply will simply try again against whatever
        // the DOM looks like now.
        const message = e instanceof Error ? e.message : String(e);
        win.__mcpRelayStats.lastError = message;
        console.error('[human-mcp-relay chat-loop]', message);
      }
    }
  }

  void loop();
}
