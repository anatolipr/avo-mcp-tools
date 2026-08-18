# mcp-memory-bucket

MCP server exposing `skill_*` (reusable coding patterns, stored as
[agentskills.io](https://agentskills.io)-standard `SKILL.md` folders) and
`memory_*` (point-in-time working context — plans, specs, SQL, session
summaries) tools over markdown+frontmatter files, cached into SQLite at
runtime.

See [AGENTS.md](./AGENTS.md) for the frontmatter schemas, tool reference,
and how an agent should use this — the same content is also published as
the `memory-bucket-authoring` skill
(`skills/memory-bucket-authoring/SKILL.md`), fetchable via
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

The same process also serves a read-only browser UI at
`http://localhost:8767/` for searching/filtering skills and memory docs by
tag, status, owner, and fulltext (SQLite FTS5) — a way to review what's in
the index without going through an agent. It has no write access; all
edits still go through the `skill_*`/`memory_*` tools or the files
directly. From an MCP session connected to this server, call
`bucket_open_ui` to get the URL. The UI is a Lit + `avosignals` app built
with Vite (`src/client/`, bundled to `dist/client/`) — `npm run build`
builds it (along with the server); `npm start` does **not** rebuild it, so
run `npm run build` again after changing anything under `src/client/`.
`npm run dev` rebuilds the client on change alongside the server, for active
UI development.

### Configuration

By default the server uses the current working directory as the base for
memory/skill sources. Override that with one of:

  ```json
  {
    "skill_sources": ["./skills"],
    "memory_sources": ["./docs/plans", "./docs/specs"]
  }
  ```

  Paths are resolved relative to the working directory. Defaults match the
  example above if no `skill_sources`/`memory_sources` key is present.

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
