# Authoring a chat-relay recipe

This guide is written for an LLM agent authoring a new recipe by exploring a
live chat site's DOM (e.g. via this extension's own `inject_script`/
`find_tab_by_connection` MCP tools). If you're that agent: read this whole
file before writing any JSON, then follow the workflow below against the
actual target page rather than guessing selectors from memory.

A recipe is plain JSON, validated against
[`../src/relay-recipes/recipe.schema.json`](../src/relay-recipes/recipe.schema.json)
(the authoritative field-by-field reference — this file is the narrative
version). It describes how to drive one chat UI well enough to relay
`HUMAN-MCP CALL`/`HUMAN-MCP RESULT` blocks through it automatically, without
any code running on the extension's behalf — only a fixed, safe vocabulary of
selectors and enum-valued strategies. See
[`../src/relay-recipes/SKILL.md`](../src/relay-recipes/SKILL.md) for the
actual step-by-step live investigative session that produced
`deepseek.json`, including the mistakes made along the way — read it
alongside this file before authoring a recipe for a new site.

## Workflow: explore before you write JSON

1. **Find the input element.** Look for a `<textarea>` or `contenteditable`
   element the human types into. Prefer a selector anchored on a stable
   attribute — `placeholder`, `aria-label`, `name`, `id` — over a class name
   that looks like a CSS-module hash (e.g. `_27c9245`, `d96f2d2a`): those
   regenerate on every deploy and will silently break the recipe later.

2. **Confirm how the input needs to be set.** Try setting `.value` directly
   in the console (`el.value = 'test'`) and see if it visibly takes — if the
   framework immediately reverts it or the send button doesn't enable, the
   input is framework-controlled (React is the common case) and needs
   `setVia: "native-value-setter"`: set the value via the native property
   setter, then dispatch a bubbling `input` event:
   ```js
   const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
   setter.call(el, 'test message');
   el.dispatchEvent(new Event('input', {bubbles: true}));
   ```
   If the input is a `contenteditable` div instead of a `<textarea>`, note
   that `setVia: "contenteditable-text"` is declared in the schema but **not
   yet implemented** — a recipe requesting it will fail loudly at runtime.
   Flag this to the human rather than shipping an unusable recipe.

3. **Find the submit control.** Usually near the input. Confirm it becomes
   clickable (not disabled) once the input has text, and that `el.click()`
   actually submits — some send buttons are `<div role="button">`, not
   `<button>`, and respond fine to `.click()` even though they don't look
   like a real button in the DOM.

4. **Send one real test message and watch what appears.** This is the only
   reliable way to find the reply-container selector — don't guess from an
   empty chat. After sending, inspect the new DOM nodes that appeared for the
   assistant's response.

5. **Identify the reply container carefully — watch for a "thinking" trace.**
   Many chat UIs (reasoning models especially) render a separate scratchpad/
   reasoning block alongside the actual final answer, often as a sibling
   element with different styling. `reply.containerSelector` must match
   **only** the final-answer text. If your selector's matched text includes
   phrases like "Thought for N seconds" or visible chain-of-thought content,
   you have the wrong element — narrow the selector (e.g. a more specific
   class on the actual answer div, not the whole message bubble). Trigger a
   reply you expect to show visible reasoning and check the selector's
   matched text excludes it before finalizing the recipe.

6. **Choose a completion strategy based on what's actually observable** —
   don't default to `idle-mutation` out of convenience if something more
   reliable exists:
   - **`button-reappears`** — if there's a visible "stop generating" or
     regenerate button that appears while streaming and disappears when
     done, use this. It's the most reliable signal because it's the same
     signal the site's own UI relies on internally.
   - **`disabled-toggle`** — if no stop button exists but the submit button
     itself is disabled during generation and re-enabled when done, use
     this instead.
   - **`idle-mutation`** — last resort, when neither of the above is
     observable, only a visibly-streaming text node. Leave `observe` unset
     (the recommended default) — the engine automatically watches whichever
     element `reply.containerSelector`'s LAST match currently is, resolved
     dynamically each time. Do NOT hand-write a selector like
     `.my-reply:last-of-type` expecting it to mean "the last reply on the
     page": CSS's `:last-of-type` actually means "the last element of this
     type among its own siblings," so if each reply lives in a separate
     parent wrapper (common in chat UIs — one wrapper div per turn), that
     selector matches multiple STALE elements, and
     `document.querySelector` silently returns the first (wrong, no-longer-
     changing) one — found live authoring the DeepSeek recipe, where it
     caused sessions to hang in `waiting-for-reply` forever even with a
     CALL block clearly visible on screen. Resolves once `idleMs` passes
     with no further mutations. Pick `idleMs` generously —
     found in practice against DeepSeek, 1500ms was too short: a reasoning
     model's natural "thinking" pauses between sentences (finishing one
     thought, then pausing before continuing toward the actual tool call)
     can easily exceed 1.5s with no DOM mutation, causing the wait to
     resolve on a truncated mid-stream reply with no CALL block yet.
     3000ms+ is a safer starting point for any model that visibly "thinks"
     before answering; tune upward further if truncated replies still occur.
   - Always set a `maxWaitMs` you're comfortable timing out at (max 10
     minutes) as a hard backstop regardless of strategy. This only bounds
     how long a reply is allowed to take to finish STREAMING once it has
     started — it does NOT bound how long the extension waits for a reply
     to start appearing in the first place. That earlier wait (e.g. for a
     human to answer a clarifying question after a `watching` round) is
     intentionally unbounded and costs no CPU while idle, since it's driven
     by a `MutationObserver`, not polling.

7. **Validate before uploading.** Check the recipe against
   `recipe.schema.json`'s constraints — every selector must be non-empty and
   syntactically valid CSS, every enum field must be one of its declared
   values, `id` must be unique against recipes already uploaded. The
   extension's own uploader re-validates and will reject anything that
   doesn't conform, reporting every violation at once (not just the first).

## Worked example (chat.deepseek.com)

Verified against the live site: setting `.value` directly did nothing until
switched to the native-setter approach; the send button is a
`<div role="button">` with class `ds-button--circle`, disabled (via a
`ds-button--disabled` class, not the `disabled` DOM property — note this
recipe therefore cannot use `disabled-toggle`, since that strategy watches
the `disabled` property specifically) while the input is empty; the final
answer lives in `.ds-assistant-message-main-content`, distinct from a sibling
`.ds-message` that holds the "Thought for N seconds..." reasoning trace.
**Correction found during automated smoke-testing**: the page has no
`<form>` element at all — an earlier manual exploration pass had scoped the
submit selector as `form .ds-button--circle` (copying a `.closest('form') ||
...` fallback pattern used during exploration), which silently matches
nothing when actually queried as a plain CSS selector. Use the bare
`.ds-button--circle` (only one such button exists on the page).

```json
{
  "schemaVersion": 1,
  "id": "deepseek",
  "hostname": "chat.deepseek.com",
  "displayName": "DeepSeek",
  "input": {
    "selector": "textarea[placeholder=\"Message DeepSeek\"]",
    "setVia": "native-value-setter"
  },
  "submit": {
    "selector": ".ds-button--circle"
  },
  "reply": {
    "containerSelector": ".ds-assistant-message-main-content",
    "pick": "last"
  },
  "completion": {
    "strategy": "idle-mutation",
    "idleMs": 3000,
    "maxWaitMs": 120000
  },
  "callBlock": {
    "startSentinel": "HUMAN-MCP CALL",
    "endSentinel": "HUMAN-MCP END"
  }
}
```

(This recipe uses `idle-mutation` rather than `disabled-toggle` specifically
*because* DeepSeek's disabled state is a CSS class, not the `disabled`
property — a good example of why step 6 says to check what's actually
observable rather than assuming the "better" strategy always applies.)

## Common pitfalls

- **Hashed CSS-module class names** (e.g. `_27c9245`, `aaff8b8f`) are
  common in modern bundled frontends and regenerate on redeploy — avoid
  anchoring selectors on them when any more stable attribute is available.
  When unavoidable (no stable attribute exists at all), prefer a class name
  that reads as semantic (`ds-button--circle`) over a pure hash, and expect
  to need to re-author the recipe after a site update.
- **`disabled` the CSS class vs. `disabled` the DOM property** are different
  things — `disabled-toggle` only works for the latter. Check
  `el.disabled` in the console, not just whether a `disabled`-looking class
  is present.
- **Reading the reasoning/thinking trace by mistake** — see step 5. This is
  the single most consequential mistake, since it means the relay will try
  to extract `HUMAN-MCP CALL` sentinels from scratchpad text that was never
  meant to contain them.
- **`el.value = text` silently no-oping** on a framework-controlled input —
  see step 2. If the send button never enables after setting `.value`
  directly, this is almost certainly why.
- **Assuming a `<form>` ancestor exists.** Many modern SPA chat UIs don't use
  a real `<form>` element at all — a selector like `"form .my-button"`
  silently matches nothing if there's no `<form>` on the page, and this
  won't surface as an error, just a "submit selector not found" failure at
  runtime. Test every selector with a plain `document.querySelector(...)`
  call against the real page before writing it into the recipe, rather than
  inferring structure from how you happened to walk the DOM tree while
  exploring (e.g. via `.closest('form') || .parentElement...` fallback
  chains, which can mask that no `<form>` was actually found).
