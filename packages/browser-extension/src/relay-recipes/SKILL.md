---
name: authoring-chat-relay-recipes
description: How to investigate a live chat UI and author a new chat-relay recipe (JSON, validated against recipe.schema.json) using this extension's own js-bridge-mcp tools - the actual workflow used to build deepseek.json, including the dead ends hit along the way
---

# Authoring a chat-relay recipe, live

This documents the **process** used to author `deepseek.json` against the
real chat.deepseek.com page - not just the resulting fields (that's
`../../docs/recipe-authoring.md`, the field-by-field narrative guide, and
`recipe.schema.json`, the formal schema). Read this when you need to author
a recipe for a *new* chat site and want to reuse the same investigative
approach, including the specific mistakes that cost time the first time.

## Prerequisite: get a live probe into the target page

The recipe author needs `inject_script`-style DOM access to the chat tab
while iterating - guessing selectors from memory or a screenshot is not
reliable enough (see the dead end below). This extension already exposes
exactly that via its own `js-bridge-mcp` "extension" channel:

1. Have the human open the target chat site in a tab, logged in.
2. From an MCP client already connected to this extension's `js-bridge-mcp`
   server: `join_channel("extension")` - this is the extension's own
   privileged channel (distinct from the "default" channel a bridged page
   connects to), exposing `inject_script`, `find_tab_by_connection`,
   `get_console_log`, `get_network_log`.
3. `find_tab_by_connection()` with no query lists every tab the extension
   currently knows about - use this to get the target chat tab's `tabId`
   (or omit `tabId` on `inject_script` to just target whatever tab is
   currently active/focused, simplest when there's only one candidate tab).
4. From here on, `inject_script({tabId, code})` runs arbitrary JS in that
   tab's MAIN world - identical DOM access to pasting into that tab's own
   DevTools console.

## Investigative workflow (what actually worked for DeepSeek)

1. **Find the input.** `document.querySelectorAll('textarea')` /
   `[contenteditable="true"]` and inspect `placeholder`/`class`/`id` on each
   match. DeepSeek: one `<textarea placeholder="Message DeepSeek">`, no
   contenteditable input.

2. **Determine how the input needs to be set.** Try the natural thing first
   and see if it visibly fails:
   ```js
   const ta = document.querySelector('textarea[placeholder="Message DeepSeek"]');
   ta.value = 'test'; // if the framework silently reverts this or the send
                       // button doesn't enable, the input is framework-
                       // controlled (React, here) and needs the native
                       // setter trick:
   const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
   setter.call(ta, 'test message');
   ta.dispatchEvent(new Event('input', {bubbles: true}));
   ```
   Confirmed working by reading `ta.value` back and observing the send
   button's disabled state change.

3. **Find the submit control and its actual scoping.** Walked up from the
   input (`ta.closest('form') || ta.parentElement.parentElement...`) to
   find a plausible button, then queried within that scope for
   `div[role="button"], button` and inspected each one's `className`.
   **DEAD END, found later**: this exploratory `.closest('form') || ...`
   fallback chain silently fell through to the `parentElement` branch (the
   page has NO `<form>` element at all), but the resulting recipe was
   authored with the selector `"form .ds-button--circle"` anyway - which
   matches nothing when queried for real, since there's no `<form>` to
   scope inside. This only surfaced during LIVE END-TO-END TESTING (the
   extension's actual automated run), not during the manual exploration
   session, because manual testing via `inject_script` was ALSO written
   using the same `.closest('form') || ...`-derived scope by habit, so it
   masked the same bug. **Lesson: always test the FINAL selector string
   exactly as it will appear in the recipe JSON, via a bare
   `document.querySelector(theExactSelectorString)`, not via whatever DOM
   traversal happened to find the element during exploration** - see
   `../../docs/recipe-authoring.md`'s "Assuming a `<form>` ancestor exists"
   pitfall, added after this was found.

4. **Send one real test message, then inspect what appeared.** Don't guess
   the reply container from an empty chat - `document.querySelectorAll`
   over broad candidates (`[class*="message"]`, etc.) returns nothing until
   there's an actual conversation. After sending "Say the single word:
   PONG", walked the new DOM: found `.ds-message` (one per turn, including
   a separate reasoning/"Thought for N seconds..." block for a reasoning
   reply) and, nested inside the assistant's turn,
   `.ds-assistant-message-main-content` holding ONLY the clean final-answer
   text - confirmed by testing a prompt expected to show visible
   chain-of-thought and checking the selector's matched text excluded it.

5. **Verify the completion signal before picking a strategy.** Checked
   `disabled-toggle` first since it's the most reliable strategy when
   available: sent a message, then immediately read the send button's
   `.disabled` DOM property and its class list. Found DeepSeek toggles a
   `ds-button--disabled` CSS class, NOT the `disabled` property itself -
   `disabled-toggle` (which watches the property) would never fire. Fell
   back to `idle-mutation`.

   **DEAD END, found later (a second one, more serious than the `form`
   one)**: the first cut of this recipe set `completion.observe` explicitly
   to `.ds-assistant-message-main-content:last-of-type`, reasoning "watch
   the last reply container for mutations." This is a CSS misunderstanding
   - `:last-of-type` means "the last element of this type among ITS OWN
   SIBLINGS," not "the last matching element on the whole page." Since each
   DeepSeek reply lives in its own distinct `.ds-message` wrapper (not as
   siblings of each other), EVERY reply div independently satisfies
   `:last-of-type` (each is the last - and only - child of its type within
   its own parent), so the selector matched MULTIPLE elements, and
   `document.querySelector` (singular) silently returned the FIRST one -
   the oldest reply, which will never mutate again. This did not cause an
   obvious crash: the idle-timer's unconditional fallback (set regardless
   of whether the observed node ever mutates) still fired eventually, so
   short test messages appeared to work. It surfaced as a SILENT, hard-to-
   diagnose hang only during a real multi-round session: a genuinely new
   reply appeared on screen, clearly visible with a full `HUMAN-MCP CALL`
   block, while the session stayed stuck at `waiting-for-reply` indefinitely
   - because the wait's actual gate (a separate `minReplyCount` check
   introduced in a later fix) was satisfied correctly, but the diagnostic
   assumption "surely `observe` is watching the right node" was wrong, and
   took real live debugging (comparing an isolated hand-run of the exact
   same logic against the actual compiled background bundle) to find.
   **Fix**: `observe` is now OPTIONAL and, when omitted, the engine
   resolves the watch target dynamically as "whichever element
   `reply.containerSelector`'s last match currently is" - re-derived fresh
   each time, never a fixed selector string. The final `deepseek.json`
   omits `observe` entirely. **Lesson: don't hand-write a `:last-of-type` (or
   similar "last X" CSS pseudo-class) selector assuming it means globally
   last - verify with `document.querySelectorAll(selector).length` live
   before trusting it matches exactly one element.**

6. **Tune `idleMs` against REAL reasoning-model behavior, not a guess.**
   First cut used `idleMs: 1500` - passed initial manual testing (a short
   "PONG" reply has no internal pauses), but FAILED during actual automated
   multi-round bridging: DeepSeek's natural "thinking" pauses between
   sentences (finishing one thought, pausing, continuing toward the actual
   tool call) exceeded 1.5s of no-DOM-mutation, causing the wait to resolve
   on a truncated mid-stream reply with no CALL block yet - which then
   surfaced as a "no CALL block found" error even though DeepSeek WOULD
   have produced one if given more time. Fixed by raising to `idleMs: 3000`
   after observing this live. **Lesson: a short idle threshold that works
   for a single trivial test message can still be wrong for a real
   multi-sentence reasoning reply - validate idleMs against an actual
   multi-round bridging session, not just one manual send.**

## DEAD END #3, found much later (engine-level, not recipe-level): message-list virtualization

This one isn't fixable by editing the recipe - it required a change to the
engine itself (`relay-chat-loop.ts`), documented here because it explains a
class of bug any future recipe author needs to know about.

The original engine tracked "has a new reply arrived" by COUNTING
`reply.containerSelector` matches (`document.querySelectorAll(...).length`)
and waiting for that count to exceed whatever it was before the last
message was sent. This worked fine in every short manual test. It broke
permanently, silently, after 2-3 real automated rounds: DeepSeek's message
list is virtualized - as the conversation grows, OLDER message DOM nodes
get removed or recycled rather than staying in the DOM forever. So the
total count of matching elements can plateau (or even drop) even while
genuinely new replies keep arriving. Once the count stopped increasing, the
"wait for count > N" check could never be satisfied again - the loop sat
there polling forever with a CALL block clearly visible on screen and
correct data everywhere else (`pollCount` climbing, no errors), because the
one signal it was actually gating on had gone permanently stale. Diagnosing
this took adding temporary instrumentation (a running log array of every
count-tracking-variable change, timestamped) directly into
`window.__mcpRelayStats` and reading it back live via `inject_script` -
guessing from code review alone wasn't enough to find it, since the logic
was internally consistent; the DOM's actual behavior was the surprise.

**Fix**: track "has a new reply arrived" by comparing the last matching
node's TEXT CONTENT against a snapshot taken before the wait started,
never by counting nodes. A snapshot-vs-current text comparison is immune to
virtualization, since it only cares what the DOM currently says the last
reply is, regardless of how many nodes exist or have been recycled.

**Lesson for authoring or debugging ANY recipe**: don't assume a chat UI's
message list keeps every past message in the DOM forever. If a session
that worked for the first few rounds mysteriously stops advancing with no
errors, suspect the completion/new-reply-detection signal has gone stale
due to virtualization (or similar DOM node reuse) before suspecting the
recipe's own selectors.

## What ended up in `deepseek.json`

See the file itself - the final selectors/strategy/idleMs are the product
of the process above, not a first guess. If DeepSeek's UI changes and this
recipe breaks, repeat this same workflow against the new DOM rather than
patching the JSON blind.

## General lessons for the NEXT recipe (any new chat site)

- Always get a live probe (`inject_script` via the extension channel) into
  the real page before writing any selector - never guess from memory,
  a screenshot, or "how it's usually done" on similar sites.
- Test the exact final selector STRING via a bare `querySelector` call,
  not via whatever incidental DOM-walk found the element during
  exploration - a fallback chain used only for finding something during
  investigation can silently diverge from what actually gets written into
  the recipe.
- Send at least one real message and inspect the resulting DOM before
  picking the reply-container selector - don't infer it from an empty chat.
- Explicitly rule out `button-reappears` and `disabled-toggle` before
  defaulting to `idle-mutation` - check whether the site's "stop
  generating" affordance is a real DOM element appearing/disappearing, or a
  real `disabled` property toggle, before assuming neither exists.
- Tune `idleMs` (or any completion-strategy parameter) against a REAL
  multi-round automated session, not a single short manual test - failure
  modes specific to sustained/complex replies (long thinking pauses,
  multi-paragraph answers) often don't show up in a quick manual check.
