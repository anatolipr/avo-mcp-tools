---
name: lit-canvas-zoom-pan
description: >-
  Adds zoom in/out/reset controls to a canvas or image element in Lit, keeping
  the element's true pixel size as the 100% baseline (never auto-stretched to
  fill the viewport) and using CSS transform: scale() for the zoom itself, with
  an explicitly-sized wrapper so scrolling/centering stay correct at any zoom
  level. Use whenever adding zoom controls to a canvas, image viewer, or
  infinite-canvas-style app in Lit.
tags:
  - lit
  - avosignals
  - canvas
  - zoom
  - frontend
trigger_phrases:
  - zoom in zoom out
  - canvas zoom
  - image zoom controls
  - scale canvas
metadata:
  owner: personal
  status: stable
  extends: lit-avosignals-reactivity
---

## When to use

Building a canvas- or image-based Lit component (an annotator, viewer, editor)
where the content should display at its true pixel size by default — not
stretched via `max-width`/`max-height` to fill available space — and the user
needs zoom in/out/reset controls. Ported from an anchor-preserving pan/zoom
implementation (`zoomAt`/`scene` + `transform: scale()`) in a Svelte canvas
app; this version is simplified for a single fixed-position canvas rather than
an infinite freeform plane, so it skips the anchor-point math and scene
offset — just scale + an explicitly-sized wrapper.

## The bug this avoids

A common mistake: capping a canvas/image with CSS like

```css
canvas { max-width: 90vw; max-height: 78vh; }
```

This looks reasonable but silently stretches small content (e.g. a small
cropped screenshot) up to fill most of the viewport, since the browser scales
the element's CSS box independent of its actual pixel dimensions. The fix is
to not cap size at all by default — let the canvas render at its native
`width`/`height` — and offer explicit zoom controls instead of relying on
CSS-box constraints to "fit" content.

## Pattern

1. Store zoom as a `Signal<number>` (per [[lit-avosignals-reactivity]]),
   alongside whatever other state signals your component has:

   ```ts
   const ZOOM_MIN = 0.1;
   const ZOOM_MAX = 4;
   const ZOOM_STEP = 1.2;

   zoom = new Signal<number>(1);

   zoomIn(): void {
     this.zoom.set(Math.min(ZOOM_MAX, this.zoom.value * ZOOM_STEP));
   }
   zoomOut(): void {
     this.zoom.set(Math.max(ZOOM_MIN, this.zoom.value / ZOOM_STEP));
   }
   zoomReset(): void {
     this.zoom.set(1);
   }
   ```

   Reset zoom to `1` whenever new content loads (a new image/page), so a
   previous zoom level doesn't carry over onto unrelated content.

2. **Don't** put the `scale()` transform on a container sized by normal flow
   layout (e.g. `margin: auto` centering) — `transform` doesn't affect layout
   size, so the browser still thinks the box is unscaled. This breaks
   scroll-area sizing and centering as soon as zoom != 1.

3. Instead, size an outer wrapper *explicitly* to the scaled pixel dimensions,
   computed from the canvas's natural size (`canvas.width`/`canvas.height`,
   which for a `<canvas>` element are its real pixel buffer size) times the
   current zoom:

   ```ts
   #canvasWrapStyle(): string {
     const canvas = this.#canvasRef.value;
     const zoom = this.zoom.value;
     if (!canvas || !canvas.width) return '';
     return `width:${canvas.width * zoom}px; height:${canvas.height * zoom}px;`;
   }
   ```

   ```css
   .canvas-wrap {
     position: relative;
     margin: auto;       /* centers correctly because the box is sized right */
     overflow: hidden;   /* clips the scaled canvas to the wrap's box */
   }
   canvas {
     display: block;
     transform-origin: 0 0;
   }
   ```

   ```html
   <div class="canvas-wrap" style=${this.#canvasWrapStyle()}>
     <canvas ${ref(this.#canvasRef)} style="transform: scale(${this.zoom.value})"></canvas>
   </div>
   ```

   The wrap's box now genuinely has the scaled size, so `.stage { overflow: auto }`
   scrollbars and `margin: auto` centering both work correctly at any zoom
   level, while the `<canvas>` itself stays at native resolution internally
   (no redraw/re-render needed just to zoom — `scale()` is purely visual).

4. Wire toolbar buttons plus keyboard shortcuts (mirroring undo/redo's
   Cmd/Ctrl+Z pattern):

   ```ts
   #onKeydown = (e: KeyboardEvent) => {
     const mod = e.metaKey || e.ctrlKey;
     if (!mod) return;
     if (e.key === '=' || e.key === '+') { e.preventDefault(); this.zoomIn(); }
     else if (e.key === '-') { e.preventDefault(); this.zoomOut(); }
     else if (e.key === '0') { e.preventDefault(); this.zoomReset(); }
   };
   ```

5. If pointer coordinates on the canvas need to stay accurate while zoomed
   (e.g. drawing on the canvas), no extra math is needed: read the pointer
   position via `canvas.getBoundingClientRect()` and scale against
   `canvas.width`/`canvas.height` as usual — `getBoundingClientRect()`
   already reflects the CSS-transformed (scaled) size, so the existing
   ratio-based conversion is zoom-transparent automatically.

## Why

Auto-stretching small content to fill the viewport (via `max-width: 90vw`-
style CSS) is a common and surprising default — it looks like a sizing
convenience but actually distorts perceived scale ("this screenshot looks
huge" when it was a tiny cropped region). Explicit zoom controls plus a
natural-size default keep what's on screen predictable, while sizing the
wrapper to the *scaled* dimensions (rather than relying on `transform` to
also resize the box) is what keeps browser-native scroll and centering
behavior correct — `transform` is visual-only and never affects layout.
