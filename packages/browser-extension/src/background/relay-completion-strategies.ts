// Chat-tab DOM automation, injected into the target page via
// chrome.scripting.executeScript (world: 'MAIN') - same "real typed
// function + args, not a compiled code string" pattern as connect-tab.ts
// (string-compiled injection via `new Function` is reserved for
// script-injection.ts's inject_script/inject_persistent_script, which run
// arbitrary AGENT-supplied code; this is our own fixed code, parameterized
// by recipe data, so a typed function is both safer and simpler).
//
// func callbacks below run in the target page's context (which has
// `window`/`document`), not this file's own service-worker context - cast
// through `globalThis as any` since this file compiles under
// tsconfig.background.json (webworker lib, no DOM lib), same convention as
// connect-tab.ts's tabAlreadyConnected/renameConnection/etc.
import type { CompletionConfig, SetViaStrategy } from '../shared/recipe-types.js';
import { unwrapInjectionResult } from './script-injection.js';

export interface SendMessageArgs {
  inputSelector: string;
  setVia: SetViaStrategy;
  submitSelector: string;
  messageText: string;
}

// Sets the input value per setVia, then clicks submit. Does not wait for or
// read a reply - see waitForReplyInTab for that half, kept separate so
// sending the HUMAN-MCP RESULT back into the chat (relay-engine.ts's loop
// step 6) can reuse just this half without an unnecessary read.
export async function sendMessageInTab(tabId: number, args: SendMessageArgs): Promise<void> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (function (inputSelector: string, setVia: string, submitSelector: string, messageText: string) {
      const doc = (globalThis as any).document;
      const inputEl = doc.querySelector(inputSelector);
      if (!inputEl) throw new Error(`input selector not found: ${inputSelector}`);

      if (setVia === 'native-value-setter') {
        // `HTMLTextAreaElement.prototype.value` is an ACCESSOR property
        // (getter/setter pair) - reading it directly on the bare prototype
        // (not an instance) invokes the getter with the wrong `this` and
        // throws "Illegal invocation" rather than returning a value, so a
        // truthiness check on it is always false. Use the element's own
        // tagName to pick the right prototype instead.
        const proto = inputEl.tagName === 'TEXTAREA' ? (globalThis as any).HTMLTextAreaElement.prototype : (globalThis as any).HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (!setter) throw new Error('native-value-setter: could not find a native value setter for this element.');
        setter.call(inputEl, messageText);
        inputEl.dispatchEvent(new (globalThis as any).Event('input', { bubbles: true }));
      } else {
        throw new Error(`setVia "${setVia}" not yet implemented.`);
      }

      const submitEl = doc.querySelector(submitSelector);
      if (!submitEl) throw new Error(`submit selector not found: ${submitSelector}`);
      submitEl.click();
    }) as (inputSelector: string, setVia: string, submitSelector: string, messageText: string) => void,
    args: [args.inputSelector, args.setVia, args.submitSelector, args.messageText],
  });
  // sendMessageInTab has no return value to check, but the injected
  // function CAN still throw (bad selector, unimplemented setVia, etc.) -
  // that surfaces via InjectionResult's `error` field, not as a rejection
  // of this executeScript call itself, so it must be checked explicitly or
  // a failed send silently "succeeds" from the caller's point of view (this
  // exact gap was found live: relay-engine.ts's loop happily proceeded to
  // wait for a reply after a send that actually never happened).
  unwrapInjectionResult(results[0]);
}

export interface WaitAndReadArgs {
  replyContainerSelector: string;
  completion: CompletionConfig;
}

// Waits for the recipe's completion signal, then reads the last matching
// reply container's textContent. The whole wait happens INSIDE this single
// injected function (a MutationObserver wrapped in a Promise) rather than
// via repeated background-side polling - chrome.scripting.executeScript
// awaits a Promise returned by the injected function before resolving.
export async function waitForReplyInTab(tabId: number, args: WaitAndReadArgs): Promise<string> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (function (replyContainerSelector: string, completionJson: string) {
      const completion = JSON.parse(completionJson) as
        | { strategy: 'idle-mutation'; observe: string; idleMs: number; maxWaitMs: number }
        | { strategy: 'button-reappears'; watchSelector: string; maxWaitMs: number }
        | { strategy: 'disabled-toggle'; watchSelector: string; maxWaitMs: number };
      const doc = (globalThis as any).document;
      const MutationObserverCtor = (globalThis as any).MutationObserver;

      return new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`completion wait timed out after ${completion.maxWaitMs}ms (strategy: ${completion.strategy})`));
        }, completion.maxWaitMs);

        function finish() {
          clearTimeout(timeout);
          const nodes = doc.querySelectorAll(replyContainerSelector);
          const last = nodes[nodes.length - 1];
          if (!last) {
            reject(new Error(`reply container not found after completion: ${replyContainerSelector}`));
            return;
          }
          resolve(last.textContent ?? '');
        }

        if (completion.strategy === 'idle-mutation') {
          const target = doc.querySelector(completion.observe) ?? doc.body;
          let idleTimer: ReturnType<typeof setTimeout>;
          const obs = new MutationObserverCtor(() => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
              obs.disconnect();
              finish();
            }, completion.idleMs);
          });
          obs.observe(target, { childList: true, subtree: true, characterData: true });
          // Also start the idle timer immediately, in case the reply is
          // already fully rendered by the time this script runs (no further
          // mutations will ever fire to restart it otherwise).
          idleTimer = setTimeout(() => {
            obs.disconnect();
            finish();
          }, completion.idleMs);
        } else if (completion.strategy === 'button-reappears') {
          let seenPresent = false;
          const check = () => {
            const present = !!doc.querySelector(completion.watchSelector);
            if (present) seenPresent = true;
            if (seenPresent && !present) {
              obs.disconnect();
              finish();
            }
          };
          const obs = new MutationObserverCtor(check);
          obs.observe(doc.body, { childList: true, subtree: true });
          check();
        } else if (completion.strategy === 'disabled-toggle') {
          let seenDisabled = false;
          const check = () => {
            const el = doc.querySelector(completion.watchSelector) as { disabled?: boolean } | null;
            const disabled = !!el?.disabled;
            if (disabled) seenDisabled = true;
            if (seenDisabled && el && !el.disabled) {
              obs.disconnect();
              finish();
            }
          };
          const obs = new MutationObserverCtor(check);
          obs.observe(doc.body, { attributes: true, subtree: true, attributeFilter: ['disabled'] });
          check();
        } else {
          clearTimeout(timeout);
          reject(new Error(`unknown completion strategy: ${(completion as { strategy: string }).strategy}`));
        }
      });
    }) as (replyContainerSelector: string, completionJson: string) => Promise<string>,
    args: [args.replyContainerSelector, JSON.stringify(args.completion)],
  });
  // A rejected Promise (e.g. the completion wait's own timeout, or "reply
  // container not found") surfaces via InjectionResult's `error` field, not
  // as a thrown exception from chrome.scripting.executeScript itself - see
  // script-injection.ts's unwrapInjectionResult for why this must be
  // checked before trusting `result`.
  let result: unknown;
  try {
    result = unwrapInjectionResult(results[0]);
  } catch (e) {
    throw new Error(`waitForReplyInTab: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof result !== 'string') throw new Error('waitForReplyInTab: injected script returned no result.');
  return result;
}
