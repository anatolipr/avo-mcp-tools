# mcp-memory-bucket

MCP server exposing `skill_*` (reusable coding patterns, stored as
[agentskills.io](https://agentskills.io)-standard `SKILL.md` folders) and
`memory_*` (point-in-time working context — plans, specs, SQL, session
summaries) tools over markdown+frontmatter files, cached into SQLite at
runtime.

See [AGENTS.md](./AGENTS.md) for the frontmatter schemas, tool reference,
and how an agent should use this — the same content is also published as
the `memory-bucket-authoring` skill
(`src/skills/builtin/memory-bucket-authoring/SKILL.md`), built in so it's
always available regardless of `--memory-dir`/cwd, fetchable via
`skill_get("memory-bucket-authoring")` from any MCP session connected to
this server. See
[skill-bucket-v0-plan.md](../../skill-bucket-v0-plan.md) at the workspace
root for the full design plan.

## Example uses

A few illustrative scenarios (not transcripts of real sessions):

**Saving a reusable pattern as a skill.** After pairing on a Lit dropdown
component with keyboard navigation and ARIA roles, you tell the agent
"save this as a skill for next time." It calls `skill_create` with a
description covering both what the pattern does and when to use it, so
future sessions can discover it by keyword.

**Capturing a plan before a big refactor.** Before starting a multi-day
migration, you ask the agent to write out its plan and save it under the
ticket key: `memory_create(key: "RMXS-142", doc_type: "plan", ...)`. Later
sessions on the same ticket call `memory_get("RMXS-142")` to pick up
exactly where the last one left off, without you re-explaining context.

**Triaging a year-old bucket.** A memory bucket that's accumulated docs
for a year has a lot of dead weight. Sorting the web UI by "Oldest first"
surfaces the stalest entries; selecting a batch and clicking "Mark
deprecated" flags them without losing their original `status`, and a
follow-up "Delete" (after a confirm dialog) clears out the ones nobody
needs. The same triage works from an agent via `memory_bulk_update(ids,
{ deprecated: true })` followed by `memory_bulk_delete`.

**Bulk-tagging after a search.** "Find every skill about deploys and mark
the outdated ones deprecated" becomes `skill_search("deploy")` to find
candidates, then `skill_bulk_update(names, { deprecated: true })` to flag
the stale ones in one call — no need to touch each file individually.

## Run

### Via npx

No install needed — runs the published package directly:

```sh
npx mcp-memory-bucket
# or, with the flags described below:
npx mcp-memory-bucket --memory-dir /path/to/dir
```

This is the simplest way to point an MCP client at a memory bucket
without cloning this repo.

### From source

```sh
npm install
npm run build
npm start   # or: npm run dev for auto-restart on source changes
```

Starts a stateless StreamableHTTP MCP server at `http://localhost:8767/mcp`
(override with `PORT`). This is a long-lived process, not a one-shot CLI —
the SQLite cache is kept current by a file watcher for as long as the
server runs.

### How the cache stays fresh

The cache is a single SQLite file, `.memory-bucket-cache.sqlite`, written
next to `memory-bucket.config.json` in the base directory (cwd by default,
or `MEMORY_BUCKET_DIR`/`--memory-dir` — see Configuration below). It's a
scan cache, not the source of truth — the markdown files on disk always
are, and the cache can be safely deleted; it's rebuilt on next startup.

- **On startup**, every configured folder is fully walked and each file is
  upserted into the cache, keyed by mtime — a file whose mtime hasn't
  changed since it was last cached is skipped, so restarting is cheap
  even with a large folder.
- **While running**, each folder is watched (via `chokidar`) for `add`,
  `change`, and `unlink` events on matching files, and the cache is
  updated incrementally as they happen — no polling, no manual reindex.
  Only `SKILL.md` files count for skill folders; any `.md` file counts for
  memory folders. The watcher only looks 10 directories deep. A rename
  arrives as a delete-then-add, not a single rename event.
- **Adding a folder** (via the web UI, or a `skill_sources`/`memory_sources`
  entry present at startup) triggers a scan of just that folder, not a
  full rescan of every folder already cached.
- **Removing a folder** (via the web UI) drops its rows from the cache and
  search index immediately — it never touches files on disk.

The same process also serves a browser UI at `http://localhost:8767/` for
searching/filtering skills and memory docs by tag, folder, status, owner,
deprecated flag, and fulltext (SQLite FTS5), and sorting by creation date
or last-touched — a way to review and clean up what's in the index
without going through an agent. It also manages **folders**: add a skill or
memory folder by browsing the filesystem, or remove one (unregisters it and
drops its cached rows — never deletes files on disk). Beyond browsing,
the UI supports marking entries **deprecated** (independent of `status`,
so you don't lose "shipped"/"active" context when flagging something
stale) and **deleting** entries — both single-item and multi-select bulk,
with a confirm dialog before any delete. Deeper edits (renaming, editing
body content, changing tags) still go through the `skill_*`/`memory_*`
tools or the files directly. From an MCP session connected to this
server, call `bucket_open_ui` to get the URL. If no folders are configured
yet, the UI opens straight into a first-run "add your first folder" screen.
The UI is a Lit + `avosignals` app built with Vite (`src/client/`,
bundled to `dist/client/`) — `npm run build` builds it (along with the
server); `npm start` does **not** rebuild it, so run `npm run build`
again after changing anything under `src/client/`. `npm run dev` rebuilds
the client on change alongside the server, for active UI development.

### Configuration

By default the server uses the current working directory as the base for
memory/skill sources. Override that with one of:

  ```json
  {
    "skill_sources": ["./skills"],
    "memory_sources": ["./docs"]
  }
  ```

  Paths are resolved relative to the working directory. If no
  `skill_sources`/`memory_sources` key is present, each defaults to the
  example above only when that directory already exists on disk;
  otherwise the server starts with zero folders and the UI's first-run
  screen offers to add one.

  **Multiple folders** (e.g. a personal skills folder plus a shared company
  repo) are supported — give each source a name instead of a bare path:

  ```json
  {
    "skill_sources": [
      { "name": "personal", "path": "~/skills" },
      { "name": "company", "path": "../company-repo/skills" }
    ]
  }
  ```

  Bare-string and `{name, path}` entries can be mixed in the same array.
  With a single folder of a kind, `skill_create`/`memory_create`/etc. work
  exactly as before. Once 2+ folders exist, those tools require an explicit
  `folder` argument (and `skill_list`/`memory_list` gain an optional `folder`
  filter) — every list/get response also includes which `folder` each item
  came from. Folders can be added or removed at runtime through the web UI
  without a restart; adding one there also appends it to this config file.

- the `MEMORY_BUCKET_DIR` environment variable, or the `--memory-dir <path>`
  CLI flag — either overrides the base directory that the (still-defaultable)
  `skill_sources`/`memory_sources` are resolved against.

  ```sh
  npm start -- --memory-dir /path/to/other/dir
  # or: MEMORY_BUCKET_DIR=/path/to/other/dir npm start
  ```

  Note the `--` before `--memory-dir` — without it, npm swallows the flag
  itself instead of passing it through to the script.

- the `FOLDERFOO_MODE` environment variable, or the `--folderfoo-mode
  <off|dev|cloud>` CLI flag — controls whether the web UI integrates with
  folderfoo (remote skill/memory folders backed by a folderfoo server, plus
  the `folderfoo-profile-circle` login widget). Defaults to `off`: no folderfoo
  code loads, no login widget appears, no network calls to any folderfoo
  server are made. Set to `dev` to point at a local folderfoo dev server
  (`http://localhost:3000`, e.g. via `folderfoo/start-dev.sh`), or `cloud`
  for the real hosted deployment (`https://files.cuul.cc`).

  ```sh
  npm start -- --folderfoo-mode dev
  # or: FOLDERFOO_MODE=dev npm start
  ```

  Unlike browser-only folderfoo consumers (mindfoo, bulletino, avotuner),
  which infer dev-vs-prod from `window.location.hostname`, mcp-memory-bucket
  is a CLI tool whose own page is always `localhost` regardless of which
  folderfoo deployment (if any) is wanted — hence the explicit flag instead
  of hostname-sniffing.

## Test

```sh
npm test
```
