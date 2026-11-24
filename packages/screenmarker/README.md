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
- **Share as a presentation**: **🔗 Share** saves the document and copies a view-only link anyone can open, no account needed. It opens as full-screen slides (one per page, with annotations and tags); viewers can step through, go fullscreen, or "Edit a copy" in their own editor. Links expire after 30 days and always show the latest saved version. **▶ Present** shows the same slides for the open document; its **🔗 Copy link** saves and copies the same view-only link without leaving the presentation (on a shared link, it copies that link). Slides open at the editor's zoom and keep the page's images centered, so they stay in place between slides wherever the tags are. While presenting: `+`/`-` (or pinch, `Cmd/Ctrl`+scroll) zoom, `0` fits, hold or tap `L` for a laser pointer, `N` for speaker notes
- **Blank pages as slides**: a page doesn't need a screenshot. Add a page (**+ Page**) and type text, draw arrows, boxes, tags, and steps straight onto it, like a slide; images can be pasted in later. Text-only slides render sharp when presenting
- **Rich, multi-line text** — click with the Text tool to type in place, or drag to draw a text box whose width wraps the text (drag any of its 8 handles later, or the editor's corner grip while typing, to make it wider or taller; right-click → **Auto size** to fit the text again). Double-click any label to edit it. `Shift+Enter` adds a line, `Enter` finishes. The toolbar sets **bold / italic / underline**, **alignment** (left, center, right), and the **font** (sans, serif, mono, hand) for text and tags. While typing, `Cmd/Ctrl+B`/`I`/`U` format the selected words (or toggle the whole label), and a small Markdown subset is drawn formatted: `**bold**`, `*italic*`, `__underline__`, `~~strike~~` (`Cmd/Ctrl+Shift+X`), `` `code` ``, `# Heading`/`## Smaller`, `- bullets` (indent two spaces per level), `1. numbered`, and `[ ]`/`[x]` to-dos. Tags take the same formatting
- **Box select** (`v`): drag on empty space — on the image or around it — to draw a selection box that stays after you let go. It selects the shapes it touches; move it by its body or resize it by its edges and corners, then **Copy selection** (`Cmd/Ctrl+C`, includes annotations) or **Crop selection** (`Enter`, crops every picture the box overlaps to the box and keeps annotations editable; undoable). `Esc` clears it
- **Rotate and flip** the selected pictures, or with none selected the whole page (annotations follow)
- **Zoom and pan**: images open fit-to-window; `Cmd/Ctrl+scroll` or trackpad pinch zooms around the cursor; hold `Space` and drag to pan (tap `Space` for the preview)
- **Custom colors** via a color picker, plus an eyedropper (in Chromium browsers) to pick any color on screen
- **Toolbar**: starts with page navigation (‹ n / N › and + for a blank page). **▴** minimizes it to page navigation, tool icons, undo/redo, present and copy; **▾** brings the full toolbar back (remembered per browser)
- **Page strip**: a sidebar of slide thumbnails — click to switch, drag to reorder, hover for duplicate/delete, right-click for more (move up/down, present from here); **« Tabs** collapses it to compact tabs in the top bar (▤ brings the thumbnails back)
- **Slide panel** under the canvas: a slide **title** (shown on the thumbnail and when presenting), **speaker notes** (shown only when you present the open document, with `N`; they are stored in the document, so don't put secrets there if you share it), and **Reveal tags & steps one at a time**, which presents that page's tags, step markers and magnifiers one per click, in the order you added them (`Cmd/Ctrl+]`/`[` changes the order)
- **Right-click menus** on shapes (edit, duplicate, copy, front/back, color, delete), on empty canvas (paste, select all, present), and on pages
- **Shift while drawing**: lines and arrows snap to 45°, rectangles/ellipses/highlights/blurs become squares and circles; Shift while moving locks to one axis; Shift on a corner handle keeps the aspect ratio
- **Multi-page documents** — add multiple screenshots as tabs, duplicate a page (⧉ on its tab, or `Shift+Cmd/Ctrl+D`), reorder them by dragging, and copy/export them together as one stacked image or individually
- **Paste, drag-and-drop, or file picker** to load images
- **Infinite canvas**: the wheel or two-finger scroll moves the whole scene (Space-drag or middle-drag too); pinch or `Cmd/Ctrl`+scroll zooms around the cursor. Draw anywhere: arrows, text, boxes and every other tool work outside the image, not only tags. Each page remembers where you left it (also used to center its slide); **⌖ Reset view** goes back to the initial, fitted position
- **Scene background**: the **Scene** setting colors the space around the page in the editor and slides: System (white in light mode, black in dark), the app theme, white, black, or a custom color
- **Command palette**: press `Shift` twice for a searchable list of commands (tools, copy/export, present, find, pages, zoom, view, backgrounds…); `↑`/`↓` and `Enter` run one
- **Copy a selection**: with a selection region (or selected shapes), Copy Image / Copy Current Page / `Cmd/Ctrl+C` copy only that area; paste it back with `Cmd/Ctrl+V` and it lands as a picture you can move and resize
- **Magnifier** (`M`): drag from a detail to where the lens should go; the lens shows that spot enlarged with a connector back to it. Drag the lens or the spot to move them, the handle on the lens edge to resize it, and right-click to change the zoom (1.5×–4×)
- **Find text** (`Cmd/Ctrl+F`): searches the words in the page's pictures with on-device text recognition (Tesseract.js, downloaded from a CDN the first time you search). `Enter`/`Shift+Enter` step through matches; **Highlight all** or **Blur all** marks every match, e.g. to hide an email address everywhere
- **Copy as Markdown**: copies each page's title, numbered steps (each step marker paired with its nearest tag or text) and remaining labels as Markdown, plus the images when pasting into rich editors (Google Docs, Notion, …). Speaker notes are not included
- **Export background**: the **BG** setting next to Download sets what fills the space around the image (where margin tags sit) in copies and downloads: the scene background (default), white, transparent, or a custom color
- **Pictures**: every image on a page is a picture, the first screenshot included, and they all behave the same. Click one to select it (`Shift`+click adds it to the selection); a drag on an unselected picture draws a selection box instead, so you can box-select over a screenshot. Drag a selected picture to move it, or its handles to resize it (corners keep proportions; hold Shift to stretch). Pasting or dropping onto a page that has content adds another picture. Right-click pictures for **Original size** (back to the image's own pixel size), **Arrange pictures in a row** (the leftmost stays, the rest line up beside it at its height), **Move to a new page** (each selected picture gets its own page, with the annotations that sit on it), and **Highlight changes** vs the previous page or the other selected picture. `Cmd/Ctrl+X` cuts shapes or pictures; the next paste puts them back in place
- **Snap arrows** (🧲 Snap in the toolbar, on by default): an arrow or line end dropped on a text, tag, picture, rectangle, or ellipse attaches to it, and follows when that moves, is resized, or its text changes (outlined while you draw). Drag the end off to detach it. Turn it off to place ends freely
- **Redact secrets**: right-click (or the command palette), then **Redact secrets** blurs words that look like emails, API keys, and tokens, found with the same on-device text recognition as Find text. Optional **Auto-redact new pictures** (off by default) does it for every picture you paste or drop
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
