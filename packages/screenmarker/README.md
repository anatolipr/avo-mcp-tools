# screenmarker

Paste a screenshot, annotate it, copy it back to your clipboard. That's the whole workflow.

No accounts, no uploads — everything runs in your browser and nothing leaves your machine.

## Quick start

```sh
npx screenmarker
```

Starts a local server and opens the app in your browser. Paste a screenshot (`Cmd/Ctrl+V`), mark it up, and copy the result back out (`Cmd/Ctrl+C`) to paste into Slack, a PR comment, a doc — anywhere that accepts an image.

## Features

- **Annotate** with rectangles, ellipses, arrows, lines, text, numbered step markers (they count up on their own; select one with `v` and type a number, press `Enter`, or double-click it to edit; clicking a marker with the Step tool edits it too, or set **Next #** in the toolbar to continue from another slide, e.g. 11), freehand pen, highlight, and blur/pixelate (for hiding secrets) — each with adjustable color and stroke width (or font size for text and steps). Rectangles and ellipses can be filled, and text can sit on a solid background box
- **Select and edit** shapes after drawing: click, Shift+click, or drag a box to multi-select; move, resize (corner/edge handles, arrow/line endpoints), restyle, duplicate, reorder (front/back), or delete. Arrow keys nudge the selection (Shift for 10px)
- **Tags** (`g`): speech-bubble callouts that explain part of a page. Place them anywhere, including the empty space around the image. A floating panel next to the tag picks the pointer direction (a 4×3 grid: three spots on each side) or none, for a plain note; `Shift`+arrow keys jump the pointer to a side and `Space` cycles it. Multi-line text with `Shift+Enter`. Anything drawn past the image edge is included in copies, downloads, and slides (on white)
- **folderfoo account** (avatar, top right): sign in to **☁ Open…** and **☁ Save** documents in your folderfoo storage (`Shift`+click Save for "save as"). The open document's name is kept in the URL `#hash`, so a reload reopens it. Cloud documents **autosave** a moment after each change (the title bar shows Saved / Saving… / Changed elsewhere), and **reload live** when another tab or device saves them (if you have unsaved edits you choose: Reload or Save as…). The start screen lists **recent documents** (previews are cached in this browser)
- **Share as a presentation**: **🔗 Share** saves the document and copies a view-only link anyone can open, no account needed. It opens as full-screen slides (one per page, with annotations and tags); viewers can step through, go fullscreen, or "Edit a copy" in their own editor. Links expire after 30 days and always show the latest saved version. **▶ Present** shows the same slides for the open document. While presenting: hold or tap `L` for a laser pointer, `N` for speaker notes
- **Inline text editing** — click with the Text tool to type in place; double-click any label to edit it
- **Box select** (`v`): drag on empty space — on the image or around it — to draw a selection box that stays after you let go. It selects the shapes it touches; move it by its body or resize it by its edges and corners, then **Copy selection** (`Cmd/Ctrl+C`, includes annotations) or **Crop selection** (`Enter`, crops the image to where the box overlaps it and keeps annotations editable; undoable). `Esc` clears it
- **Rotate and flip** the image; annotations follow
- **Zoom and pan**: images open fit-to-window; `Cmd/Ctrl+scroll` or trackpad pinch zooms around the cursor; hold `Space` and drag to pan (tap `Space` for the preview)
- **Custom colors** via a color picker, plus an eyedropper (in Chromium browsers) to pick any color on screen
- **Page strip**: a sidebar of slide thumbnails — click to switch, drag to reorder, hover for duplicate/delete, right-click for more (move up/down, present from here)
- **Slide panel** under the canvas: a slide **title** (shown on the thumbnail and when presenting), **speaker notes** (shown only when you present the open document, with `N`; they are stored in the document, so don't put secrets there if you share it), and **Reveal tags & steps one at a time**, which presents that page's tags and step markers one per click, in the order you added them (`Cmd/Ctrl+]`/`[` changes the order)
- **Right-click menus** on shapes (edit, duplicate, copy, front/back, color, delete), on empty canvas (paste, select all, present), and on pages
- **Shift while drawing**: lines and arrows snap to 45°, rectangles/ellipses/highlights/blurs become squares and circles; Shift while moving locks to one axis; Shift on a corner handle keeps the aspect ratio
- **Multi-page documents** — add multiple screenshots as tabs, duplicate a page (⧉ on its tab, or `Shift+Cmd/Ctrl+D`), reorder them by dragging, and copy/export them together as one stacked image or individually
- **Paste, drag-and-drop, or file picker** to load images
- **Copy to clipboard** or **download as PNG**, plus a **preview** of exactly what will be copied
- **Save/load as a document file** (JSON) to resume annotating later. Note: the saved file keeps the original, un-blurred image so blur stays editable — share the exported PNG, not the document file, when blur hides something sensitive
- **Undo/redo** and light/dark/auto theme
- Keyboard-driven: tool shortcuts (`v` select / box select, `r` rect, `o` ellipse, `a` arrow, `l` line, `t` text, `g` tag, `n` step, `p` pen, `h` highlight, `b` blur), `[`/`]` for stroke or font size, `f` fit to window, `Cmd/Ctrl+A` select all, `Cmd/Ctrl+D` duplicate, `Cmd/Ctrl+]`/`[` bring to front/send to back, `,`/`.` to reorder pages, `←`/`→` to switch pages (when nothing is selected), `Cmd/Ctrl+S`/`O` to save/load

## Deploying to the web

The client is a static, self-contained app (no server-side logic — the local Node server just serves static files and auto-opens a browser tab). It can be hosted anywhere that serves static files.

This package ships a Cloudflare Pages setup:

```sh
./deploy.sh
```

This builds the client and deploys `dist/client` to Cloudflare Pages under the project name `screenmarker`, logging you in via browser the first time.

## Local development

```sh
npm install
npm run dev      # watches and rebuilds the client + server
```

```sh
npm run build     # production build
npm start         # build + run the local server
```

## License

MIT
