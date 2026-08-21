# Memory Bucket: Key-Based Search & Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `key` (e.g. `RMXS-15`) fully discoverable — searchable via FTS, resistant to accidental format-drift duplicates, and visually grouped in the web UI — without introducing any new grouping concept beyond the existing `key` field.

**Architecture:** `key` stays the sole grouping unit (no new frontmatter field). Four independent-but-related fixes land in `packages/mcp-memory-bucket`: (1) index `key`/`id` into the existing FTS5 `search_index` table, (2) auto-quote punctuated bareword query terms before they hit FTS5's `MATCH`, (3) a `MemoryRepository.suggestKeys()` fuzzy (punctuation-stripped) key-match primitive reused by both a create-time "did you mean" nudge and a web-UI autocomplete/short-circuit, and (4) client-side grouping of the result list by key. Doc fixes correct stale/wrong guidance (`AGENTS.md`'s `overrides.folder` typo, missing tags-vs-key convention in the authoring skill).

**Tech Stack:** TypeScript, `better-sqlite3` (FTS5), Express (web routes), Lit web components (client).

**Spec:** No separate spec file — design was settled via an in-chat grilling session (decisions D1–D8) summarized in Task 0 below; this plan implements that summary directly.

## Global Constraints

- **No commits.** Do not run `git add`/`git commit` at any point in this plan — leave all changes staged/unstaged in the working tree for the user to review and commit themselves.
- `key` is the only grouping concept — never add a new frontmatter field for grouping.
- Physical file layout stays fully flat — no subfolder changes in this plan.
- FTS5 column order in `search_index` must stay `ref_table, ref_id, description, body, tags` (existing `snippet(search_index, 3, ...)` calls hard-code index 3 = `body`) — any new column must be appended after `tags`.

---

## Task 0: Settled design summary (read-only, no code)

For context — no files touched in this task. The grilling session settled:

- **D1:** `key` is the one grouping concept; `tags` is for cross-cutting labels only (never a doc's own/related key).
- **D2:** Physical layout stays fully flat (out of scope for this plan; already the status quo).
- **D4:** Index `key`/`id` into FTS5; auto-quote/escape typed query terms.
- **D5:** Web UI list groups rows by `key` instead of one flat mtime-sorted list.
- **D6:** Punctuation-stripped fuzzy key match (`RMXS15` == `RMXS-15`), used both as a create-time nudge and a search-box autocomplete/short-circuit.
- **D7:** Authoring skill gets explicit "check existing keys before creating a ticket-type key" guidance.
- **D8:** Search box: exact/prefix key match short-circuits to "all docs for this key"; falls through to full-text search otherwise.

---

### Task 1: Index `key`/`id` into the FTS5 search index

**Files:**
- Modify: `packages/mcp-memory-bucket/src/store/db.ts`
- Modify: `packages/mcp-memory-bucket/src/store/sync.ts`
- Test: `packages/mcp-memory-bucket/test/repository.test.ts`

**Interfaces:**
- Produces: `search_index` FTS5 table gains a 6th column `key` (index 5, appended after `tags` — columns 0–4 unchanged). Populated with the memory doc's `key` for `memory_docs` rows, `''` for `skills` rows (skills have no `key`).

- [ ] **Step 1: Write the failing test**

Add to `packages/mcp-memory-bucket/test/repository.test.ts` (near the other memory tests):

```ts
test('memory doc key is searchable via FTS even when the key never appears in description/body', () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);

  repo.create({
    key: 'RMXS-15',
    key_type: 'ticket',
    doc_type: 'plan',
    description: 'campaign eligibility postbacks', // deliberately no "RMXS-15" in text
    body: 'Body text with no mention of the ticket id either.',
  });

  const hits = repo.search('"RMXS-15"'); // quoted: isolates the indexing fix from query-sanitization (Task 2)
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.key, 'RMXS-15');

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mcp-memory-bucket && npm test`
Expected: FAIL — 0 hits, because `key` isn't in `search_index` yet.

- [ ] **Step 3: Add the `key` column to the FTS5 schema, with a migration for existing cache files**

In `packages/mcp-memory-bucket/src/store/db.ts`, update the `CREATE VIRTUAL TABLE` and add a migration function:

```ts
    CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
      ref_table UNINDEXED,
      ref_id UNINDEXED,
      description,
      body,
      tags,
      key,
      tokenize = 'porter unicode61'
    );
```

(only the `key` column is new — it's appended last so existing `snippet(search_index, 3, ...)` calls elsewhere, which mean "column 3 = body", keep working unchanged.)

Add a migration step, called right before `backfillSearchIndex(db)` in `openCache()`:

```ts
/**
 * search_index is an FTS5 virtual table — existing cache files created before the `key` column
 * existed need it added. FTS5 doesn't support ALTER TABLE ADD COLUMN reliably across versions, and
 * search_index is a disposable cache (rebuilt from skills/memory_docs, not the source of truth), so
 * the simplest safe migration is: drop and recreate with the new schema, then let backfillSearchIndex
 * repopulate everything.
 */
function ensureSearchIndexHasKeyColumn(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(search_index)`).all() as Array<{ name: string }>;
  if (cols.length === 0 || cols.some((c) => c.name === 'key')) return; // fresh table, or already migrated
  db.exec(`DROP TABLE search_index`);
  db.exec(`
    CREATE VIRTUAL TABLE search_index USING fts5(
      ref_table UNINDEXED,
      ref_id UNINDEXED,
      description,
      body,
      tags,
      key,
      tokenize = 'porter unicode61'
    );
  `);
}
```

Call it in `openCache()`, right before the existing `backfillSearchIndex(db);` line:

```ts
  ensureSearchIndexHasKeyColumn(db);
  backfillSearchIndex(db);
```

- [ ] **Step 4: Update `backfillSearchIndex` to populate `key`**

In `packages/mcp-memory-bucket/src/store/db.ts`, update the memory rows query and insert:

```ts
  const memoryRows = db.prepare(`SELECT id, key, description, body, tags FROM memory_docs`).all() as Array<{
    id: string;
    key: string;
    description: string;
    body: string;
    tags: string;
  }>;
  if (skillRows.length === 0 && memoryRows.length === 0) return;

  const insert = db.prepare(
    `INSERT INTO search_index (ref_table, ref_id, description, body, tags, key) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertAll = db.transaction(() => {
    for (const row of skillRows) {
      insert.run('skills', row.id, row.description, row.body, flattenTags(row.tags), '');
    }
    for (const row of memoryRows) {
      insert.run('memory_docs', row.id, row.description, row.body, flattenTags(row.tags), row.key);
    }
  });
  insertAll();
```

- [ ] **Step 5: Update `upsertFile` (live indexing on create/edit) to populate `key`**

In `packages/mcp-memory-bucket/src/store/sync.ts`, in `upsertFile()`, update the `search_index` insert:

```ts
  db.prepare(`DELETE FROM search_index WHERE ref_table = ? AND ref_id = ?`).run(spec.table, id);
  db.prepare(
    `INSERT INTO search_index (ref_table, ref_id, description, body, tags, key) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(spec.table, id, String(row.description ?? ''), parsed.body, flattenTags(String(row.tags ?? '[]')), String(row.key ?? ''));
```

(`row.key` exists on memory rows via `memoryColumns` already including `'key'`; it's simply `undefined` on skill rows, which `String(row.key ?? '')` turns into `''`.)

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/mcp-memory-bucket && npm test`
Expected: PASS

---

### Task 2: Auto-quote punctuated query terms before FTS5 `MATCH`

**Files:**
- Modify: `packages/mcp-memory-bucket/src/store/search.ts`
- Modify: `packages/mcp-memory-bucket/src/memory/repository.ts`
- Modify: `packages/mcp-memory-bucket/src/skills/repository.ts`
- Modify: `packages/mcp-memory-bucket/src/web/routes.ts`
- Test: `packages/mcp-memory-bucket/test/repository.test.ts`

**Interfaces:**
- Consumes: nothing new from Task 1.
- Produces: `sanitizeFtsQuery(query: string): string`, exported from `store/search.ts` — used by every call site that passes a raw user-typed query into `search_index MATCH`.

- [ ] **Step 1: Write the failing test**

Add to `packages/mcp-memory-bucket/test/repository.test.ts`:

```ts
test('bare hyphenated key search does not silently return zero results', () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);

  repo.create({
    key: 'RMXS-15',
    key_type: 'ticket',
    doc_type: 'plan',
    description: 'campaign eligibility postbacks',
    body: 'Body text with no mention of the ticket id either.',
  });

  // Bare, unquoted, exactly what a user would type into the web UI search box.
  const hits = repo.search('RMXS-15');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.key, 'RMXS-15');

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mcp-memory-bucket && npm test`
Expected: FAIL — either 0 hits, or a thrown `SearchQueryError` (FTS5 treats the bare `-` as its NOT/column-filter operator).

- [ ] **Step 3: Add `sanitizeFtsQuery` to `store/search.ts`**

Add near the top of `packages/mcp-memory-bucket/src/store/search.ts`, after the `SearchQueryError` class:

```ts
const FTS_BOOLEAN_KEYWORDS = new Set(['AND', 'OR', 'NOT']);

/**
 * Auto-quotes bareword tokens that contain punctuation (e.g. a bare hyphenated ticket key like
 * `RMXS-15`) so FTS5 doesn't interpret a bare `-` as its NOT/column-filter operator and silently
 * return zero rows. Already-quoted phrases, `AND`/`OR`/`NOT` operators, and `prefix*` wildcards are
 * left untouched so existing power-user query syntax keeps working exactly as before.
 */
export function sanitizeFtsQuery(query: string): string {
  const tokens = query.match(/"[^"]*"|\S+/g) ?? [];
  return tokens
    .map((token) => {
      if (token.startsWith('"')) return token; // already an explicit phrase
      if (FTS_BOOLEAN_KEYWORDS.has(token.toUpperCase())) return token; // boolean operator
      if (/^[A-Za-z0-9_*]+$/.test(token)) return token; // plain word or prefix* wildcard — no punctuation
      return `"${token.replace(/"/g, '""')}"`; // punctuation present (hyphen, colon, etc.) — quote it literally
    })
    .join(' ');
}
```

- [ ] **Step 4: Wire `sanitizeFtsQuery` into `searchIndex()` and `searchCombined()` in `store/search.ts`**

```ts
export function searchIndex(
  db: Database.Database,
  query: string,
  opts: { table?: 'skills' | 'memory_docs'; limit?: number; offset?: number } = {}
): SearchHit[] {
  const { table, limit = 20, offset = 0 } = opts;
  const sanitized = sanitizeFtsQuery(query);
  try {
    const rows = db
      .prepare(
        `SELECT ref_table, ref_id,
                snippet(search_index, 3, '<<', '>>', '…', 20) AS snippet,
                -bm25(search_index) AS score
         FROM search_index
         WHERE search_index MATCH ? ${table ? 'AND ref_table = ?' : ''}
         ORDER BY bm25(search_index)
         LIMIT ? OFFSET ?`
      )
      .all(...(table ? [sanitized, table, limit, offset] : [sanitized, limit, offset])) as SearchHit[];
    return rows;
  } catch (err) {
    throw new SearchQueryError(query, err);
  }
}
```

```ts
export function searchCombined(db: Database.Database, query: string, limit = 20, offset = 0): CombinedSearchHit[] {
  const sanitized = sanitizeFtsQuery(query);
  try {
    return db
      .prepare(
        `SELECT ref_table, ref_id AS id,
                COALESCE(s.description, m.description) AS description,
                COALESCE(s.folder, m.folder) AS folder,
                snippet(search_index, 3, '<<', '>>', '…', 20) AS snippet,
                -bm25(search_index) AS score
         FROM search_index
         LEFT JOIN skills s ON search_index.ref_table = 'skills' AND s.id = search_index.ref_id
         LEFT JOIN memory_docs m ON search_index.ref_table = 'memory_docs' AND m.id = search_index.ref_id
         WHERE search_index MATCH ?
         ORDER BY bm25(search_index)
         LIMIT ? OFFSET ?`
      )
      .all(sanitized, limit, offset) as CombinedSearchHit[];
  } catch (err) {
    throw new SearchQueryError(query, err);
  }
}
```

- [ ] **Step 5: Wire it into `MemoryRepository.search()` in `src/memory/repository.ts`**

Add the import at the top: `import { SearchQueryError, sanitizeFtsQuery } from '../store/search.js';` (replace the existing `SearchQueryError`-only import if present — check the file's current imports first, since it may already import other things from `store/search.js`).

In `search()`, change:

```ts
    const { docType, status, folder, tag, limit = 20, offset = 0, includePaused = false } = opts;
    const conditions: string[] = [];
    const params: unknown[] = [query];
```

to:

```ts
    const { docType, status, folder, tag, limit = 20, offset = 0, includePaused = false } = opts;
    const conditions: string[] = [];
    const params: unknown[] = [sanitizeFtsQuery(query)];
```

(the `catch (err) { throw new SearchQueryError(query, err); }` at the bottom keeps using the original `query` so the error message still shows what the user typed.)

- [ ] **Step 6: Wire it into `SkillRepository.search()` in `src/skills/repository.ts`**

Same pattern: add `sanitizeFtsQuery` to the existing `import { SearchQueryError } from '../store/search.js';` line, and change the `params` array's first element from `query` to `sanitizeFtsQuery(query)` (find the equivalent `params: unknown[] = [query]`-style line preceding the `MATCH ?` prepared statement in this file).

- [ ] **Step 7: Wire it into `matchSearch()` in `src/web/routes.ts`**

Add `sanitizeFtsQuery` to the import from `'../store/search.js'` at the top of the file (add the import if `store/search.js` isn't already imported there). Change:

```ts
function matchSearch(db: Database.Database, q: string): { skills: Set<string>; memory_docs: Set<string> } {
  const skills = new Set<string>();
  const memory_docs = new Set<string>();
  let rows: Array<{ ref_table: 'skills' | 'memory_docs'; ref_id: string }>;
  try {
    rows = db
      .prepare(`SELECT ref_table, ref_id FROM search_index WHERE search_index MATCH ? ORDER BY rank`)
      .all(q) as typeof rows;
```

to:

```ts
function matchSearch(db: Database.Database, q: string): { skills: Set<string>; memory_docs: Set<string> } {
  const skills = new Set<string>();
  const memory_docs = new Set<string>();
  let rows: Array<{ ref_table: 'skills' | 'memory_docs'; ref_id: string }>;
  try {
    rows = db
      .prepare(`SELECT ref_table, ref_id FROM search_index WHERE search_index MATCH ? ORDER BY rank`)
      .all(sanitizeFtsQuery(q)) as typeof rows;
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd packages/mcp-memory-bucket && npm test`
Expected: PASS (both this test and Task 1's test stay green).

---

### Task 3: `MemoryRepository.suggestKeys()` — punctuation-stripped fuzzy key match

**Files:**
- Modify: `packages/mcp-memory-bucket/src/memory/repository.ts`
- Test: `packages/mcp-memory-bucket/test/repository.test.ts`

**Interfaces:**
- Produces: `MemoryRepository.suggestKeys(partial: string, limit = 5): Array<{ key: string; docCount: number }>` — ranked: exact punctuation-stripped match first, then stripped-prefix match, then stripped-substring match, alphabetical tiebreak. Also exports a module-level `stripKey(s: string): string` helper (uppercase, strip everything but `[A-Z0-9]`) for reuse in Task 4/5.

- [ ] **Step 1: Write the failing test**

Add to `packages/mcp-memory-bucket/test/repository.test.ts`:

```ts
test('suggestKeys finds a punctuation-drifted match (RMXS15 vs RMXS-15)', () => {
  const memDir = makeTmpDir();
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'folder', path: memDir }]);

  repo.create({ key: 'RMXS-15', key_type: 'ticket', doc_type: 'plan', description: 'a', body: 'a' });
  repo.create({ key: 'RMXS-14', key_type: 'ticket', doc_type: 'plan', description: 'b', body: 'b' });

  const hits = repo.suggestKeys('RMXS15'); // no hyphen — should still find RMXS-15
  assert.equal(hits[0]!.key, 'RMXS-15');
  assert.equal(hits[0]!.docCount, 1);
  assert.ok(!hits.some((h) => h.key === 'RMXS-14')); // unrelated key excluded

  db.close();
  fs.rmSync(memDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/mcp-memory-bucket && npm test`
Expected: FAIL — `repo.suggestKeys is not a function`.

- [ ] **Step 3: Implement `stripKey` and `suggestKeys`**

In `packages/mcp-memory-bucket/src/memory/repository.ts`, add near the top (module scope, after imports):

```ts
/** Uppercases and strips everything but letters/digits — used to compare keys that differ only in
 * punctuation/whitespace formatting (e.g. `RMXS-15` and `RMXS15` strip to the same `RMXS15`). */
export function stripKey(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
```

Add this method to `MemoryRepository`, right after `listKeys()`:

```ts
  /**
   * Fuzzy key lookup for a partial/drifted key, comparing keys with all punctuation stripped so
   * `RMXS15` and `RMXS-15` are treated as the same candidate. Ranked: exact stripped match first,
   * then stripped-prefix, then stripped-substring; alphabetical tiebreak within each tier.
   */
  suggestKeys(partial: string, limit = 5): Array<{ key: string; docCount: number }> {
    const strippedPartial = stripKey(partial);
    if (!strippedPartial) return [];
    const rows = this.db
      .prepare(`SELECT key, COUNT(*) as doc_count FROM memory_docs GROUP BY key`)
      .all() as Array<{ key: string; doc_count: number }>;
    return rows
      .map((r) => ({ key: r.key, docCount: r.doc_count, stripped: stripKey(r.key) }))
      .filter((r) => r.stripped.includes(strippedPartial))
      .sort((a, b) => {
        const aExact = a.stripped === strippedPartial ? 0 : 1;
        const bExact = b.stripped === strippedPartial ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        const aPrefix = a.stripped.startsWith(strippedPartial) ? 0 : 1;
        const bPrefix = b.stripped.startsWith(strippedPartial) ? 0 : 1;
        if (aPrefix !== bPrefix) return aPrefix - bPrefix;
        return a.key.localeCompare(b.key);
      })
      .slice(0, limit)
      .map(({ key, docCount }) => ({ key, docCount }));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/mcp-memory-bucket && npm test`
Expected: PASS

---

### Task 4: `memory_create` "did you mean an existing key?" nudge

**Files:**
- Modify: `packages/mcp-memory-bucket/src/memory/tools.ts`

**Interfaces:**
- Consumes: `MemoryRepository.suggestKeys()`, `stripKey()` (Task 3), `normalizeKey()` (`../types.js`, already imported elsewhere in this package).
- Produces: `memory_create`'s tool response includes an extra `key_warning` string field when a near-duplicate (punctuation-drifted) key already exists — informational only, never blocks the write.

- [ ] **Step 1: Add the import**

At the top of `packages/mcp-memory-bucket/src/memory/tools.ts`, add:

```ts
import { normalizeKey } from '../types.js';
import { stripKey } from './repository.js';
```

(check the file's existing imports first and merge rather than duplicate if `normalizeKey` or a `types.js` import already exists.)

- [ ] **Step 2: Add the nudge in the `memory_create` handler**

Find the existing handler (from `mcp.tool('memory_create', ...)`):

```ts
    async ({ key, key_type, doc_type, description, body, tags, status, related_to, subfolder, folder }: any) => {
      try {
        const doc = repo.create({ key, key_type, doc_type, description, body, tags, status, related_to, subfolder, folder });
        return { content: [{ type: 'text', text: JSON.stringify(doc, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
```

Replace with:

```ts
    async ({ key, key_type, doc_type, description, body, tags, status, related_to, subfolder, folder }: any) => {
      try {
        const normalized = normalizeKey(key);
        const strippedNew = stripKey(normalized);
        const nearDuplicate = repo
          .suggestKeys(key, 3)
          .find((m) => stripKey(m.key) === strippedNew && m.key !== normalized);

        const doc = repo.create({ key, key_type, doc_type, description, body, tags, status, related_to, subfolder, folder });

        const result: Record<string, unknown> = { ...doc };
        if (nearDuplicate) {
          result.key_warning = `A similarly-formatted key "${nearDuplicate.key}" already exists with ${nearDuplicate.docCount} doc(s) — did you mean to use that key instead of "${normalized}"? This doc was still created under "${normalized}".`;
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
      }
    }
```

- [ ] **Step 3: Build and manually verify**

Run: `cd packages/mcp-memory-bucket && npm run build`
Expected: builds with no type errors.

There's no existing tool-handler test harness in this package (only repository-level tests) — `suggestKeys`/`stripKey` are already covered at the repository level in Task 3, so this step is a thin wire-up. Manually verify by starting the server (`npm start`) and calling `memory_create` twice with drifted keys (e.g. `RMXS-20` then `RMXS20`) via an MCP client — the second call's response should include `key_warning`.

---

### Task 5: Web route support — key filter, suggest endpoint, search short-circuit

**Files:**
- Modify: `packages/mcp-memory-bucket/src/web/routes.ts`

**Interfaces:**
- Consumes: `MemoryRepository.suggestKeys()`, `stripKey()` (Task 3).
- Produces: `GET /api/keys/suggest?q=<partial>` → `Array<{ key: string; docCount: number }>`. `queryEntries()` short-circuits to an exact key filter when `q` matches an existing key (ignoring punctuation), otherwise falls through to the existing FTS path unchanged.

- [ ] **Step 1: Add the key-match short-circuit to `queryEntries()`**

In `packages/mcp-memory-bucket/src/web/routes.ts`, find:

```ts
  const matchedIds: { skills: Set<string>; memory_docs: Set<string> } | null = q
    ? matchSearch(db, q)
    : null;
  if (q && matchedIds && matchedIds.skills.size === 0 && matchedIds.memory_docs.size === 0) {
    return [];
  }
```

Replace with:

```ts
  // If the typed query matches an existing key (ignoring punctuation/case), short-circuit straight
  // to "every doc under this key" for memory_docs — this bypasses FTS/bm25 ranking entirely, so a
  // doc whose body never repeats the literal key text (e.g. a session summary) still shows up.
  // Skills have no `key` concept, so they still go through the normal FTS path below when q is set.
  const keyMatch = q ? memoryRepo.suggestKeys(q, 1).find((m) => stripKey(m.key) === stripKey(q)) : undefined;

  const matchedIds: { skills: Set<string>; memory_docs: Set<string> } | null =
    q && !keyMatch ? matchSearch(db, q) : null;
  if (q && !keyMatch && matchedIds && matchedIds.skills.size === 0 && matchedIds.memory_docs.size === 0) {
    return [];
  }
```

Add `stripKey` to the import from `'../memory/repository.js'` at the top of the file (it currently only imports the `MemoryRepository` type — add `stripKey` as a value import alongside it).

- [ ] **Step 2: Apply the key match as a filter on the memory_docs branch**

Find:

```ts
  if (type === 'memory' || type === 'all') {
    results.push(
      ...queryTable(
        db,
        'memory_docs',
        { tags, statuses, owners: [], docTypes, keyTypes, folders, deprecated, paused },
        intersectIds(matchedIds?.memory_docs, dateIds?.memory_docs)
      )
    );
  }
```

Replace with:

```ts
  if (type === 'memory' || type === 'all') {
    results.push(
      ...queryTable(
        db,
        'memory_docs',
        { tags, statuses, owners: [], docTypes, keyTypes, folders, deprecated, paused, keys: keyMatch ? [keyMatch.key] : [] },
        keyMatch ? undefined : intersectIds(matchedIds?.memory_docs, dateIds?.memory_docs)
      )
    );
  }
```

(when `keyMatch` is set, restricting by `keys` in `queryTable` — added next step — replaces the `restrictToIds` mechanism entirely, so all docs under that key show regardless of date/FTS filtering.)

- [ ] **Step 3: Add `keys` filtering to `queryTable()`**

Find the `queryTable` function signature:

```ts
function queryTable(
  db: Database.Database,
  table: 'skills' | 'memory_docs',
  filters: {
    tags: string[];
    statuses: string[];
    owners: string[];
    docTypes: string[];
    keyTypes: string[];
    folders: string[];
    deprecated?: string;
    paused?: string;
  },
  restrictToIds: Set<string> | undefined
): EntryRow[] {
```

Add `keys: string[];` to the `filters` type:

```ts
function queryTable(
  db: Database.Database,
  table: 'skills' | 'memory_docs',
  filters: {
    tags: string[];
    statuses: string[];
    owners: string[];
    docTypes: string[];
    keyTypes: string[];
    folders: string[];
    keys: string[];
    deprecated?: string;
    paused?: string;
  },
  restrictToIds: Set<string> | undefined
): EntryRow[] {
```

Find the `keyTypes` filter block inside the function body:

```ts
  if (table === 'memory_docs' && filters.keyTypes.length > 0) {
    where += ` AND key_type IN (${filters.keyTypes.map(() => '?').join(', ')})`;
    params.push(...filters.keyTypes);
  }
```

Add right after it:

```ts
  if (table === 'memory_docs' && filters.keys.length > 0) {
    where += ` AND key IN (${filters.keys.map(() => '?').join(', ')})`;
    params.push(...filters.keys);
  }
```

Update the two existing call sites in `queryEntries()` that build this filters object for `'skills'` (which has no `keys` field relevance) to pass `keys: []`:

```ts
      ...queryTable(
        db,
        'skills',
        { tags, statuses, owners, docTypes: [], keyTypes: [], folders, keys: [], deprecated, paused },
        intersectIds(matchedIds?.skills, dateIds?.skills)
      )
```

- [ ] **Step 4: Add the `/api/keys/suggest` endpoint**

In `buildWebRouter()`, add near the other `GET` routes (e.g. right after the `/api/facets` route):

```ts
  router.get('/api/keys/suggest', (req: Request, res: Response) => {
    const q = (req.query.q as string | undefined)?.trim();
    if (!q) {
      res.json([]);
      return;
    }
    res.json(memoryRepo.suggestKeys(q, 8));
  });
```

- [ ] **Step 5: Build and verify manually**

Run: `cd packages/mcp-memory-bucket && npm run build`
Expected: builds with no type errors.

Run: `cd packages/mcp-memory-bucket && npm start` (in one terminal), then in another:
```bash
curl "http://localhost:8765/api/keys/suggest?q=RMXS15"
curl "http://localhost:8765/api/entries?q=RMXS-15"
```
Expected: the first returns existing `RMXS-*` keys whose stripped form contains `RMXS15`; the second returns every memory doc under the exact `RMXS-15` key (if one exists in your bucket) regardless of whether the literal string appears in their bodies.

---

### Task 6: Client — group the result list by key

**Files:**
- Modify: `packages/mcp-memory-bucket/src/client/result-list.ts`

**Interfaces:**
- Consumes: `Entry[]` (existing prop) — memory rows already carry their key as `entry.name` (see `src/client/types.ts`'s `Entry.name` and `web/routes.ts`'s `queryTable`, which sets `name: r.key` for memory rows).
- Produces: no new props — same `results` input, grouped visually in `render()`.

- [ ] **Step 1: Add a grouping helper above the `ResultList` class**

In `packages/mcp-memory-bucket/src/client/result-list.ts`, add above `export class ResultList`:

```ts
interface EntryGroup {
  key: string | null; // null groups all `skills` rows together, unlabeled (skills have no key)
  items: Entry[];
}

/** Groups memory_docs rows by key (their shared lookup handle), preserving each row's relative
 * order and using each group's first-seen position (i.e. the current sort order) as the group's
 * position. Skills have no key concept, so they're collected into one trailing unlabeled group. */
function groupByKey(results: Entry[]): EntryGroup[] {
  const order: string[] = [];
  const groups = new Map<string, Entry[]>();
  const ungrouped: Entry[] = [];
  for (const r of results) {
    if (r._table !== 'memory_docs') {
      ungrouped.push(r);
      continue;
    }
    if (!groups.has(r.name)) {
      groups.set(r.name, []);
      order.push(r.name);
    }
    groups.get(r.name)!.push(r);
  }
  const grouped: EntryGroup[] = order.map((key) => ({ key, items: groups.get(key)! }));
  if (ungrouped.length > 0) grouped.push({ key: null, items: ungrouped });
  return grouped;
}
```

- [ ] **Step 2: Add group header styles**

In the `static styles = css\`...\`` block, add:

```css
    .key-group-header {
      padding: 6px 14px;
      font-size: 11px;
      font-weight: 700;
      opacity: 0.7;
      background: var(--bg-subtle);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .key-group-count { opacity: 0.6; font-weight: 400; }
```

- [ ] **Step 3: Use the grouping in `render()`**

Find:

```ts
  render() {
    if (!this.results || this.results.length === 0) {
      return html`<div class="empty">No results.</div>`;
    }
    return html`
      <div class="count-header">${this.results.length} result${this.results.length === 1 ? '' : 's'}</div>
      ${this.results.map((r) => {
```

Replace with:

```ts
  render() {
    if (!this.results || this.results.length === 0) {
      return html`<div class="empty">No results.</div>`;
    }
    return html`
      <div class="count-header">${this.results.length} result${this.results.length === 1 ? '' : 's'}</div>
      ${groupByKey(this.results).map(
        (group) => html`
          ${group.key ? html`<div class="key-group-header">🔑 ${group.key} <span class="key-group-count">(${group.items.length})</span></div>` : ''}
          ${group.items.map((r) => this.#renderRow(r))}
        `
      )}
    `;
  }

  #renderRow(r: Entry) {
    return (() => {
```

Then close the extracted row-rendering function where the original `.map((r) => { ... })` body ended: find the tail of the original map callback —

```ts
            </div>
          </div>
        `;
      })}
    `;
  }
```

Replace with:

```ts
            </div>
          </div>
        `;
    })();
  }
```

(This extracts the existing per-row template into a `#renderRow(r: Entry)` private method, called once per item inside each group, instead of inline in a single flat `.map()`. The row markup itself — checkbox, name, description, tags, badges — is unchanged.)

- [ ] **Step 4: Build and verify manually**

Run: `cd packages/mcp-memory-bucket && npm run build`
Expected: builds with no type errors.

Open the web UI (`get_form_url`-style: start the server, open `http://localhost:8765`), filter to Memory docs, and confirm docs sharing a key now appear under one `🔑 KEY (n)` header instead of scattered through a flat list.

---

### Task 7: Doc fixes — AGENTS.md wording bug + authoring skill guidance

**Files:**
- Modify: `packages/mcp-memory-bucket/AGENTS.md`
- Modify: `packages/mcp-memory-bucket/src/skills/builtin/memory-bucket-authoring/SKILL.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Fix the `overrides.folder` → `overrides.subfolder` wording bug in AGENTS.md**

In `packages/mcp-memory-bucket/AGENTS.md`, find:

```
- `overrides.folder` places the relocated file into a subdirectory of the
  target source dir, same as `skill_create`/`memory_create`.
```

Replace with:

```
- `overrides.subfolder` places the relocated file into a subdirectory of the
  target source dir, same as `skill_create`/`memory_create`. `overrides.folder`
  is a different thing — it picks which configured top-level named folder to
  write into, only relevant when multiple folders of that kind are configured.
```

- [ ] **Step 2: Add the tags-vs-key convention (D1) to the authoring skill**

In `packages/mcp-memory-bucket/src/skills/builtin/memory-bucket-authoring/SKILL.md`, find the end of the "Authoring a memory doc" section — the paragraph ending with:

```
**Never infer the key from environment state** (branch name, current
directory, etc.) — always get it from what the user actually said in
conversation, or ask if it's genuinely unclear.
```

Add immediately after it (still within the same section, before `### Saving a session`):

```

**Tags are for cross-cutting labels, not grouping.** `key` is the one and only
grouping concept for memory docs — never add a doc's own key (or a related
doc's key) as a tag to link things together; that's what `key` already does.
Use `tags` for labels that cut across many keys (e.g. `viz-team`, `datalab`),
not as a second grouping axis.
```

- [ ] **Step 3: Add the "check existing keys first" convention (D7) to the authoring skill**

Immediately after the block added in Step 2 (still before `### Saving a session`), add:

```

**Before creating a doc under a `ticket`-type key, check for an existing
near-match first** — e.g. `memory_list("RMXS-15")` or `memory_search` — rather
than writing a fresh key that only differs in punctuation or casing
(`RMXS15` vs `RMXS-15` vs `Rmxs 15` are three different keys to this system,
even though they're clearly meant to be the same ticket). Reuse the existing
key's exact casing/format if one is found. `memory_create`'s response
includes a `key_warning` field if it detects a likely near-duplicate after
the fact — treat that as a signal to double check, not to ignore.
```

- [ ] **Step 4: Manually verify**

Read back both files to confirm the edits read naturally in context (no dangling references, no duplicated headings).

---

## Self-Review Notes

- **Spec coverage:** D1 → Task 7 Step 2. D4 → Tasks 1–2. D5 → Task 6. D6 → Tasks 3–5. D7 → Task 7 Step 3. D8 → Task 5. D2/D3 are no-ops by design (flat layout already in place) and are not implemented in this plan.
- **No placeholders:** every step above has real, file-accurate code (verified against the current contents of each file during planning).
- **Type consistency:** `suggestKeys`/`stripKey` signatures introduced in Task 3 are used identically in Tasks 4 and 5 (`repo.suggestKeys(partial, limit)` → `Array<{ key: string; docCount: number }>`; `stripKey(s: string): string`).
