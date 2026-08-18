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

## Run

```sh
npm install
npm run build
npm start   # or: npm run dev for auto-restart on source changes
```

Starts a stateless StreamableHTTP MCP server at `http://localhost:8767/mcp`
(override with `PORT`). This is a long-lived process, not a one-shot CLI —
the SQLite cache is kept current by a file watcher for as long as the
server runs.

The same process also serves a browser UI at `http://localhost:8767/` for
searching/filtering skills and memory docs by tag, root, status, owner,
and fulltext (SQLite FTS5) — a way to review what's in the index without
going through an agent. It also manages **roots**: add a skill or memory
root by browsing the filesystem, or remove one (unregisters it and drops
its cached rows — never deletes files on disk). Editing individual skills
or memory docs still goes through the `skill_*`/`memory_*` tools or the
files directly. From an MCP session connected to this server, call
`bucket_open_ui` to get the URL. If no roots are configured yet, the UI
opens straight into a first-run "add your first root" screen. The UI is a
Lit + `avosignals` app built with Vite (`src/client/`, bundled to
`dist/client/`) — `npm run build` builds it (along with the server);
`npm start` does **not** rebuild it, so run `npm run build` again after
changing anything under `src/client/`. `npm run dev` rebuilds the client
on change alongside the server, for active UI development.

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
  otherwise the server starts with zero roots and the UI's first-run
  screen offers to add one.

  **Multiple roots** (e.g. a personal skills folder plus a shared company
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
  With a single root of a kind, `skill_create`/`memory_create`/etc. work
  exactly as before. Once 2+ roots exist, those tools require an explicit
  `root` argument (and `skill_list`/`memory_list` gain an optional `root`
  filter) — every list/get response also includes which `root` each item
  came from. Roots can be added or removed at runtime through the web UI
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

## Test

```sh
npm test
```
