# memory-bucket: agent usage guide

An MCP server exposing two tool namespaces backed by markdown files with
YAML frontmatter, indexed into a gitignored SQLite cache at runtime:

- **`skill_*`** — reusable, evergreen coding patterns, found by
  keyword/trigger-phrase search. Stored as one folder per skill containing
  a `SKILL.md`, per the [agentskills.io](https://agentskills.io) open
  standard — the same format Claude Code, Cursor, and other agents read
  directly off disk, independent of this MCP server.
- **`memory_*`** — point-in-time working context (plans, specs, SQL,
  testing notes, session summaries) attached to a key, usually a ticket ID
  but not always. Found by exact key lookup, not search. This is
  memory-bucket's own schema — no external standard for this half.

Both share one `relocate` tool for pulling an existing local file into
either namespace.

This same guidance is also published as the `memory-bucket-authoring`
skill in `skills/memory-bucket-authoring/SKILL.md` — call
`skill_get("memory-bucket-authoring")` to pull it into context from
inside an MCP session on any repo with this server connected, without
needing this file directly.

## Skills

### When to use a skill

- **Explicit invocation**: the user says "use skill X" — call
  `skill_get(name)` directly.
- **Soft discovery**: the conversation mentions something skill-shaped
  ("let's build a Lit component") — call `skill_list(query)` with the
  relevant terms, and if there's a match, confirm with the user before
  applying it ("I see a Lit Component skill — use it?"). Don't apply
  silently, don't ignore silently.
- **Browsing**: the user asks "what skills do you have for X" — that's
  just `skill_list("X")` surfaced directly as a list.

### Skill format

A skill is a **folder** containing `SKILL.md` — not a flat markdown file
— per the agentskills.io spec:

```
skills/[optional-subdir/]<name>/
├── SKILL.md
├── scripts/       # optional — not yet written by this server's tools, add by hand if needed
├── references/    # optional
└── assets/        # optional
```

```yaml
---
name: "lit-dropdown-component"    # required. 1-64 chars, lowercase letters/numbers/hyphens,
                                    # no leading/trailing/consecutive hyphens. MUST equal the
                                    # containing folder's name — this is also this project's id.
description: "Builds a dropdown component in Lit with keyboard navigation and ARIA roles. Use when the user asks for a dropdown, select, or combobox component in a Lit-based frontend."
                                    # required. Max 1024 chars. This + name is ALL an agent sees
                                    # at discovery time — state both what it does and when to use it.
license: "MIT"                     # optional
compatibility: "Requires Lit 3.x"  # optional, max 500 chars — only if there are real environment requirements
tags: ["lit", "frontend", "component"]        # optional — memory-bucket extension, not spec-defined
trigger_phrases: ["lit dropdown", "dropdown component"]  # optional — memory-bucket extension
metadata:                          # optional — the spec's own extension point (string values only)
  owner: "frontend-squad"          # squad name or "company"; recorded only, no resolution logic yet
  status: "stable"                 # stable | beta | unreviewed — defaults to unreviewed
  extends: null                    # reserved for a future overlay mechanism
---
Markdown body: the actual pattern, code, rationale, etc. Keep it under
~500 lines — it's loaded in full once the skill activates.
```

`skill_list`'s `query` does a plain substring match against `description`,
`tags`, and `trigger_phrases` — no ranking, no semantic search.
`description` is the field that matters most: it's what both this
server's search and any other agentskills.io-compatible tool use to
decide relevance before ever reading the body.

### Tools

- `skill_list(query?)` — name/description/tags/status/owner, optionally filtered.
- `skill_get(name)` — full doc including body.
- `skill_create(name, description, body, license?, compatibility?, owner?, status?, tags?, trigger_phrases?, extends?, folder?)`
  — writes `<sourceDir>/[folder/]<name>/SKILL.md`. `folder` is an optional
  subdirectory (e.g. `folder: "frontend"` → `skills/frontend/<name>/SKILL.md`).
- `skill_update(name, ...fields?, body?)` — only provided fields change; `name` itself is immutable (delete + recreate to rename).
- `skill_delete(name)` — hard delete, removes the whole skill folder (including any scripts/references/assets), no undo.

## Memory

### When to use memory

The user supplies the key explicitly in conversation — never infer it
from the current branch or environment. "Let's continue on RMXS-14" is
enough to call `memory_get("RMXS-14")` directly. If you don't know the
key, call `memory_list(key_prefix?)` to browse what exists.

Use memory for: plans, specs, ad-hoc SQL from a debugging session, testing
notes, and session summaries — anything that's working context for a
piece of work, not a reusable pattern.

### Memory frontmatter

```yaml
---
id: "rmxs-14-product-boost-bulk-edit"   # required, stable slug — independent of filename
key: "RMXS-14"                          # required, lookup handle — normalized (uppercase, hyphenated) on write
key_type: "ticket"                      # ticket | freeform — "Spot Chart Design" is a valid freeform key
description: "SQL debug session for finding partners"  # distinguishes this doc from siblings under the same key
doc_type: "plan"                        # plan | spec | sql | testing-todo | discovery | session-summary | other
tags: []                                # freeform, unopinionated — no fixed vocabulary
status: "active"                        # active | shipped | abandoned — nothing auto-prunes
related_to: null                        # id of a paired doc, e.g. a spec linking back to its plan
---
Markdown body.
```

One key can have many docs (a plan, a spec, apply.sql, revert.sql, session
summaries, all under the same key) — `memory_get(key)` returns all of
them; pass `doc_type` to narrow to just one kind.

### Tools

- `memory_get(key, doc_type?)` — exact match only, key gets normalized
  before comparison. No fuzzy matching in V0.
- `memory_list(key_prefix?)` — browse keys with doc counts.
- `memory_create(key, key_type, doc_type, description, body, tags?, related_to?, folder?)`
- `memory_update(id, ...fields?, body?)`
- `memory_delete(id)` — hard delete, no undo.
- `memory_save_session(summary, key?, description?, tags?)` — saves a
  **summary** of the current chat (not a raw transcript) as a
  `doc_type: "session-summary"` doc. If `key` or `description` are
  omitted, ask the user rather than guessing — call this tool again once
  you have both.

## relocate

Moves an existing local markdown file (anywhere readable on disk) into
the skill or memory source directory, converting it into a properly
frontmattered doc.

```
relocate(path, target: "skill" | "memory", keep_original?, overrides?)
```

- Default is **move** — the original file is deleted after a successful
  write. Pass `keep_original: true` to copy instead.
- For `target: "memory"`, it tries to infer `key`/`doc_type`/`description`
  from the filename, following the convention
  `YYYY-MM-DD-<ticket>-<slug>.md` under a `plans/`/`specs/` parent folder
  (e.g. `2026-08-12-pde-433-partner-configuration-management-v3.md` →
  key `PDE-433`, doc_type `plan`, description "partner configuration
  management v3"). `doc_type` also falls back on the file extension
  (`.sql` → `sql`).
- **On a weak/ambiguous match it does nothing** — no guess, no partial
  move. Ask the user for an explicit key/description and retry with
  `overrides.key` / `overrides.description`.
- For `target: "skill"`, `name` can usually be inferred from the filename,
  but `overrides.description` is always required — a real description
  needs content a filename can't provide (what it does + when to use it),
  so ask the user rather than inventing one.
- `overrides.folder` places the relocated file into a subdirectory of the
  target source dir, same as `skill_create`/`memory_create`.
- Bulk usage ("relocate all files under docs/plans as memory if not
  already relocated") is supported by calling `relocate` once per file —
  it's safe to re-run: if a doc with the same inferred key + doc_type +
  description already exists, it reports `moved: false` with a reason
  instead of duplicating.

## Browser UI

`bucket_open_ui` (no args) returns the URL of a read-only web viewer for
browsing what's in the index — fulltext search, tag/status/owner filters,
a result list, and a detail panel showing the raw body and source path.
It's for a human reviewing the index, not for agent use beyond fetching
the URL; it has no write endpoints, so all creation/edits still go through
the tools above.

## Source layout

Both namespaces support nested subdirectories — a skill discovered at
`skills/frontend/lit-dropdown/SKILL.md` works exactly like one at
`skills/lit-dropdown/SKILL.md`; lookups are always by `name`/`key`, never
by path. (Skills are one folder per skill; memory docs are still flat
`.md` files, nested or not.) Configure source directories via
`memory-bucket.config.json` in the working directory (`skill_sources`,
`memory_sources` — see `config.ts`); defaults are `./skills` and
`./docs/{plans,specs}`.

## What's not here yet

No squad/company overlay resolution (`extends` is captured but inert), no
ratings/pins, no bundles, no push-based discovery. See
`skill-bucket-v0-plan.md` at the workspace root for the full V0 plan and
deferred fast-follow roadmap.
