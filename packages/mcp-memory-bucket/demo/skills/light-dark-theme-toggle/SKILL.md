---
name: light-dark-theme-toggle
description: >-
  Adds a 3-way (system/light/dark) theme toggle to a web app using the CSS
  light-dark() function plus a tiny JS/Lit controller that persists choice to
  localStorage and flips a data-theme attribute. Use when the user asks for dark
  mode, a theme switcher, or light/dark theme support in a web frontend.
tags:
  - theme
  - dark-mode
  - css
  - lit
trigger_phrases:
  - add dark mode
  - theme toggle
  - light dark theme support
metadata:
  owner: null
  status: stable
  extends: null
  group: anatoli
created_at: '2026-08-20T16:42:58.220Z'
body: >-
  ## The pattern


  Two layers: CSS tokens that resolve automatically via `light-dark()`, and a

  JS layer that overrides the automatic choice when the user picks explicitly.


  ### 1. CSS: define tokens once with `light-dark()`


  In the page's root stylesheet (not a component's shadow DOM — this must be

  global so every component can read the same custom properties):


  ```css

  :root {
    color-scheme: light dark;
    --bg: light-dark(#ffffff, #1a1a1a);
    --fg: light-dark(#111111, #f0f0f0);
    --border: light-dark(#0000001f, #ffffff2e);
    --accent: light-dark(#2563eb, #3b82f6);
    /* ...one light-dark() pair per token the app needs */
  }

  /* Explicit override wins over the OS/browser preference */

  :root[data-theme='light'] { color-scheme: light; }

  :root[data-theme='dark']  { color-scheme: dark; }


  body { background: var(--bg); color: var(--fg); }

  ```


  `color-scheme: light dark` on `:root` tells the browser both schemes are

  supported, so `light-dark(a, b)` picks `a` or `b` based on the OS/browser

  preference by default. Setting `color-scheme: light` or `dark` on

  `:root[data-theme=...]` pins one side, overriding the OS preference for that

  whole subtree — no separate `@media (prefers-color-scheme: dark)` block

  needed for tokens defined this way.


  Components then just use `var(--bg)`, `var(--fg)`, etc. — they never need to

  know about themes at all.


  ### 2. JS: a 3-way toggle that persists and applies the override


  ```ts

  type ThemeMode = 'system' | 'light' | 'dark';

  const THEME_STORAGE_KEY = 'app-theme';

  const THEME_CYCLE: ThemeMode[] = ['system', 'light', 'dark'];

  const THEME_ICON: Record<ThemeMode, string> = { system: '◐', light: '☀', dark:
  '☾' };

  const THEME_LABEL: Record<ThemeMode, string> = { system: 'Auto', light:
  'Light', dark: 'Dark' };


  function loadTheme(): ThemeMode {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : 'system';
  }


  function applyTheme(mode: ThemeMode) {
    if (mode === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
  }

  ```


  Apply the stored theme once, as early as possible (e.g. in the root

  component's constructor, before first render) to avoid a flash of the wrong

  theme:


  ```ts

  constructor() {
    super();
    applyTheme(loadTheme());
  }

  ```


  A toggle button cycles through the three states and persists on each change:


  ```ts

  #theme = new Signal<ThemeMode>(loadTheme()); // or useState/whatever the app's
  reactivity is


  #setTheme(mode: ThemeMode) {
    this.#theme.set(mode);
    localStorage.setItem(THEME_STORAGE_KEY, mode);
    applyTheme(mode);
  }


  #cycleTheme() {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(this.#theme.value) + 1) % THEME_CYCLE.length]!;
    this.#setTheme(next);
  }

  ```


  Render it as a small icon-only button showing the current mode's icon, with

  the label in the `title`/`aria-label` so it stays a single click target:


  ```ts

  html`
    <button
      class="theme-toggle"
      title=${`Theme: ${THEME_LABEL[mode]} (click to change)`}
      aria-label="Toggle color theme"
      @click=${() => this.#cycleTheme()}
    >
      ${THEME_ICON[mode]}
    </button>
  `

  ```


  ## Why this shape


  - **`light-dark()` over duplicated `@media` blocks** — one token definition
    per variable instead of a base block plus a `prefers-color-scheme: dark`
    block that has to be kept in sync. Every component that only ever consumes
    `var(--token-name)` needs zero theme-awareness of its own.
  - **Three states, not two** — "system" must be a real option (and the
    default), not just an implied absence. Users who want to follow their OS
    setting shouldn't have to manually match it.
  - **`data-theme` attribute, not a class** — lets the CSS override rule
    (`:root[data-theme='dark']`) sit right next to the base token block for
    easy scanning, and composes cleanly with `color-scheme` (which is what
    actually flips native form control/scrollbar rendering, not just the CSS
    variables).
  - **Persist to `localStorage`, apply before first paint** — re-fetching the
    saved preference and calling `applyTheme` in the constructor (before
    `render()`) avoids a flash of the wrong theme on reload.

  ## Caveats


  `light-dark()` requires the browser to have `color-scheme` set (Chrome 123+,

  Safari 17.5+, Firefox 120+). For older-browser support, fall back to

  per-token `@media (prefers-color-scheme: dark)` overrides instead — but

  default to `light-dark()` unless the project has a stated need for that

  range.
status: stable
owner: null
extends: null
group: anatoli
---
## The pattern

Two layers: CSS tokens that resolve automatically via `light-dark()`, and a
JS layer that overrides the automatic choice when the user picks explicitly.

### 1. CSS: define tokens once with `light-dark()`

In the page's root stylesheet (not a component's shadow DOM — this must be
global so every component can read the same custom properties):

```css
:root {
  color-scheme: light dark;
  --bg: light-dark(#ffffff, #1a1a1a);
  --fg: light-dark(#111111, #f0f0f0);
  --border: light-dark(#0000001f, #ffffff2e);
  --accent: light-dark(#2563eb, #3b82f6);
  /* ...one light-dark() pair per token the app needs */
}
/* Explicit override wins over the OS/browser preference */
:root[data-theme='light'] { color-scheme: light; }
:root[data-theme='dark']  { color-scheme: dark; }

body { background: var(--bg); color: var(--fg); }
```

`color-scheme: light dark` on `:root` tells the browser both schemes are
supported, so `light-dark(a, b)` picks `a` or `b` based on the OS/browser
preference by default. Setting `color-scheme: light` or `dark` on
`:root[data-theme=...]` pins one side, overriding the OS preference for that
whole subtree — no separate `@media (prefers-color-scheme: dark)` block
needed for tokens defined this way.

Components then just use `var(--bg)`, `var(--fg)`, etc. — they never need to
know about themes at all.

### 2. JS: a 3-way toggle that persists and applies the override

```ts
type ThemeMode = 'system' | 'light' | 'dark';
const THEME_STORAGE_KEY = 'app-theme';
const THEME_CYCLE: ThemeMode[] = ['system', 'light', 'dark'];
const THEME_ICON: Record<ThemeMode, string> = { system: '◐', light: '☀', dark: '☾' };
const THEME_LABEL: Record<ThemeMode, string> = { system: 'Auto', light: 'Light', dark: 'Dark' };

function loadTheme(): ThemeMode {
  const raw = localStorage.getItem(THEME_STORAGE_KEY);
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

function applyTheme(mode: ThemeMode) {
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
}
```

Apply the stored theme once, as early as possible (e.g. in the root
component's constructor, before first render) to avoid a flash of the wrong
theme:

```ts
constructor() {
  super();
  applyTheme(loadTheme());
}
```

A toggle button cycles through the three states and persists on each change:

```ts
#theme = new Signal<ThemeMode>(loadTheme()); // or useState/whatever the app's reactivity is

#setTheme(mode: ThemeMode) {
  this.#theme.set(mode);
  localStorage.setItem(THEME_STORAGE_KEY, mode);
  applyTheme(mode);
}

#cycleTheme() {
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(this.#theme.value) + 1) % THEME_CYCLE.length]!;
  this.#setTheme(next);
}
```

Render it as a small icon-only button showing the current mode's icon, with
the label in the `title`/`aria-label` so it stays a single click target:

```ts
html`
  <button
    class="theme-toggle"
    title=${`Theme: ${THEME_LABEL[mode]} (click to change)`}
    aria-label="Toggle color theme"
    @click=${() => this.#cycleTheme()}
  >
    ${THEME_ICON[mode]}
  </button>
`
```

## Why this shape

- **`light-dark()` over duplicated `@media` blocks** — one token definition
  per variable instead of a base block plus a `prefers-color-scheme: dark`
  block that has to be kept in sync. Every component that only ever consumes
  `var(--token-name)` needs zero theme-awareness of its own.
- **Three states, not two** — "system" must be a real option (and the
  default), not just an implied absence. Users who want to follow their OS
  setting shouldn't have to manually match it.
- **`data-theme` attribute, not a class** — lets the CSS override rule
  (`:root[data-theme='dark']`) sit right next to the base token block for
  easy scanning, and composes cleanly with `color-scheme` (which is what
  actually flips native form control/scrollbar rendering, not just the CSS
  variables).
- **Persist to `localStorage`, apply before first paint** — re-fetching the
  saved preference and calling `applyTheme` in the constructor (before
  `render()`) avoids a flash of the wrong theme on reload.

## Caveats

`light-dark()` requires the browser to have `color-scheme` set (Chrome 123+,
Safari 17.5+, Firefox 120+). For older-browser support, fall back to
per-token `@media (prefers-color-scheme: dark)` overrides instead — but
default to `light-dark()` unless the project has a stated need for that
range.
