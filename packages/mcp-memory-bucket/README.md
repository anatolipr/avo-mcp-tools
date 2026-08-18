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

### Configuration

The server refuses to start unless it's told explicitly which folder to use
for memory — it will not silently default to whatever directory it happens
to be launched from. Provide one of:

- a `memory-bucket.config.json` file in the working directory:

  ```json
  {
    "skill_sources": ["./skills"],
    "memory_sources": ["./docs/superpowers/plans", "./docs/superpowers/specs"]
  }
  ```

  Paths are resolved relative to the working directory. Defaults match the
  example above if no `skill_sources`/`memory_sources` key is present.

- the `MEMORY_BUCKET_DIR` environment variable, or the `--memory-dir <path>`
  CLI flag — either sets the base directory that the (still-defaultable)
  `skill_sources`/`memory_sources` are resolved against.

  ```sh
  npm start -- --memory-dir ./
  # or: MEMORY_BUCKET_DIR=./ npm start
  ```

  Note the `--` before `--memory-dir` — without it, npm swallows the flag
  itself instead of passing it through to the script.

If none of these are present, the server exits immediately with an error
instead of starting against the wrong folder.

## Test

```sh
npm test
```
