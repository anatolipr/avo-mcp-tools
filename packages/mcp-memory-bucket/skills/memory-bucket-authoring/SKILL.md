---
name: "memory-bucket-authoring"
description: "Explains how to author and use skills and memory docs through the memory-bucket MCP server's skill_*/memory_*/relocate tools — the skill.md frontmatter schema (agentskills.io standard), the memory frontmatter schema, and when to use each. Use whenever a memory-bucket MCP server is connected and you need to create, update, or decide between a skill and a memory doc, or when the user asks to save a plan/spec/session summary or to record a reusable pattern."
tags: ["memory-bucket", "meta", "authoring"]
trigger_phrases: ["save this as a skill", "save this to memory", "remember this plan", "create a skill", "memory-bucket"]
metadata:
  owner: "company"
  status: "stable"
---

## Two namespaces, two different jobs

If a `memory-bucket` MCP server is connected, it exposes two tool
families backed by markdown+frontmatter files:

- **`skill_*`** — reusable, evergreen coding patterns. Found by keyword
  search. Use for: a convention, a component pattern, an idiom you'd want
  to reuse across many unrelated pieces of work.
- **`memory_*`** — point-in-time working context (plans, specs, SQL,
  testing notes, session summaries) attached to a key (usually a ticket
  ID, sometimes a free-form name like "Spot Chart Design"). Found by
  exact key lookup, not search. Use for: anything tied to one specific
  piece of work that won't be relevant once that work ships.

If you're unsure which one applies: would this be useful on a totally
different ticket next month with no connection to today's task? Skill.
Is it specific to what's happening right now? Memory.

## Authoring a skill

A skill is a **folder** containing a `SKILL.md` file, per the
[agentskills.io](https://agentskills.io) open standard — the same format
Claude Code, Cursor, and other agents read directly off disk, independent
of this MCP server. `skill_create` writes exactly this shape for you; you
don't need to construct the file yourself.

Required frontmatter:

```yaml
---
name: "lit-dropdown-component"   # 1-64 chars, lowercase letters/numbers/hyphens only,
                                   # no leading/trailing/consecutive hyphens.
                                   # This becomes the containing folder's name.
description: "Builds a dropdown component in Lit with keyboard navigation and ARIA roles. Use when the user asks for a dropdown, select, or combobox component in a Lit-based frontend."
---
```

**`description` is the single most important field.** It's the only
thing loaded into context at discovery time (along with `name`) — an
agent scans it to decide whether the skill is relevant *before* ever
reading the body. Write it to cover both what the skill does and when to
use it, in the same sentence or two. "Helps with dropdowns" is too vague
to trigger reliably; "Builds a dropdown component in Lit with keyboard
navigation... use when the user asks for a dropdown, select, or combobox
component" gives an agent something to pattern-match against.

Optional frontmatter this project also supports:

- `license`, `compatibility` — standard fields, rarely needed.
- `tags`, `trigger_phrases` — arrays of extra keywords `skill_list`'s
  keyword search matches against, beyond `description` itself.
- `owner`, `status` (`stable`/`beta`/`unreviewed`), `extends` — stored
  under `metadata` in the frontmatter (a string-keyed map the standard
  reserves for exactly this kind of client-specific extension). `status`
  defaults to `unreviewed` if omitted, so low-trust content doesn't read
  as equivalent to a reviewed pattern.

Call `skill_create(name, description, body, ...)`. Pass `folder` to place
it under a subdirectory (e.g. `folder: "frontend"`) if the skill source
tree is organized that way — check `skill_list()` or ask the user if
you're not sure of the convention in this repo.

Keep the `SKILL.md` body itself under ~500 lines; it's loaded in full
once the skill is activated, so move anything long (detailed reference
tables, big code samples) into files the body links to, if the host
environment supports bundling extra files alongside `SKILL.md`.

## Authoring a memory doc

Every memory doc needs a `key` (the lookup handle) and a `description`
(what distinguishes it from other docs sharing that key):

```yaml
---
key: "RMXS-14"                # normalized on write: uppercase, hyphenated
key_type: "ticket"            # "ticket" for a real ticket ID, "freeform" for names like "Spot Chart Design"
doc_type: "plan"              # plan | spec | sql | testing-todo | discovery | session-summary | other
description: "Bulk edit plan for product boost"
---
```

Call `memory_create(key, key_type, doc_type, description, body, ...)`.
One key commonly accumulates several docs over time — a plan, then a
spec, then SQL from a debugging session, then a session summary — all
retrievable together via `memory_get(key)`, or narrowed with
`memory_get(key, doc_type)`.

**Never infer the key from environment state** (branch name, current
directory, etc.) — always get it from what the user actually said in
conversation, or ask if it's genuinely unclear.

### Saving a session

If the user asks to save the current conversation/session as memory, use
`memory_save_session(summary, key, description, tags?)` — pass a
**summary**, not a raw transcript. If `key` or `description` weren't
given, ask for both before calling it; don't guess a key from context.

## relocate: pulling in an existing file

If there's already a local markdown file that should become a skill or
memory doc — the user says something like "save this file as memory" or
"turn this into a skill" — use `relocate(path, target, overrides?)`
instead of reading the file yourself and calling `*_create`. It infers
what it can from the filename and moves (not copies, by default) the
file into place.

- For `target: "memory"`, it tries to infer `key`/`doc_type`/`description`
  from filenames like `2026-08-12-pde-433-partner-configuration-v3.md`
  (date + ticket + slug), and does **nothing** — no partial move, no
  guess — if the filename doesn't clearly match. If that happens, ask the
  user for the key and description, then retry with
  `overrides.key`/`overrides.description`.
- For `target: "skill"`, the name can usually be inferred from the
  filename, but `overrides.description` is required — a good description
  needs real content a filename can't provide, so don't try to invent one
  yourself either; ask the user what the skill does and when to use it.
- Safe to re-run on the same file/target: if a matching doc already
  exists, it reports that instead of duplicating.
