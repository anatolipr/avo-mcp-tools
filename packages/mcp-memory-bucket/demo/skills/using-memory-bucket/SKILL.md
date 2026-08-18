---
name: using-memory-bucket
description: >-
  Explains how to use the memory-bucket MCP server day-to-day: finding and
  reading existing skills (skill_list/skill_get), pulling point-in-time context
  by key (memory_list/memory_get), browsing everything in the web UI
  (bucket_open_ui), and how multi-root setups affect lookups. Use whenever a
  memory-bucket/mem-bucket/skill-bucket MCP server is connected and you need to
  discover or consume existing skills or memory docs — for creating or editing
  content instead, see memory-bucket-authoring.
tags:
  - memory-bucket
  - meta
  - usage
  - discovery
trigger_phrases:
  - memory bucket
  - mem bucket
  - skill bucket
metadata:
  owner: personal
  status: stable
  extends: null
body: >-
  ## What this server gives you


  Two tool families, backed by markdown+frontmatter files:


  - **`skill_*`** — reusable, evergreen patterns (conventions, components,
  idioms). Found by keyword search.

  - **`memory_*`** — point-in-time context (plans, specs, SQL, session
  summaries) attached to a key, usually a ticket ID or a free-form name. Found
  by exact key lookup, not search.


  For how to *create or edit* either kind, see `memory-bucket-authoring` — this
  skill only covers finding and reading what's already there.


  ## Finding a skill


  1. `skill_list(query?, root?)` — no query returns everything; a query
  keyword-matches against `description`, `tags`, and `trigger_phrases`. Scan the
  returned `description` fields yourself to judge relevance — don't assume the
  first hit is right.

  2. `skill_get(name)` — loads the full `SKILL.md` body for one skill by its
  `name`. Only do this once you've picked a specific skill from `skill_list`;
  don't `skill_get` speculatively across many candidates.


  If two skills' descriptions look similar, prefer the more specific one (e.g. a
  skill scoped to "Lit dropdowns" over a general "frontend components" one)
  rather than guessing from the name alone.


  ## Finding memory


  1. `memory_get(key, doc_type?)` — the primary lookup. `key` is exact
  (normalized to uppercase-hyphenated on write), not a search term — get it from
  what the user actually said, never inferred from the current branch name or
  directory. Ask if it's unclear.

  2. `memory_list(...)` — use when you don't have an exact key, e.g. to browse
  what keys exist.

  3. A single key can have multiple docs of different `doc_type` (plan, spec,
  sql, testing-todo, discovery, session-summary, other) accumulated over time.
  Narrow with `doc_type` if you only want one kind; omit it to get the full
  history for that key.


  ## Browsing visually


  `bucket_open_ui()` returns a URL to a local, read-only web viewer —
  search/filter skills and memory docs by tag, status, owner, or fulltext. Good
  for a first orientation pass ("what's in here?") before reaching for the tools
  above. It can't edit anything; that always goes through
  `skill_*`/`memory_*`/`relocate`.


  ## Multiple roots


  A server can have more than one skill root and/or memory root configured at
  once (e.g. a personal folder plus a shared company repo). When more than one
  root of a kind exists:


  - `skill_list`/`memory_list` accept an optional `root` filter to narrow to
  one.

  - Results from `skill_list`/`memory_list` include which `root` each item came
  from — check it if the same name could plausibly exist in more than one place.


  Roots themselves are added/removed only through the web UI (`bucket_open_ui`),
  not through any tool call.
owner: personal
---
## What this server gives you

Two tool families, backed by markdown+frontmatter files:

- **`skill_*`** — reusable, evergreen patterns (conventions, components, idioms). Found by keyword search.
- **`memory_*`** — point-in-time context (plans, specs, SQL, session summaries) attached to a key, usually a ticket ID or a free-form name. Found by exact key lookup, not search.

For how to *create or edit* either kind, see `memory-bucket-authoring` — this skill only covers finding and reading what's already there.

## Finding a skill

1. `skill_list(query?, root?)` — no query returns everything; a query keyword-matches against `description`, `tags`, and `trigger_phrases`. Scan the returned `description` fields yourself to judge relevance — don't assume the first hit is right.
2. `skill_get(name)` — loads the full `SKILL.md` body for one skill by its `name`. Only do this once you've picked a specific skill from `skill_list`; don't `skill_get` speculatively across many candidates.

If two skills' descriptions look similar, prefer the more specific one (e.g. a skill scoped to "Lit dropdowns" over a general "frontend components" one) rather than guessing from the name alone.

## Finding memory

1. `memory_get(key, doc_type?)` — the primary lookup. `key` is exact (normalized to uppercase-hyphenated on write), not a search term — get it from what the user actually said, never inferred from the current branch name or directory. Ask if it's unclear.
2. `memory_list(...)` — use when you don't have an exact key, e.g. to browse what keys exist.
3. A single key can have multiple docs of different `doc_type` (plan, spec, sql, testing-todo, discovery, session-summary, other) accumulated over time. Narrow with `doc_type` if you only want one kind; omit it to get the full history for that key.

## Browsing visually

`bucket_open_ui()` returns a URL to a local, read-only web viewer — search/filter skills and memory docs by tag, status, owner, or fulltext. Good for a first orientation pass ("what's in here?") before reaching for the tools above. It can't edit anything; that always goes through `skill_*`/`memory_*`/`relocate`.

## Multiple roots

A server can have more than one skill root and/or memory root configured at once (e.g. a personal folder plus a shared company repo). When more than one root of a kind exists:

- `skill_list`/`memory_list` accept an optional `root` filter to narrow to one.
- Results from `skill_list`/`memory_list` include which `root` each item came from — check it if the same name could plausibly exist in more than one place.

Roots themselves are added/removed only through the web UI (`bucket_open_ui`), not through any tool call.
