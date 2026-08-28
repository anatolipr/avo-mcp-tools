---
name: avosignals-core
description: >-
  Explains avosignals' core API — Signal, Computed, effect, batch, and manual
  subscribe — independent of any framework. Use whenever writing or reading
  avosignals code outside a Lit component (vanilla DOM/Web Components, plain
  TS/JS state, or understanding what Signal/Computed/effect actually do under
  the hood): dependency tracking, weak-by-default Computed subscriptions, the
  write-during-computation guard, and batching multiple .set() calls into one
  effect flush. For the Lit-specific SignalWatcher integration, see
  lit-avosignals-reactivity instead.
tags: []
trigger_phrases: []
metadata:
  owner: null
  status: unreviewed
  extends: null
deprecated: false
created_at: '2026-08-28T15:28:23.169Z'
---
## Where things live

`avosignals` — an npm package (`avosignals`), not workspace-local code. Source: `github.com/anatolipr/avos`, package dir `packages/avosignals`. Core exports: `Signal`, `Computed`, `effect`, `batch`. Import as:

```ts
import { Signal, Computed, effect, batch } from 'avosignals';
```

This skill covers the library itself, framework-agnostic. For wiring it into a Lit component's render cycle via `SignalWatcher`, see [[lit-avosignals-reactivity]] instead — that skill builds on this one.

## The three primitives

**`Signal<T>`** — a mutable reactive cell.

```ts
const count = new Signal(0, 'count'); // optional name, shows up in error messages/toString()

count.get();          // read, tracks a dependency if inside a reactive context
count.value;           // same as get() — concise property form
count.set(5);           // write, notifies subscribers if the value actually changed
count.value = 5;        // same as set()
count.update(n => n + 1); // set(fn(get())) in one call
```

**`Computed<T>`** — a derived, read-only value. Lazy: the function only re-runs when read *after* a dependency changed, not on every dependency change eagerly.

```ts
const doubled = new Computed(() => count.get() * 2, 'doubled');
doubled.get(); // evaluates fn() the first time, then caches until a dependency changes
```

Dependency tracking is automatic and dynamic: whichever `Signal`/`Computed` a `Computed`'s function actually reads *during that specific evaluation* becomes its dependency list — re-computed fresh on every re-evaluation, so a conditional read (`cond ? a.get() : b.get()`) only tracks whichever branch actually ran. No dependency array to declare by hand.

**`effect(fn)`** — a side effect that reruns automatically when any signal it read changes. Runs once immediately, then again on every relevant change.

```ts
const dispose = effect(() => {
  console.log(`count is ${count.get()}`);
  return () => console.log('cleanup before next run / on dispose'); // optional
});

count.set(1); // re-runs fn, logging the cleanup from the previous run first
dispose();    // runs cleanup one last time, stops tracking
```

Always call the returned `dispose()` when the effect's owner goes away (e.g. a component's `disconnectedCallback`) — an un-disposed effect keeps a live subscription and never gets garbage collected.

## Real usage pattern: private Signal fields + one Computed

The idiomatic shape (used throughout this project's own UI, e.g. `mem-bucket-app.ts`): one private `Signal` per independent piece of state, plus a `Computed` that derives something from several of them at once — instead of one big reactive object.

```ts
class SearchPanel {
  #query = new Signal('');
  #activeTags = new Signal<string[]>([]);
  #sort = new Signal<string>('');

  // Recomputes automatically whenever query/activeTags/sort change, and only then.
  #requestQuery = new Computed(() => {
    const params = new URLSearchParams();
    if (this.#query.value.trim()) params.set('q', this.#query.value.trim());
    for (const tag of this.#activeTags.value) params.append('tag', tag);
    if (this.#sort.value) params.set('sort', this.#sort.value);
    return params.toString();
  });
}
```

This keeps each field independently settable/readable without a reducer or a single monolithic state signal, while still getting a single derived value with no manual recomputation logic.

## `batch`: coalescing multiple writes

Wrap several `.set()`/`.update()` calls that logically belong to one change so dependent effects/computeds only react once, after all writes land, instead of once per write:

```ts
import { batch } from 'avosignals';

batch(() => {
  firstName.set('Ada');
  lastName.set('Lovelace');
}); // effects reading both only run once here, not twice
```

Nested `batch()` calls are safe — only the outermost batch's completion triggers the flush.

## Manual `subscribe` (rare — prefer `effect`)

`Signal`/`Computed` also expose `.subscribe(fn)` directly, for integrating with something outside avosignals' own tracking (a legacy callback API). Unlike `effect`, a manual subscription does **not** auto-track dependencies — it only fires for the exact signal you called `.subscribe()` on, and you're responsible for calling the returned unsubscribe function yourself.

```ts
const unsubscribe = theme.subscribe(() => console.log(`theme: ${theme.get()}`));
// later:
unsubscribe();
```

Reach for `effect()` by default; use `.subscribe()` only when you specifically need to listen to one signal without creating a tracked reactive scope.

## Vanilla DOM / Web Components (no Lit)

Without a render-cycle integration, bind an `effect` in `connectedCallback` and dispose it in `disconnectedCallback`:

```ts
class VanillaCounter extends HTMLElement {
  #dispose?: () => void;

  connectedCallback() {
    this.#dispose = effect(() => {
      this.textContent = `Count: ${count.get()}`;
    });
  }

  disconnectedCallback() {
    this.#dispose?.(); // always clean up — prevents a leaked subscription
  }
}
```

## Guardrails worth knowing about

- **Write-during-computation is forbidden.** Calling `.set()` on a `Signal` while a `Computed` is currently evaluating throws immediately, rather than silently causing an inconsistent read. If you hit this, the fix is almost always to move the write outside the `Computed`'s function (e.g. into an `effect` instead), not to catch/suppress the error.
- **Cycle detection.** A `Computed` that reads itself transitively (A → B → A) throws a descriptive cycle error at evaluation time instead of infinite-looping.
- **`Computed` subscriptions are weak by default** (`WeakRef`-based) so an unreferenced derived signal can be garbage collected even while its source `Signal` is still alive — avoids the classic "detached listener" leak. `effect()` internally uses a non-weak `Computed`, since an effect's whole purpose is the side effect firing, so it must not be collected just because nothing holds a reference to the `dispose` function's closure.
- **Equality check before notifying**: `.set()` only notifies subscribers if the new value is actually different (a `NaN`-safe, reference-based check for objects/functions) — setting a signal to its current primitive value is a no-op, no re-render/re-run triggered.

## Why

`avosignals` gives fine-grained, per-value reactivity with automatic dependency tracking — no dependency arrays, no manual `requestUpdate()`/subscription bookkeeping for the common case. The trade-offs that most affect how you write code against it: `Computed` is lazy (cheap to declare, only pays for evaluation on read), `effect` is eager and needs explicit disposal, and the write-during-computation guard means side effects belong in `effect`, not inside a `Computed`'s function.

