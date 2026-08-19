---
id: >-
  mcp-memory-bucket-date-and-text-search-ideas-design-discussion-notes-date-extraction-indexing-feature-for-search-by-date-plus-a-follow-up-to-consider-replacing-augmenting-fts5-with-lucene-for-text-search-81de3e02
key: MCP-MEMORY-BUCKET-DATE-AND-TEXT-SEARCH-IDEAS
key_type: freeform
description: >-
  Design discussion notes: date extraction/indexing feature for search_by_date,
  plus a follow-up to consider replacing/augmenting FTS5 with Lucene for text
  search
doc_type: discovery
tags:
  - mcp-memory-bucket
  - search
  - dates
  - lucene
  - follow-up
status: active
related_to: null
deprecated: false
created_at: '2026-08-19T01:17:20.792Z'
body: >-
  ## Context


  Current schema (packages/mcp-memory-bucket): `memory_docs`/`skills` tables
  plus a shared FTS5 `search_index` (porter unicode61, bm25-ranked, snippet()
  highlighted). `created_at` already exists (auto-stamped ISO string) but there
  is no index of dates *mentioned in body text*, and no date-range filtering on
  `memory_search`/`memory_list`.


  ## Feature 1: search_by_date (discussed, not yet built)


  Goal: agent-facing tool to retrieve memories whose body mentions a date within
  a range — e.g. "this week I worked on the UI..." → agent computes the week's
  start/end, calls `search_by_date(start, end)`.


  Decisions from discussion:

  - Two separate concepts: `created_at` (doc write time, existing) vs. dates
  found in body text (new) — don't conflate.

  - Orthogonal to `doc_type` — not scoped to session-summary docs only.

  - Multi-date docs: index every date found, ANY-match semantics (doc matches if
  any extracted date falls in the query range).

  - `search_by_date(start, end)` takes a strict ISO range only — no
  natural-language parsing inside the tool. The agent resolves "this week"/"last
  month" itself before calling.

  - Conservative extraction preferred: better to miss an ambiguous date than
  mis-tag one. Bare `NN/NN/NNNN` slash-dates are the main ambiguity risk (MM/DD
  vs DD/MM, no locale signal) — consider excluding those entirely and keeping
  just ISO (`YYYY-MM-DD`) + written-month (`Jan 20, 2003`) formats.

  - Should skip date-like text inside fenced code blocks to avoid noise (version
  strings, ports, etc. false-triggering as dates).

  - Result shape should match `memory_search`'s convention: return a highlighted
  snippet showing which date matched and where, not just doc IDs — confirmed by
  user, mirrors existing snippet() usage.

  - Parser choice undecided: chrono-node handles all 3 example formats but is
  aggressive about fuzzy/relative parsing by default (would need tuning down to
  match the "low false-positive tolerance" preference), vs. hand-rolled regex
  for just the target formats.

  - Implementation sketch: new side table `memory_doc_dates(doc_id, date)`
  indexed on `date`, populated on create/update/bulk_create/bulk_update, queried
  via range scan.

  - Confirmed as a real thing to scope/build (not just a gut-check) — risks
  above should be flagged before implementation starts.


  ## Feature 2: web UI date-range filter (discussed, depends on Feature 1)


  User initially avoided adding a date filter to the search UI to not make the
  search bar cramped, then reconsidered: a compact two-field `<input
  type="date">` range control (start/end) is low visual cost and could sit
  inline in the existing search row.


  - Confirmed scope: filters on **extracted body dates** (Feature 1's index),
  NOT `created_at`. So this UI work is downstream of / blocked on Feature 1's
  extraction+indexing existing — not an independent quick win.

  - Current search bar layout (for implementation reference):
  `mem-bucket-app.ts` renders search entirely inline (no separate search-bar
  component) — `.filters` (flex column) containing `.row.search-row` (flex row,
  gap 8px, wrap), with `.search-field` (flex:1 1 240px), type-toggle buttons,
  `<tag-multiselect>` (lines ~520-528), sort `<select>`, and a "hide deprecated"
  checkbox as flex-wrap siblings. A new date-range control would slot in as
  another sibling in that row, likely between tag-multiselect and Sort.

  - Client state: `mem-bucket-app.ts` tracks `#query`, `#typeFilter`,
  `#activeTags`, `#activeRoots`, `#sort`, `#hideDeprecated` as signals;
  `#requestQuery` (computed, ~lines 263-272) builds URLSearchParams sent to `GET
  /api/entries`.

  - Server route: `src/web/routes.ts` `queryEntries()` (~lines 41-80) already
  parses several array filters (`tag[]`, `status[]`, `owner[]`, `doc_type[]`,
  `key_type[]`, `root[]`) plus free-text `q` (resolved via `matchSearch()`, line
  ~205) — no date-range param exists yet. Once Feature 1's
  `memory_doc_dates(doc_id, date)` side table exists, this route would need a
  `date_from`/`date_to` param added to the filter object (~lines 91-132) and a
  WHERE/JOIN against that table (not against `created_at`/`mtime_ms`).


  ## Unrelated confirmation from same discussion

  Checked whether `skill_search` returns a snippet like `memory_search` does —
  confirmed yes, both already call FTS5 `snippet()` and return highlighted
  excerpts (packages/mcp-memory-bucket/src/skills/repository.ts and
  src/memory/repository.ts, same pattern). No gap, no action needed.


  ## Follow-up to raise later: Lucene for text search


  User flagged, mid-discussion, that a Lucene-style index might be worth
  considering for text search generally (not date-specific) — as a possible
  alternative/complement to the current SQLite FTS5 setup. Explicitly deferred
  as a separate discussion, not decided or scoped. Worth revisiting: what would
  Lucene actually buy over FTS5 here (better ranking, more query syntax,
  cross-language stemming?) given this is a local/embedded single-process
  SQLite-backed tool — Lucene (or something like Tantivy) would be a heavier
  dependency and likely needs a real justification (multi-field scoring,
  faceting, fuzzy/phonetic search) beyond what bm25()+FTS5 already covers.
---
## Context

Current schema (packages/mcp-memory-bucket): `memory_docs`/`skills` tables plus a shared FTS5 `search_index` (porter unicode61, bm25-ranked, snippet() highlighted). `created_at` already exists (auto-stamped ISO string). This doc originally treated body-extracted dates and `created_at` as separate concepts — **that decision was reversed after implementation** (see "Post-implementation change" below); `search_by_date` now indexes both.

## Feature 1: search_by_date — IMPLEMENTED

Goal: agent-facing tool to retrieve memories whose body mentions a date within a range — e.g. "this week I worked on the UI..." → agent computes the week's start/end, calls `search_by_date(start, end)`.

Final decisions (as implemented):
- Applies to **both skills and memory docs** — orthogonal to `doc_type`.
- Indexes **body-extracted dates AND `created_at`** in the same `doc_dates(ref_table, ref_id, date)` side table — ANY-match, no priority between them; `matched_date` is whichever is earliest. (Originally scoped as "two separate concepts, don't conflate" — reversed post-implementation, see below.)
- `search_by_date(start, end, table?, limit?, offset?)` — strict ISO range only, no NL parsing server-side. One combined tool (mirrors `bucket_search`'s cross-table pattern), not split per bucket.
- Multi-date docs: index every date found, ANY-match semantics.
- Conservative extraction: only ISO (`YYYY-MM-DD`) and written-month-**with-year** (`Jan 20, 2003`) formats are extracted from body text. No slash-dates (`01/22/2022`) — ambiguous MM/DD vs DD/MM, excluded entirely. Written-month **without** a year (`Jan 20`) is also skipped — no `created_at`-year fallback, too ambiguous.
- Fenced code blocks are stripped before extraction (avoids version strings/comments false-triggering).
- Snippet: `<<date>>`-marked excerpt (20 words context each side) around the matched date's literal position in body; when the match came from `created_at` (no literal occurrence in body), snippet falls back to `<<date>> (matched via created_at, not mentioned in body)`.
- No date-parsing library used — hand-rolled regex in `src/store/date-extract.ts`, kept pure/dependency-free for easy unit testing.

### Post-implementation change (2026-08-19): created_at folded in

After the tool shipped, decided `created_at` should be indexed alongside body-extracted dates rather than kept separate — a doc with no dates mentioned in its body but a relevant `created_at` should still be findable by period. Implementation: `upsertFile()` in `src/store/sync.ts` now adds `row.created_at` (truncated to `YYYY-MM-DD`) into the same date set before writing to `doc_dates`, deduped via a `Set`. No new column/table — same `doc_dates` schema, just an extra source of rows per doc. `search_by_date`'s tool description and the `memory-bucket-authoring` SKILL.md were updated to describe both sources.

### Files touched
- `src/store/date-extract.ts` (new) — `extractDates(body): string[]`
- `src/store/db.ts` — new `doc_dates` table + 2 indexes
- `src/store/sync.ts` — `upsertFile`/`removeFile` populate/clean `doc_dates`, now including `created_at`
- `src/store/search.ts` — `searchByDate()` + `buildDateSnippet()`
- `src/shared/search-tool.ts` — `search_by_date` MCP tool registration
- `src/skills/builtin/memory-bucket-authoring/SKILL.md` — documents the new tool
- `test/date-extract.test.ts` (new, 8 unit tests) + `test/repository.test.ts` (+3 integration tests: body-match, created_at-only match, delete cleanup)

All 32 tests pass; server-side typecheck clean (a pre-existing unrelated client-side typecheck error in `mem-bucket-app.ts` predates this work).

## Feature 2: web UI date-range filter — NOT YET BUILT

User reconsidered an earlier "don't clutter the search bar" stance: a compact two-field `<input type="date">` range control (start/end) is low visual cost and could sit inline in the existing search row.

- Confirmed scope: filters on the same `doc_dates` index `search_by_date` now uses (body-extracted dates + `created_at`, combined) — this UI work can now proceed since the index exists (previously blocked on it).
- Current search bar layout (for implementation reference): `mem-bucket-app.ts` renders search entirely inline (no separate search-bar component) — `.filters` (flex column) containing `.row.search-row` (flex row, gap 8px, wrap), with `.search-field` (flex:1 1 240px), type-toggle buttons, `<tag-multiselect>` (lines ~520-528), sort `<select>`, and a "hide deprecated" checkbox as flex-wrap siblings. A new date-range control would slot in as another sibling in that row, likely between tag-multiselect and Sort.
- Client state: `mem-bucket-app.ts` tracks `#query`, `#typeFilter`, `#activeTags`, `#activeRoots`, `#sort`, `#hideDeprecated` as signals; `#requestQuery` (computed, ~lines 263-272) builds URLSearchParams sent to `GET /api/entries`.
- Server route: `src/web/routes.ts` `queryEntries()` (~lines 41-80) already parses several array filters (`tag[]`, `status[]`, `owner[]`, `doc_type[]`, `key_type[]`, `root[]`) plus free-text `q` — no date-range param exists yet. Would need a `date_from`/`date_to` param added to the filter object (~lines 91-132) plus a JOIN/WHERE against `doc_dates`.

## Unrelated confirmation from same discussion
Checked whether `skill_search` returns a snippet like `memory_search` does — confirmed yes, both already call FTS5 `snippet()` and return highlighted excerpts. No gap, no action needed.

## Follow-up to raise later: Lucene for text search

User flagged, mid-discussion, that a Lucene-style index might be worth considering for text search generally (not date-specific) — as a possible alternative/complement to the current SQLite FTS5 setup. Explicitly deferred as a separate discussion, not decided or scoped. Worth revisiting: what would Lucene actually buy over FTS5 here (better ranking, more query syntax, cross-language stemming?) given this is a local/embedded single-process SQLite-backed tool — Lucene (or something like Tantivy) would be a heavier dependency and likely needs a real justification (multi-field scoring, faceting, fuzzy/phonetic search) beyond what bm25()+FTS5 already covers.

