# screenmarker

Paste a screenshot, annotate it, copy it back to your clipboard. That's the whole workflow.

No accounts, no uploads — everything runs in your browser and nothing leaves your machine.

## Quick start

```sh
npx screenmarker
```

Starts a local server and opens the app in your browser. Paste a screenshot (`Cmd/Ctrl+V`), mark it up, and copy the result back out (`Cmd/Ctrl+C`) to paste into Slack, a PR comment, a doc — anywhere that accepts an image.

## Features

- **Annotate** with rectangles, ellipses, arrows, lines, text, numbered step markers, freehand pen, highlight, and blur/pixelate (for hiding secrets) — each with adjustable color and stroke width (or font size for text and steps). Rectangles and ellipses can be filled, and text can sit on a solid background box
- **Select and edit** shapes after drawing: click, Shift+click, or drag a box to multi-select; move, resize (corner/edge handles, arrow/line endpoints), restyle, duplicate, reorder (front/back), or delete. Arrow keys nudge the selection (Shift for 10px)
- **Inline text editing** — click with the Text tool to type in place; double-click any label to edit it
- **Region select** (`m`): drag out a box, move or resize it by its body, edges, or corners, then **Copy selection** (`Cmd/Ctrl+C`, includes annotations) or **Crop selection** (`Enter`, crops the page image and keeps annotations editable; undoable). `Esc` clears it
- **Rotate and flip** the image; annotations follow
- **Zoom and pan**: images open fit-to-window; `Cmd/Ctrl+scroll` or trackpad pinch zooms around the cursor; hold `Space` and drag to pan (tap `Space` for the preview)
- **Custom colors** via a color picker, plus an eyedropper (in Chromium browsers) to pick any color on screen
- **Multi-page documents** — add multiple screenshots as tabs, reorder them by dragging, and copy/export them together as one stacked image or individually
- **Paste, drag-and-drop, or file picker** to load images
- **Copy to clipboard** or **download as PNG**, plus a **preview** of exactly what will be copied
- **Save/load as a document file** (JSON) to resume annotating later. Note: the saved file keeps the original, un-blurred image so blur stays editable — share the exported PNG, not the document file, when blur hides something sensitive
- **Undo/redo** and light/dark/auto theme
- Keyboard-driven: tool shortcuts (`v` select, `m` region, `r` rect, `o` ellipse, `a` arrow, `l` line, `t` text, `n` step, `p` pen, `h` highlight, `b` blur), `[`/`]` for stroke or font size, `f` fit to window, `Cmd/Ctrl+A` select all, `Cmd/Ctrl+D` duplicate, `Cmd/Ctrl+]`/`[` bring to front/send to back, `,`/`.` to reorder pages, `←`/`→` to switch pages (when nothing is selected), `Cmd/Ctrl+S`/`O` to save/load

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
