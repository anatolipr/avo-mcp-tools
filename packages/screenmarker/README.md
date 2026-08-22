# screenmarker

Paste a screenshot, annotate it, copy it back to your clipboard. That's the whole workflow.

No accounts, no uploads — everything runs in your browser and nothing leaves your machine.

## Quick start

```sh
npx screenmarker
```

Starts a local server and opens the app in your browser. Paste a screenshot (`Cmd/Ctrl+V`), mark it up, and copy the result back out (`Cmd/Ctrl+C`) to paste into Slack, a PR comment, a doc — anywhere that accepts an image.

## Features

- **Annotate** with rectangles, arrows, text labels, freehand pen, and highlight — each with adjustable color and stroke width (or font size for text)
- **Select and edit** any shape after drawing it: move, restyle, or delete
- **Multi-page documents** — add multiple screenshots as tabs, reorder them by dragging, and copy/export them together as one stacked image or individually
- **Paste, drag-and-drop, or file picker** to load images
- **Copy to clipboard** or **download as PNG**, plus a **preview** of exactly what will be copied
- **Save/load as a document file** (JSON) to resume annotating later
- **Undo/redo**, zoom, and light/dark/auto theme
- Keyboard-driven: tool shortcuts (`v` select, `r` rect, `a` arrow, `t` text, `p` pen, `h` highlight), `[`/`]` for stroke or font size, `,`/`.` to reorder pages, arrow keys to switch pages, `Cmd/Ctrl+S`/`O` to save/load

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
