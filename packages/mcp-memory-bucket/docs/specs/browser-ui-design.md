---
status: ready
owner: anatoli
---

# Browser UI design — mem-bucket viewer

A read-only web UI for browsing what's in the SQLite cache: skills and
memory docs, filterable by type/tag/status/owner, with fulltext search.
Explicitly *not* for agents — this is for a human reviewing the index.

## Goals / non-goals

- Goal: answer "what's in here?" fast — search, filter by tag, skim
  descriptions, open a doc's full body.
- Goal: surface index hygiene issues (dangling `related_to`/`extends`,
  skills with no `trigger_phrases`, stale `mtime_ms`).
- Non-goal: editing. All writes still go through the MCP tools (or the
  files directly) so `source_path` stays the source of truth and the
  watcher stays the single sync path. No POST/PUT/DELETE routes.
- Non-goal: auth. This runs on localhost for one developer, same trust
  level as the MCP server itself.

## Serving model

Add HTTP routes to the existing Express app in `src/server.ts`, mounted
next to `/mcp`. One process, one already-open `db` handle — no second
SQLite connection, no separate lifecycle to manage, no port to remember
beyond the one already printed at startup.

- `GET /` — the UI shell: Lit web components for structure, `avosignals`
  (`Signal`/`Computed`/`SignalWatcher`) for filter/search/selection state,
  per `lit-avosignals-mcp-page`. No `mcp-tenant-lib`/WebSocket layer —
  that pattern is for pages an MCP-connected agent can read *and write*
  live; this viewer is read-only and pulls its data over plain `fetch`
  against the REST routes below, so there's no server-push state to
  mirror into signals. Built with Vite, matching `mcp-form`'s scaffold:
  `lit`/`avosignals` as real npm deps, source under `src/client/`, a thin
  `public/index.html` shell, bundled to `dist/client/` and served via
  `express.static`. `npm start` rebuilds the client first (`prestart`);
  `npm run dev` runs `vite build --watch` alongside `tsx watch` for the
  server. The package's `tsconfig.json` splits into `tsconfig.server.json`
  (emits to `dist/`, excludes `src/client`, unchanged from before) and
  `tsconfig.client.json` (DOM lib, `noEmit`, Vite handles the actual
  bundling) — mirroring `mcp-form`'s `tsconfig.server.json`/
  `tsconfig.client.json` split.
- `GET /api/entries?type=&tag=&status=&owner=&q=&sort=` — JSON list,
  covers both tables (see query design below).
- `GET /api/entries/:table/:id` — single doc incl. `body`, for the detail
  view. `:table` disambiguates since skill ids and memory doc ids are
  different id spaces.
- `GET /api/facets?type=` — distinct tags/statuses/owners/doc_types/key_types
  for populating filter chips, computed from current table contents.
  Accepts the same `type` param as `/api/entries` so the tag list narrows
  to whichever type is currently selected (see Page layout).
- `GET /api/health` — dangling refs, empty-trigger-phrase skills, stale
  docs (see Hygiene below). Optional first cut; can ship after the main
  browser.

An MCP tool, `bucket_open_ui` (no args), returns the UI's URL as plain
text — so an agent can respond to "open the mem bucket UI" without the
user having to know or remember the port.

No new npm dependency needed for the page itself — Express already
serves static/JSON. If templating gets annoying, a single `<script>`
block with `fetch` + DOM string building is enough at this scale.

## Search: FTS5

Add an FTS5 virtual table synced alongside the existing `skills` /
`memory_docs` tables, populated from `upsertFile`/`removeFile` in
`store/sync.ts` (the single choke point both initial scan and the
watcher already go through — no new sync path to maintain).

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  ref_table UNINDEXED,   -- 'skills' | 'memory_docs'
  ref_id UNINDEXED,      -- id, for joining back
  description,
  body,
  tags,                  -- flattened JSON array, space-joined, for tag-term hits
  tokenize = 'porter unicode61'
);
```

- On `upsertFile`: after the existing upsert, `DELETE FROM search_index
  WHERE ref_table = ? AND ref_id = ?` then `INSERT`. Simpler than trying
  to UPDATE a contentless FTS row, and upserts are already infrequent
  (file-change-driven).
- On `removeFile`: same delete.
- Query: `SELECT ref_table, ref_id, rank FROM search_index WHERE
  search_index MATCH ? ORDER BY rank`, then join back to the real tables
  for the fields the UI needs. Keep the JS substring fallback available
  behind the scenes for now only if FTS query syntax errors (bad user
  input like a bare `"`) — otherwise just surface the syntax error, don't
  silently degrade.

This is the one actual schema migration in this design. Since `db.ts`
already uses `CREATE TABLE IF NOT EXISTS`, and FTS5 tables aren't easily
"backfilled" from existing rows automatically, initial rollout needs one
explicit backfill: iterate current `skills`/`memory_docs` rows once at
startup if `search_index` is empty but the source tables aren't.

## Query design (`/api/entries`)

Single endpoint over both tables rather than two separate list endpoints,
since the UI's primary filter is "type: skills / memories / both" and a
unified result list is what makes a combined table/feed possible.

Params:
- `type` — `skill` | `memory` | `all` (default `all`)
- `tag` — repeatable, ANDed (doc must have all selected tags)
- `status` — repeatable; note skills and memory docs have *different*
  status enums (`SkillStatus` vs `MemoryStatus`) — the UI should union
  them into one filter chip list but keep them visually distinguishable
  (e.g. "stable" vs "active" grouped under separate sub-headers, or just
  namespaced as `skill:stable` / `memory:active` chip values)
- `owner` — skills only (memory docs have no owner field); no-op filter
  on memory rows
- `doc_type` / `key_type` — memory docs only
- `q` — fulltext, routed through `search_index` when present, else plain
  listing
- `sort` — `mtime_desc` (default), `mtime_asc`, `name_asc`

Implementation: build the two table queries with shared WHERE-clause
logic (tag/status filtering is JSON-array-contains, same shape on both
tables), run separately, tag each row with `_table`, merge + sort in JS.
Not a SQL UNION — the column sets genuinely differ (owner vs key_type
etc.) and forcing a common shape early is exactly the kind of premature
abstraction to avoid; let the JS merge step normalize just the fields
the list view needs (name/id, description, tags, status, type, mtime).

Tag filtering without FTS: `tags` is stored as a JSON string column, no
index. At current scale (dozens–low hundreds of docs) `json_each` in a
`WHERE EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)` per
selected tag is plenty fast and avoids a second schema change. Revisit
only if doc count grows enough to matter.

## Page layout

Single page, three regions:

```
┌─────────────────────────────────────────────────────────┐
│  [ fulltext search............................ ]  🔍     │
│  Type: ( All ) ( Skills ) ( Memories )                   │
│  Tags: [tag1] [tag2] [tag3] ...        (click to toggle) │
│  Status: [stable] [beta] [active] ...  Owner: [dropdown] │
├───────────────────────────┬───────────────────────────────┤
│ Results list               │ Detail panel                 │
│ ─────────────────────────  │ (empty until a row selected)  │
│ ▸ skill-name  owner [tags] │  name / key                   │
│   description...    stable │  description                  │
│ ▸ MEM-123        —  [tags] │  tags · status · owner         │
│   description...    active │  raw body in <pre>             │
│ ...                        │  source_path (click to copy)   │
└───────────────────────────┴───────────────────────────────┘
```

- Tag filter bar: chips built from `/api/facets?type=<current type>`,
  active ones highlighted, click toggles (multi-select AND, per the query
  design above). Narrows to the selected type — picking "Skills" hides
  tags that only exist on memory docs, so the bar always reflects what's
  actually filterable right now. Alphabetical, not frequency-sorted —
  frequency sort would reshuffle the bar as filters change, which is
  disorienting for a filter you're scanning.
- List/detail split (not a modal) — keeps search+filter state visible
  while reading a doc, natural for repeated browsing.

  Component/state shape (Lit + avosignals): one root `<mem-bucket-app>`
  element holding the filter `Signal`s (`typeFilter`, `activeTags`,
  `statusFilter`, `ownerFilter`, `query`, `sort`) plus a `results`
  `Signal` populated by `fetch`. Sub-components (`<filter-bar>`,
  `<result-list>`, `<detail-panel>`) read those signals via
  `SignalWatcher` and re-render only on the signals they touch — e.g.
  toggling a tag chip updates `activeTags` and re-fetches `results`
  without the detail panel re-rendering. A `Computed` can derive the
  request query string from the filter signals so the `fetch` effect has
  one clear dependency set to watch.
- Body shown as raw text in a `<pre>` for v1 — simplest, matches the
  project's "no framework where it isn't earning its keep" grain.
  Revisit markdown rendering later if raw text feels flat in practice.
- Row shows: id/name, description (truncated), tag chips, status badge,
  type badge (skill vs memory — memory rows also show `key`). `owner`
  column is always present; memory-doc rows show `—` since they have no
  owner field, rather than the column disappearing when the type filter
  changes shape.
- No pagination needed at expected scale; a client-side virtualized list
  isn't worth it until doc count is in the thousands — plain scroll.

## Hygiene view (stretch, second pass)

Separate tab or section, backed by `/api/health`:
- Skills with `extends` pointing at a non-existent skill id.
- Memory docs with `related_to` pointing at a non-existent id.
- Skills with empty `trigger_phrases` (invisible to agent auto-discovery).
- Docs not touched (`mtime_ms`) in N days, grouped by status — e.g.
  `active` memory docs going stale is more actionable than `shipped` ones.

Worth having eventually but doesn't block the first version — ship
search/filter/browse first, add hygiene once the browser itself is in use
and it's clear which checks are actually useful versus which are noise.

## Decisions

- Detail panel body: raw text in `<pre>` for v1, not rendered markdown.
- Tag filter bar narrows to the currently selected type (`/api/facets`
  takes the same `type` param as `/api/entries`).
- `owner` column always shown in results; memory-doc rows display `—`.
