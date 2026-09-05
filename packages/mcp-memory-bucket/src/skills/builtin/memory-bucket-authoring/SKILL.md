---
name: memory-bucket-authoring
description: >-
  Explains how to author and use skills and memory docs through the
  memory-bucket MCP server's skill_*/memory_*/relocate tools — the skill.md
  frontmatter schema (agentskills.io standard), the memory frontmatter schema,
  and when to use each. Use whenever a memory-bucket MCP server is connected and
  you need to create, update, or decide between a skill and a memory doc, or
  when the user asks to save a plan/spec/session summary or to record a reusable
  pattern.
tags:
  - memory-bucket
  - meta
  - authoring
trigger_phrases:
  - save this as a skill
  - save this to memory
  - remember this plan
  - create a skill
  - memory-bucket
metadata:
  owner: company
  status: stable
  extends: null
deprecated: false
created_at: '2026-08-29T21:51:13.402Z'
body: >-
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

  name: "lit-dropdown-component"   # 1-64 chars, lowercase
  letters/numbers/hyphens only,
                                     # no leading/trailing/consecutive hyphens.
                                     # This becomes the containing folder's name.
  description: "Builds a dropdown component in Lit with keyboard navigation and
  ARIA roles. Use when the user asks for a dropdown, select, or combobox
  component in a Lit-based frontend."

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


  **Always write the description in third person** — "Processes X" or

  "Builds Y", never "I can help you..." or "You can use this to...". It's

  injected into the system prompt alongside every other skill's

  description, and an inconsistent point of view degrades discovery.


  **Naming**: prefer gerund form (`processing-pdfs`, `writing-tests`) or a

  plain noun phrase (`pdf-processing`, `lit-dropdown-component`) — both are

  fine, pick whichever reads more naturally for the pattern. Avoid vague or

  generic names a skill list can't be scanned by: `helper`, `utils`,

  `tools`, `data`, `files`.


  Optional frontmatter this project also supports:


  - `license`, `compatibility` — standard fields, rarely needed.

  - `tags`, `trigger_phrases` — arrays of extra keywords `skill_list`'s
    keyword search matches against, beyond `description` itself.
  - `owner`, `status` (`stable`/`beta`/`unreviewed`), `extends`, `group` —
    stored under `metadata` in the frontmatter (a string-keyed map the
    standard reserves for exactly this kind of client-specific extension).
    `status` defaults to `unreviewed` if omitted, so low-trust content
    doesn't read as equivalent to a reviewed pattern.

  ### group vs. tags vs. folder


  Three different axes of organization exist for a skill, easy to
  conflate:


  - **`folder`** — WHERE the skill physically lives on disk (which
    configured skill source it's under). About storage location, not
    categorization.
  - **`tags`** — cross-cutting labels. A skill can carry several; they're
    for keyword search (`skill_list`/`skill_search`), not for picking a
    primary category.
  - **`group`** (`metadata.group`) — the skill's single primary category,
    e.g. `"frontend"` or `"deployment"`. Unlike tags, a skill has at most
    one group — use it for a coarse, single-value cluster (the web UI
    clusters skills by group, the way it already clusters memory docs by
    `key`); reach for tags instead when a skill genuinely spans several
    categories.

  `skill_rename_group(old_group, new_group)` renames a group across every

  skill currently in it in one call — for fixing a typo or merging two

  group names without hand-editing each skill.


  Call `skill_create(name, description, body, ...)`. Pass `folder` to place

  it under a subdirectory (e.g. `folder: "frontend"`) if the skill source

  tree is organized that way — check `skill_list()` or ask the user if

  you're not sure of the convention in this repo.


  ### Writing the body


  The agent reading a skill is already capable — don't explain things it

  already knows (what a PDF is, how a for-loop works). Before adding a

  sentence, ask "does this justify its token cost?" A concise 3-line code

  snippet beats a paragraph of preamble around it.


  Match how prescriptive you are to how fragile the task is:


  - **High freedom** (numbered steps, heuristics) — when multiple valid
    approaches exist and judgment matters, e.g. "review this code for
    bugs."
  - **Medium freedom** (a template or parameterized snippet) — when a
    preferred pattern exists but some variation is fine.
  - **Low freedom** (an exact command, "do not modify this") — when the
    operation is fragile or must run in an exact sequence, e.g. a
    migration script.

  Other things that reliably improve a skill:


  - Use one term for one concept throughout (always "field", never a mix
    of "field"/"box"/"control") — inconsistent vocabulary makes the
    instructions harder to follow.
  - Avoid time-sensitive claims ("before/after March 2026, use X") since
    they silently rot; if a pattern is genuinely deprecated, name the
    current approach first and fold the old one into a clearly-labeled
    "legacy" aside instead of a date-gated branch.
  - Don't enumerate every possible library/approach — give one good
    default plus, if truly needed, a named escape hatch for the exception
    case. "You can use pypdf, or pdfplumber, or PyMuPDF, or..." is worse
    than just picking one.
  - If the body instructs calling another MCP server's tool, use the fully
    qualified `ServerName:tool_name` form so it isn't ambiguous which
    server owns it.

  ### Keeping SKILL.md small (progressive disclosure)


  Keep the `SKILL.md` body itself under ~500 lines; it's loaded in full

  once the skill is activated, so move anything long (detailed reference

  tables, big code samples) into files the body links to, if the host

  environment supports bundling extra files alongside `SKILL.md`.


  When you do split content out:


  - **Link only one level deep from `SKILL.md` itself.** A reference file
    that links to another reference file risks a shallow partial read (the
    agent may `head` it instead of reading in full) and losing information.
    Put every reference file's link directly in `SKILL.md`, even if that
    means `SKILL.md` links to several files.
  - If a linked-out reference file runs past ~100 lines, put a short table
    of contents at its top so a partial read still reveals what's there.

  ## Authoring a memory doc


  Every memory doc needs a `key` (the lookup handle) and a `description`

  (what distinguishes it from other docs sharing that key):


  ```yaml

  ---

  key: "RMXS-14"                # normalized on write: uppercase, hyphenated

  key_type: "ticket"            # "ticket" for a real ticket ID, "freeform" for
  names like "Spot Chart Design"

  doc_type: "plan"              # plan | spec | sql | testing-todo | discovery |
  session-summary | other

  description: "Bulk edit plan for product boost"

  ---

  ```


  Call `memory_create(filename, key, key_type, doc_type, description, body,
  ...)`.

  `filename` is the doc's own on-disk identity — pick something descriptive,

  e.g. `"RMXS-14-Bulk-edit-plan.md"`; a doc-type suffix like `-PLAN`/`-SPEC`/

  `-SQL`/`-DISCOVERY`/`-SESSION-SUMMARY` helps once a key has several docs

  (`.md` is appended automatically if omitted, and a colliding filename is

  auto-suffixed, never silently overwritten). `key` is a separate grouping

  label, not the filename — one key commonly accumulates several docs over

  time — a plan, then a spec, then SQL from a debugging session, then a

  session summary — all retrievable together via `memory_get(key)`, or

  narrowed with `memory_get(key, doc_type)`.


  **Never infer the key from environment state** (branch name, current

  directory, etc.) — always get it from what the user actually said in

  conversation, or ask if it's genuinely unclear.


  Picked a bad filename? `memory_rename(folder?, filename, new_filename)`

  renames the file in place — frontmatter, body, and attachments untouched.


  ### Saving a session


  If the user asks to save the current conversation/session as memory, use

  `memory_save_session(summary, key, description, tags?)` — pass a

  **summary**, not a raw transcript. If `key` or `description` weren't

  given, ask for both before calling it; don't guess a key from context.


  ## Finding things: search vs. list vs. get


  - **`skill_list`/`memory_list`** — browse by metadata only (description,
    tags, trigger phrases for skills; key prefix for memory). Fast, but
    blind to body content.
  - **`skill_search`/`memory_search`/`bucket_search`** — full-text search
    over the actual markdown body (not just metadata), ranked by
    relevance, with a highlighted snippet per hit. `query` is raw SQLite
    FTS5 syntax: bare words AND by default, `"exact phrase"`, `prefix*`,
    explicit `AND`/`OR`/`NOT`. **Hyphenated or punctuated terms must be
    quoted** (`"blue-green"`, not `blue-green` — FTS5 treats a bare hyphen
    as an operator and will error). `skill_search`/`memory_search` also
    accept metadata filters (`status`, `owner`/`doc_type`, `tag`) combined
    with the text query. Use `bucket_search` instead of the two separate
    tools when you don't know (or don't care) which bucket something
    landed in. All three return snippets, not full bodies — follow up with
    `skill_get`/`memory_get` (or the bulk variants below) for the rest.
  - **`search_by_date(start, end)`** — finds skills and memory docs whose
    **body text mentions a date, or whose `created_at` falls,** within an
    inclusive ISO `YYYY-MM-DD` range, e.g. "what did I work on this week"
    once you've resolved "this week" into concrete start/end dates
    yourself (it does not parse natural language). Both a date written
    inside the content and the doc's `created_at` count as candidate
    matches — whichever is earliest wins, no priority between them. Like
    `bucket_search`, it covers both skills and memory docs at once (pass
    `table` to restrict to one). Returns a highlighted snippet around the
    matched date (or a note that it matched via `created_at`, when the
    date isn't literally in the body), not the full body. `created_at` is
    indexed as the server's local calendar date, so "today"/"this week"
    ranges built from local time just work — no timezone conversion needed.
  - **`skill_get`/`memory_get`** — exact-key lookup when you already know
    the name/key. `memory_get` also falls back to a filename-substring match
    when no key matches — handy for a bare ticket ref (e.g. "RMXS-13") that
    only appears in a doc's filename, not its key; the response flags this
    with `filename_fallback: true`.

  ## Bulk operations


  Most operations have a `_bulk_`/`bulk_` variant that takes a list and

  does each item independently, returning one per-item success/failure

  result rather than throwing on the first failure — so one bad name/id in

  a batch never blocks the rest. Prefer these over looping individual

  calls whenever acting on more than one item, e.g. after a search:


  - `skill_bulk_get`/`memory_bulk_get` — fetch full bodies for a list of
    names/ids in one call (memory's is by **id**, not key — search results
    return ids).
  - `skill_bulk_create`/`memory_bulk_create` — create several docs in one
    call, each entry shaped like the singular `*_create` args.
  - `skill_bulk_update`/`memory_bulk_update` — apply the same change
    (add/remove tags, flip status, etc.) across many docs at once, e.g. to
    a batch found via search.
  - `skill_bulk_delete`/`memory_bulk_delete` — delete several docs by
    name/id in one call.
  - `relocate_bulk` — same idea for `relocate`, one entry per file.


  ## Multiple folders


  A server can be configured with more than one skill folder and/or memory

  folder at once — e.g. a personal skills folder plus a shared company repo.

  When exactly one folder of a given kind is configured, everything above

  works unchanged: `skill_create`/`memory_create`/`relocate` write into it

  with no extra parameter needed.


  Once **two or more** folders of a kind are configured, `skill_create`,

  `memory_create`, `memory_save_session`, and `relocate`'s `overrides` gain

  a required (or, for `memory_save_session`, optional) `folder` parameter —

  its tool description lists the valid folder names. Match a folder by name

  from what the user said ("save this to my personal skills", "put this in

  the company repo") rather than guessing; if it's unclear which folder they

  mean, ask. `skill_list`/`memory_list` also gain an optional `folder` filter

  to narrow results to one folder once multiple exist.


  Folders (for both skills and memory) are managed through the web UI

  (`bucket_open_ui`) — add one via its "+ Add folder" folder browser, or

  remove one via the ✕ on its chip (this only unregisters it and drops its

  cached rows; it never deletes files on disk). If the server has zero

  folders configured, the UI opens straight into a first-run "add your first

  folder" screen instead of the normal search view.


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

**Always write the description in third person** — "Processes X" or
"Builds Y", never "I can help you..." or "You can use this to...". It's
injected into the system prompt alongside every other skill's
description, and an inconsistent point of view degrades discovery.

**Naming**: prefer gerund form (`processing-pdfs`, `writing-tests`) or a
plain noun phrase (`pdf-processing`, `lit-dropdown-component`) — both are
fine, pick whichever reads more naturally for the pattern. Avoid vague or
generic names a skill list can't be scanned by: `helper`, `utils`,
`tools`, `data`, `files`.

Optional frontmatter this project also supports:

- `license`, `compatibility` — standard fields, rarely needed.
- `tags`, `trigger_phrases` — arrays of extra keywords `skill_list`'s
  keyword search matches against, beyond `description` itself.
- `owner`, `status` (`stable`/`beta`/`unreviewed`), `extends`, `group` —
  stored under `metadata` in the frontmatter (a string-keyed map the
  standard reserves for exactly this kind of client-specific extension).
  `status` defaults to `unreviewed` if omitted, so low-trust content
  doesn't read as equivalent to a reviewed pattern.

### group vs. tags vs. folder

Three different axes of organization exist for a skill, easy to conflate:

- **`folder`** — WHERE the skill physically lives on disk (which
  configured skill source it's under). About storage location, not
  categorization.
- **`tags`** — cross-cutting labels. A skill can carry several; they're
  for keyword search (`skill_list`/`skill_search`), not for picking a
  primary category.
- **`group`** (`metadata.group`) — the skill's single primary category,
  e.g. `"frontend"` or `"deployment"`. Unlike tags, a skill has at most
  one group — use it for a coarse, single-value cluster (the web UI
  clusters skills by group, the way it already clusters memory docs by
  `key`); reach for tags instead when a skill genuinely spans several
  categories.

`skill_rename_group(old_group, new_group)` renames a group across every
skill currently in it in one call — for fixing a typo or merging two
group names without hand-editing each skill.

Call `skill_create(name, description, body, ...)`. Pass `folder` to place
it under a subdirectory (e.g. `folder: "frontend"`) if the skill source
tree is organized that way — check `skill_list()` or ask the user if
you're not sure of the convention in this repo.

### Writing the body

The agent reading a skill is already capable — don't explain things it
already knows (what a PDF is, how a for-loop works). Before adding a
sentence, ask "does this justify its token cost?" A concise 3-line code
snippet beats a paragraph of preamble around it.

Match how prescriptive you are to how fragile the task is:

- **High freedom** (numbered steps, heuristics) — when multiple valid
  approaches exist and judgment matters, e.g. "review this code for
  bugs."
- **Medium freedom** (a template or parameterized snippet) — when a
  preferred pattern exists but some variation is fine.
- **Low freedom** (an exact command, "do not modify this") — when the
  operation is fragile or must run in an exact sequence, e.g. a
  migration script.

Other things that reliably improve a skill:

- Use one term for one concept throughout (always "field", never a mix
  of "field"/"box"/"control") — inconsistent vocabulary makes the
  instructions harder to follow.
- Avoid time-sensitive claims ("before/after March 2026, use X") since
  they silently rot; if a pattern is genuinely deprecated, name the
  current approach first and fold the old one into a clearly-labeled
  "legacy" aside instead of a date-gated branch.
- Don't enumerate every possible library/approach — give one good
  default plus, if truly needed, a named escape hatch for the exception
  case. "You can use pypdf, or pdfplumber, or PyMuPDF, or..." is worse
  than just picking one.
- If the body instructs calling another MCP server's tool, use the fully
  qualified `ServerName:tool_name` form so it isn't ambiguous which
  server owns it.

### Keeping SKILL.md small (progressive disclosure)

Keep the `SKILL.md` body itself under ~500 lines; it's loaded in full
once the skill is activated, so move anything long (detailed reference
tables, big code samples) into files the body links to, if the host
environment supports bundling extra files alongside `SKILL.md`.

When you do split content out:

- **Link only one level deep from `SKILL.md` itself.** A reference file
  that links to another reference file risks a shallow partial read (the
  agent may `head` it instead of reading in full) and losing information.
  Put every reference file's link directly in `SKILL.md`, even if that
  means `SKILL.md` links to several files.
- If a linked-out reference file runs past ~100 lines, put a short table
  of contents at its top so a partial read still reveals what's there.

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

Call `memory_create(filename, key, key_type, doc_type, description, body, ...)`.
`filename` is the doc's own on-disk identity — pick something descriptive,
e.g. `"RMXS-14-Bulk-edit-plan.md"`; a doc-type suffix like `-PLAN`/`-SPEC`/
`-SQL`/`-DISCOVERY`/`-SESSION-SUMMARY` helps once a key has several docs
(`.md` is appended automatically if omitted, and a colliding filename is
auto-suffixed, never silently overwritten). `key` is a separate grouping
label, not the filename — one key commonly accumulates several docs over
time — a plan, then a spec, then SQL from a debugging session, then a
session summary — all retrievable together via `memory_get(key)`, or
narrowed with `memory_get(key, doc_type)`.

**Never infer the key from environment state** (branch name, current
directory, etc.) — always get it from what the user actually said in
conversation, or ask if it's genuinely unclear.

Picked a bad filename? `memory_rename(folder?, filename, new_filename)`
renames the file in place — frontmatter, body, and attachments untouched.

### Saving a session

If the user asks to save the current conversation/session as memory, use
`memory_save_session(summary, key, description, tags?)` — pass a
**summary**, not a raw transcript. If `key` or `description` weren't
given, ask for both before calling it; don't guess a key from context.

## Finding things: search vs. list vs. get

- **`skill_list`/`memory_list`** — browse by metadata only (description,
  tags, trigger phrases for skills; key prefix for memory). Fast, but
  blind to body content.
- **`skill_search`/`memory_search`/`bucket_search`** — full-text search
  over the actual markdown body (not just metadata), ranked by
  relevance, with a highlighted snippet per hit. `query` is raw SQLite
  FTS5 syntax: bare words AND by default, `"exact phrase"`, `prefix*`,
  explicit `AND`/`OR`/`NOT`. **Hyphenated or punctuated terms must be
  quoted** (`"blue-green"`, not `blue-green` — FTS5 treats a bare hyphen
  as an operator and will error). `skill_search`/`memory_search` also
  accept metadata filters (`status`, `owner`/`doc_type`, `tag`) combined
  with the text query. Use `bucket_search` instead of the two separate
  tools when you don't know (or don't care) which bucket something
  landed in. All three return snippets, not full bodies — follow up with
  `skill_get`/`memory_get` (or the bulk variants below) for the rest.
- **`search_by_date(start, end)`** — finds skills and memory docs whose
  **body text mentions a date, or whose `created_at` falls,** within an
  inclusive ISO `YYYY-MM-DD` range, e.g. "what did I work on this week"
  once you've resolved "this week" into concrete start/end dates
  yourself (it does not parse natural language). Both a date written
  inside the content and the doc's `created_at` count as candidate
  matches — whichever is earliest wins, no priority between them. Like
  `bucket_search`, it covers both skills and memory docs at once (pass
  `table` to restrict to one). Returns a highlighted snippet around the
  matched date (or a note that it matched via `created_at`, when the
  date isn't literally in the body), not the full body. `created_at` is
  indexed as the server's local calendar date, so "today"/"this week"
  ranges built from local time just work — no timezone conversion needed.
- **`skill_get`/`memory_get`** — exact-key lookup when you already know
  the name/key. `memory_get` also falls back to a filename-substring match
  when no key matches — handy for a bare ticket ref (e.g. "RMXS-13") that
  only appears in a doc's filename, not its key; the response flags this
  with `filename_fallback: true`.

## Bulk operations

Most operations have a `_bulk_`/`bulk_` variant that takes a list and
does each item independently, returning one per-item success/failure
result rather than throwing on the first failure — so one bad name/id in
a batch never blocks the rest. Prefer these over looping individual
calls whenever acting on more than one item, e.g. after a search:

- `skill_bulk_get`/`memory_bulk_get` — fetch full bodies for a list of
  names/ids in one call (memory's is by **id**, not key — search results
  return ids).
- `skill_bulk_create`/`memory_bulk_create` — create several docs in one
  call, each entry shaped like the singular `*_create` args.
- `skill_bulk_update`/`memory_bulk_update` — apply the same change
  (add/remove tags, flip status, etc.) across many docs at once, e.g. to
  a batch found via search.
- `skill_bulk_delete`/`memory_bulk_delete` — delete several docs by
  name/id in one call.
- `relocate_bulk` — same idea for `relocate`, one entry per file.

## Multiple folders

A server can be configured with more than one skill folder and/or memory
folder at once — e.g. a personal skills folder plus a shared company repo.
When exactly one folder of a given kind is configured, everything above
works unchanged: `skill_create`/`memory_create`/`relocate` write into it
with no extra parameter needed.

Once **two or more** folders of a kind are configured, `skill_create`,
`memory_create`, `memory_save_session`, and `relocate`'s `overrides` gain
a required (or, for `memory_save_session`, optional) `folder` parameter —
its tool description lists the valid folder names. Match a folder by name
from what the user said ("save this to my personal skills", "put this in
the company repo") rather than guessing; if it's unclear which folder they
mean, ask. `skill_list`/`memory_list` also gain an optional `folder` filter
to narrow results to one folder once multiple exist.

Folders (for both skills and memory) are managed through the web UI
(`bucket_open_ui`) — add one via its "+ Add folder" folder browser, or
remove one via the ✕ on its chip (this only unregisters it and drops its
cached rows; it never deletes files on disk). If the server has zero
folders configured, the UI opens straight into a first-run "add your first
folder" screen instead of the normal search view.

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
