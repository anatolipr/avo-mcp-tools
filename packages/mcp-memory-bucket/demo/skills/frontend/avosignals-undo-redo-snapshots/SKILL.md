---
name: avosignals-undo-redo-snapshots
description: >-
  Implements undo/redo for a Lit + avosignals app by snapshotting the whole
  piece of state (structuredClone) onto an undo stack before each mutation,
  rather than tracking per-field diffs or command objects. Use whenever adding
  undo/redo to a Lit component whose state already lives in one or a few
  avosignals Signals holding plain, serializable data (arrays/objects of
  primitives) — not for state containing DOM nodes, functions, or other
  non-cloneable values.
tags:
  - lit
  - avosignals
  - undo-redo
  - state-management
  - frontend
trigger_phrases:
  - undo redo
  - undo stack
  - redo stack
  - ctrl z shift ctrl z
metadata:
  owner: personal
  status: stable
  extends: lit-avosignals-reactivity
  group: anatoli
created_at: '2026-08-20T15:40:29.428Z'
body: |-
  ## When to use

  A Lit component (per [[lit-avosignals-reactivity]]) holds its document state
  in a `Signal` — e.g. a list of shapes, form fields, or any structured, plain
  JSON-serializable value — and needs undo/redo. This pattern snapshots the
  *entire* signal value before each mutation rather than diffing or building
  command objects, which is simple and reliable at small-to-moderate state
  sizes (a few hundred shapes/items) and trivial to reason about, at the cost
  of higher memory use than a diff-based approach for very large state.

  ## Pattern

  1. Keep two plain arrays (not signals — the undo/redo stacks themselves don't
     need to be reactive, only the current state does) alongside the data
     signal:

     ```ts
     pages = new Signal<Page[]>([...]);

     #undoStack: Page[][] = [];
     #redoStack: Page[][] = [];
     ```

  2. Before every mutation that should be undoable, push a deep clone of the
     *current* value onto the undo stack and clear the redo stack (a new
     mutation invalidates any previously-undone redo path):

     ```ts
     #snapshot(): void {
       this.#undoStack.push(structuredClone(this.pages.value));
       this.#redoStack = [];
     }

     addShape(shape: Shape): void {
       this.#snapshot();
       this.pages.update((pages) => /* ...apply the change... */);
     }
     ```

     Call `#snapshot()` at the start of every state-mutating method that should
     be a single undo step — one snapshot per user-visible action (e.g. one
     per completed shape draw), not per intermediate value during a drag.

  3. `undo()` pops the last snapshot, but first pushes the *current* value onto
     the redo stack so redo can restore it:

     ```ts
     undo(): void {
       const prev = this.#undoStack.pop();
       if (!prev) return;
       this.#redoStack.push(structuredClone(this.pages.value));
       this.pages.set(prev);
     }

     redo(): void {
       const next = this.#redoStack.pop();
       if (!next) return;
       this.#undoStack.push(structuredClone(this.pages.value));
       this.pages.set(next);
     }
     ```

  4. Wire standard keyboard shortcuts in the component (Cmd/Ctrl+Z for undo,
     Shift+Cmd/Ctrl+Z for redo):

     ```ts
     #onKeydown = (e: KeyboardEvent) => {
       const mod = e.metaKey || e.ctrlKey;
       if (!mod) return;
       if (e.key.toLowerCase() === 'z' && e.shiftKey) { e.preventDefault(); this.store.redo(); }
       else if (e.key.toLowerCase() === 'z') { e.preventDefault(); this.store.undo(); }
     };
     ```

     Because `pages` is a `Signal` read during `render()`, `SignalWatcher`
     re-renders the component automatically after `.set()` — no manual
     `requestUpdate()` needed for the state change itself (though if `undo()`/
     `redo()` also need to trigger a side effect outside Lit's render, e.g.
     redrawing an imperative `<canvas>`, call that explicitly after `.set()`).

  5. Optional: a "reset" action (e.g. after exporting/handing off the document)
     should also clear both stacks, not just reset the data signal — otherwise
     undo could resurrect pre-reset state that's no longer meaningful:

     ```ts
     resetAfterExport(): void {
       this.pages.set([makeInitialPage()]);
       this.#undoStack = [];
       this.#redoStack = [];
     }
     ```

  ## Why

  `structuredClone` snapshotting is the simplest correct approach when state is
  already plain serializable data — no need for a command pattern (undo
  functions paired with redo functions) or per-field diffing, both of which add
  real complexity for marginal benefit at small state sizes. The trade-off is
  memory: each undo step holds a full deep copy, so this pattern is a poor fit
  for state containing large binary payloads (put those in a separate
  non-snapshotted signal, e.g. keep an image `dataUrl` outside the undo-tracked
  shape list if the image itself never changes per-undo-step) or for apps that
  need hundreds of very large undo steps retained.
status: stable
owner: personal
extends: lit-avosignals-reactivity
group: anatoli
---
## When to use

A Lit component (per [[lit-avosignals-reactivity]]) holds its document state
in a `Signal` — e.g. a list of shapes, form fields, or any structured, plain
JSON-serializable value — and needs undo/redo. This pattern snapshots the
*entire* signal value before each mutation rather than diffing or building
command objects, which is simple and reliable at small-to-moderate state
sizes (a few hundred shapes/items) and trivial to reason about, at the cost
of higher memory use than a diff-based approach for very large state.

## Pattern

1. Keep two plain arrays (not signals — the undo/redo stacks themselves don't
   need to be reactive, only the current state does) alongside the data
   signal:

   ```ts
   pages = new Signal<Page[]>([...]);

   #undoStack: Page[][] = [];
   #redoStack: Page[][] = [];
   ```

2. Before every mutation that should be undoable, push a deep clone of the
   *current* value onto the undo stack and clear the redo stack (a new
   mutation invalidates any previously-undone redo path):

   ```ts
   #snapshot(): void {
     this.#undoStack.push(structuredClone(this.pages.value));
     this.#redoStack = [];
   }

   addShape(shape: Shape): void {
     this.#snapshot();
     this.pages.update((pages) => /* ...apply the change... */);
   }
   ```

   Call `#snapshot()` at the start of every state-mutating method that should
   be a single undo step — one snapshot per user-visible action (e.g. one
   per completed shape draw), not per intermediate value during a drag.

3. `undo()` pops the last snapshot, but first pushes the *current* value onto
   the redo stack so redo can restore it:

   ```ts
   undo(): void {
     const prev = this.#undoStack.pop();
     if (!prev) return;
     this.#redoStack.push(structuredClone(this.pages.value));
     this.pages.set(prev);
   }

   redo(): void {
     const next = this.#redoStack.pop();
     if (!next) return;
     this.#undoStack.push(structuredClone(this.pages.value));
     this.pages.set(next);
   }
   ```

4. Wire standard keyboard shortcuts in the component (Cmd/Ctrl+Z for undo,
   Shift+Cmd/Ctrl+Z for redo):

   ```ts
   #onKeydown = (e: KeyboardEvent) => {
     const mod = e.metaKey || e.ctrlKey;
     if (!mod) return;
     if (e.key.toLowerCase() === 'z' && e.shiftKey) { e.preventDefault(); this.store.redo(); }
     else if (e.key.toLowerCase() === 'z') { e.preventDefault(); this.store.undo(); }
   };
   ```

   Because `pages` is a `Signal` read during `render()`, `SignalWatcher`
   re-renders the component automatically after `.set()` — no manual
   `requestUpdate()` needed for the state change itself (though if `undo()`/
   `redo()` also need to trigger a side effect outside Lit's render, e.g.
   redrawing an imperative `<canvas>`, call that explicitly after `.set()`).

5. Optional: a "reset" action (e.g. after exporting/handing off the document)
   should also clear both stacks, not just reset the data signal — otherwise
   undo could resurrect pre-reset state that's no longer meaningful:

   ```ts
   resetAfterExport(): void {
     this.pages.set([makeInitialPage()]);
     this.#undoStack = [];
     this.#redoStack = [];
   }
   ```

## Why

`structuredClone` snapshotting is the simplest correct approach when state is
already plain serializable data — no need for a command pattern (undo
functions paired with redo functions) or per-field diffing, both of which add
real complexity for marginal benefit at small state sizes. The trade-off is
memory: each undo step holds a full deep copy, so this pattern is a poor fit
for state containing large binary payloads (put those in a separate
non-snapshotted signal, e.g. keep an image `dataUrl` outside the undo-tracked
shape list if the image itself never changes per-undo-step) or for apps that
need hundreds of very large undo steps retained.
