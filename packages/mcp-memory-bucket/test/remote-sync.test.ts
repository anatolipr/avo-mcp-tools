import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCache } from '../src/store/db.js';
import { memorySyncSpec } from '../src/store/sync.js';
import { setCredential } from '../src/remote/credentials.js';
import { pollOne, startRemotePolling } from '../src/remote/remote-sync.js';
import type { RemoteFolder } from '../src/config.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Fakes folderfoo's HTTP surface for the three endpoints remote-sync.ts's
// pollOne actually calls (last-changed, changed-since, data/:filename) -
// real folderfoo-client.ts and remote-sync.ts code runs unmodified against
// this, only the network boundary (global fetch) is faked. Mirrors the
// mocking approach folderfoo-client.test.ts already uses.
function mockFolderfoo(state: {
  lastChanged: number;
  files: Array<{ name: string; folderPath: string; mtime: number; content: string }>;
}) {
  const calls: string[] = [];
  return async (url: string) => {
    calls.push(url);
    if (url.includes('/folders/last-changed')) {
      return { ok: true, status: 200, json: async () => ({ lastChanged: state.lastChanged }) } as Response;
    }
    if (url.includes('/folders/changed-since')) {
      const sinceMatch = url.match(/since=(\d+)/);
      const since = sinceMatch ? Number(sinceMatch[1]) : 0;
      const files = state.files.filter((f) => f.mtime > since).map((f) => ({ name: f.name, folderPath: f.folderPath, mtime: f.mtime }));
      return { ok: true, status: 200, json: async () => ({ files, serverTime: Date.now() }) } as Response;
    }
    if (url.includes('/data/')) {
      // ":folderPath:name" or bare "name" - find by matching the tail
      const found = state.files.find((f) => url.endsWith(`:${f.name}`) || url.endsWith(`/${f.name}`));
      return { ok: true, status: 200, text: async () => found?.content ?? '' } as Response;
    }
    throw new Error(`unexpected mocked fetch call: ${url}`);
  };
}

function makeFolder(mirrorDir: string): RemoteFolder {
  return { name: 'team-qa', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'plans', mirrorDir, mode: 'dev', username: 'testuser' };
}

test('pollOne: skips the listing call entirely when last-changed has not moved past the local watermark', async (t) => {
  const credsDir = tmpDir('mb-remote-sync-creds-');
  const mirrorDir = tmpDir('mb-remote-sync-mirror-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const spec = memorySyncSpec([{ name: 'team-qa', path: mirrorDir }]);
  const folder = makeFolder(mirrorDir);

  // First poll pulls one file and advances the watermark to 100.
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls++;
    return mockFolderfoo({ lastChanged: 100, files: [{ name: 'notes.md', folderPath: 'plans', mtime: 100, content: '---\nkey: notes\n---\nbody' }] })(url);
  });
  await pollOne(db, spec, folder, credsDir);
  assert.ok(calls > 0);

  // Second poll: last-changed still reports 100 (unchanged) - should call
  // ONLY /folders/last-changed, never /folders/changed-since.
  const secondCallUrls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    secondCallUrls.push(url);
    return mockFolderfoo({ lastChanged: 100, files: [] })(url);
  });
  await pollOne(db, spec, folder, credsDir);
  assert.ok(secondCallUrls.some((u) => u.includes('last-changed')));
  assert.ok(!secondCallUrls.some((u) => u.includes('changed-since')), `expected no changed-since call, got: ${secondCallUrls.join(', ')}`);
});

test('pollOne: pulls a changed file into the mirror and upserts it into the cache', async (t) => {
  const credsDir = tmpDir('mb-remote-sync-creds-');
  const mirrorDir = tmpDir('mb-remote-sync-mirror-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const spec = memorySyncSpec([{ name: 'team-qa', path: mirrorDir }]);
  const folder = makeFolder(mirrorDir);

  t.mock.method(
    globalThis,
    'fetch',
    mockFolderfoo({
      lastChanged: 500,
      files: [{ name: 'roadmap.md', folderPath: 'plans', mtime: 500, content: '---\nkey: roadmap\ndescription: The roadmap\n---\nRoadmap body.' }],
    })
  );

  await pollOne(db, spec, folder, credsDir);

  // folder.mirrorDir already IS the "plans" folder's local mirror root -
  // a root-level file in "plans" lands directly at mirrorDir/roadmap.md,
  // NOT mirrorDir/plans/roadmap.md (that double-nesting was the bug).
  const mirrorFile = path.join(mirrorDir, 'roadmap.md');
  assert.ok(fs.existsSync(mirrorFile));
  assert.match(fs.readFileSync(mirrorFile, 'utf-8'), /Roadmap body\./);

  const row = db.prepare(`SELECT * FROM memory_docs WHERE source_path = ?`).get(mirrorFile) as { description: string } | undefined;
  assert.equal(row?.description, 'The roadmap');
});

test('pollOne: reconciles a remote deletion by removing the mirror file and its cache row', async (t) => {
  const credsDir = tmpDir('mb-remote-sync-creds-');
  const mirrorDir = tmpDir('mb-remote-sync-mirror-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const spec = memorySyncSpec([{ name: 'team-qa', path: mirrorDir }]);
  const folder = makeFolder(mirrorDir);

  // First poll: one file exists remotely, gets pulled.
  t.mock.method(
    globalThis,
    'fetch',
    mockFolderfoo({
      lastChanged: 100,
      files: [{ name: 'todo.md', folderPath: 'plans', mtime: 100, content: '---\nkey: todo\ndescription: A todo\n---\nbody' }],
    })
  );
  await pollOne(db, spec, folder, credsDir);
  const mirrorFile = path.join(mirrorDir, 'todo.md');
  assert.ok(fs.existsSync(mirrorFile));

  // Second poll: last-changed moved (something changed - the deletion
  // itself), but the file no longer appears in folderfoo's listing at all.
  t.mock.method(globalThis, 'fetch', mockFolderfoo({ lastChanged: 200, files: [] }));
  await pollOne(db, spec, folder, credsDir);

  assert.ok(!fs.existsSync(mirrorFile));
  const row = db.prepare(`SELECT * FROM memory_docs WHERE source_path = ?`).get(mirrorFile);
  assert.equal(row, undefined);
});

test('pollOne: an auth failure is swallowed at the poll-tick level (logged, not thrown), so the loop survives', async (t) => {
  const credsDir = tmpDir('mb-remote-sync-creds-'); // no credential set - forces FolderfooAuthError
  const mirrorDir = tmpDir('mb-remote-sync-mirror-');
  const db = openCache(':memory:');
  const spec = memorySyncSpec([{ name: 'team-qa', path: mirrorDir }]);
  const folder = makeFolder(mirrorDir);

  await assert.doesNotReject(() => pollOne(db, spec, folder, credsDir));
});

test('startRemotePolling: resyncNow triggers an immediate poll for the named source only', async (t) => {
  const credsDir = tmpDir('mb-remote-sync-creds-');
  const mirrorDir = tmpDir('mb-remote-sync-mirror-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const spec = memorySyncSpec([{ name: 'team-qa', path: mirrorDir }]);
  const folder = makeFolder(mirrorDir);

  t.mock.method(
    globalThis,
    'fetch',
    mockFolderfoo({ lastChanged: 42, files: [{ name: 'x.md', folderPath: 'plans', mtime: 42, content: '---\nkey: x\ndescription: X\n---\nbody' }] })
  );

  const handle = startRemotePolling(db, spec, [folder], credsDir);
  try {
    await handle.resyncNow('team-qa');
    assert.ok(fs.existsSync(path.join(mirrorDir, 'x.md')));
    await assert.rejects(() => handle.resyncNow('nonexistent'), /no remote source configured/);
  } finally {
    handle.stop();
  }
});

// Regression coverage for a real bug: the web UI's "rebuild cache" button
// (POST /api/rebuild-cache) only re-scanned the LOCAL mirror directory on
// disk - it never talked to folderfoo, so a file deleted remotely (e.g.
// trashed via folderfoo's own UI) whose stale mirror copy hadn't yet been
// reconciled away by the poller's next regular tick would get silently
// re-indexed right back into the cache by the rebuild itself. Fixed via
// pollOne's new `force` option (bypasses the cheap watermark-equality skip,
// so reconcileDeletions always actually runs) plus resyncAll on the
// poller handle.

test('pollOne with force:true runs reconcileDeletions even when last-changed equals the local watermark', async (t) => {
  const credsDir = tmpDir('mb-remote-sync-creds-');
  const mirrorDir = tmpDir('mb-remote-sync-mirror-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const spec = memorySyncSpec([{ name: 'team-qa', path: mirrorDir }]);
  const folder = makeFolder(mirrorDir);

  // First poll: pulls one file, advances the watermark to 100.
  t.mock.method(
    globalThis,
    'fetch',
    mockFolderfoo({ lastChanged: 100, files: [{ name: 'doomed.md', folderPath: 'plans', mtime: 100, content: '---\nkey: doomed\ndescription: D\n---\nbody' }] })
  );
  await pollOne(db, spec, folder, credsDir);
  const mirrorFile = path.join(mirrorDir, 'doomed.md');
  assert.ok(fs.existsSync(mirrorFile));

  // Simulate the buggy scenario: folderfoo's watermark is STILL 100 (no
  // regular poll tick has observed the deletion and advanced it yet -
  // e.g. the deletion happened but this stale reading is what the UI's
  // rebuild-cache click sees), yet the file no longer appears in a live
  // listing (it was trashed). Without force, a normal pollOne would skip
  // via the cheap path and leave the stale mirror file in place.
  t.mock.method(globalThis, 'fetch', mockFolderfoo({ lastChanged: 100, files: [] }));

  await pollOne(db, spec, folder, credsDir); // no force: cheap-skips, bug reproduced
  assert.ok(fs.existsSync(mirrorFile), 'sanity check: without force, the stale file is NOT reconciled');

  await pollOne(db, spec, folder, credsDir, { force: true });
  assert.ok(!fs.existsSync(mirrorFile), 'force:true must reconcile the deletion even though last-changed did not advance');
  const row = db.prepare(`SELECT * FROM memory_docs WHERE source_path = ?`).get(mirrorFile);
  assert.equal(row, undefined);
});

test('startRemotePolling: resyncAll force-resyncs every remote source, not just one', async (t) => {
  const credsDir = tmpDir('mb-remote-sync-creds-');
  const mirrorDirA = tmpDir('mb-remote-sync-mirror-a-');
  const mirrorDirB = tmpDir('mb-remote-sync-mirror-b-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const folderA: RemoteFolder = { name: 'source-a', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'a', mirrorDir: mirrorDirA, mode: 'dev', username: 'testuser' };
  const folderB: RemoteFolder = { name: 'source-b', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'b', mirrorDir: mirrorDirB, mode: 'dev', username: 'testuser' };
  const spec = memorySyncSpec([
    { name: 'source-a', path: mirrorDirA },
    { name: 'source-b', path: mirrorDirB },
  ]);

  const seen = new Set<string>();
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.includes('folderPath=a')) seen.add('a');
    if (url.includes('folderPath=b')) seen.add('b');
    return mockFolderfoo({ lastChanged: 1, files: [] })(url);
  });

  const handle = startRemotePolling(db, spec, [folderA, folderB], credsDir);
  try {
    await handle.resyncAll();
    assert.ok(seen.has('a') && seen.has('b'), `expected both sources polled, saw: ${[...seen].join(', ')}`);
  } finally {
    handle.stop();
  }
});

// Regression coverage for a real bug: folderfoo's GET /folders/changed-since
// reports folderPath ABSOLUTE FROM THE TENANT ROOT (e.g. "plans" for a
// root-level file in the connected "plans" folder, "plans/q3" for a file
// nested one level deeper) - NOT relative to the queried folder. pullFile/
// reconcileDeletions were joining that absolute value directly onto
// folder.mirrorDir, double-nesting every mirror path (mirrorDir/plans/...
// instead of mirrorDir/...). Every prior test in this file used a
// ROOT-level file, where changedFile.folderPath ("plans") happened to
// exactly equal folder.folderPath ("plans") - the one case where the bug
// produced a coincidentally-plausible-looking (but still wrong - double
// nested) path without anything asserting on the WRONG part. This test
// uses a file nested one level INSIDE the connected folder, which the old
// code would have mirrored to mirrorDir/plans/q3/roadmap.md instead of the
// correct mirrorDir/q3/roadmap.md.
test('pollOne: a file nested inside a subfolder of the connected remote folder mirrors WITHOUT double-nesting the connected folder itself', async (t) => {
  const credsDir = tmpDir('mb-remote-sync-creds-');
  const mirrorDir = tmpDir('mb-remote-sync-mirror-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const spec = memorySyncSpec([{ name: 'team-qa', path: mirrorDir }]);
  const folder = makeFolder(mirrorDir); // folder.folderPath === 'plans'

  t.mock.method(
    globalThis,
    'fetch',
    mockFolderfoo({
      lastChanged: 100,
      // folderfoo's own convention: nested file's folderPath is "plans/q3" (absolute from tenant root), not "q3".
      files: [{ name: 'roadmap.md', folderPath: 'plans/q3', mtime: 100, content: '---\nkey: roadmap\ndescription: Q3 roadmap\n---\nBody.' }],
    })
  );
  await pollOne(db, spec, folder, credsDir);

  const correctPath = path.join(mirrorDir, 'q3', 'roadmap.md');
  const buggyDoubledPath = path.join(mirrorDir, 'plans', 'q3', 'roadmap.md');
  assert.ok(fs.existsSync(correctPath), `expected the mirror file at ${correctPath}`);
  assert.ok(!fs.existsSync(buggyDoubledPath), `must NOT double-nest under the connected folder's own name (${buggyDoubledPath})`);

  const row = db.prepare(`SELECT * FROM memory_docs WHERE source_path = ?`).get(correctPath) as { description: string; source_path: string } | undefined;
  assert.equal(row?.description, 'Q3 roadmap');
  assert.equal(row?.source_path, correctPath);
});

// Same double-nesting bug, but for reconcileDeletions' comparison set
// specifically: a file that's genuinely still present remotely (nested one
// level deep) must NOT be treated as deleted just because the comparison
// set was built from the wrong (double-nested) path space.
test('pollOne: reconcileDeletions does not delete a still-present nested file due to path-space mismatch', async (t) => {
  const credsDir = tmpDir('mb-remote-sync-creds-');
  const mirrorDir = tmpDir('mb-remote-sync-mirror-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const spec = memorySyncSpec([{ name: 'team-qa', path: mirrorDir }]);
  const folder = makeFolder(mirrorDir);

  t.mock.method(
    globalThis,
    'fetch',
    mockFolderfoo({
      lastChanged: 100,
      files: [{ name: 'nested-doc.md', folderPath: 'plans/q3', mtime: 100, content: '---\nkey: nested-doc\ndescription: N\n---\nBody.' }],
    })
  );
  await pollOne(db, spec, folder, credsDir);
  const mirrorFile = path.join(mirrorDir, 'q3', 'nested-doc.md');
  assert.ok(fs.existsSync(mirrorFile));

  // Second poll: SAME file still present remotely (nothing deleted), but
  // last-changed advanced (something else in the folder changed), forcing
  // a real changed-since call + reconcileDeletions to run.
  t.mock.method(
    globalThis,
    'fetch',
    mockFolderfoo({
      lastChanged: 200,
      files: [{ name: 'nested-doc.md', folderPath: 'plans/q3', mtime: 100, content: '---\nkey: nested-doc\ndescription: N\n---\nBody.' }],
    })
  );
  await pollOne(db, spec, folder, credsDir);

  assert.ok(fs.existsSync(mirrorFile), 'the still-present nested file must survive reconcileDeletions');
  const row = db.prepare(`SELECT * FROM memory_docs WHERE source_path = ?`).get(mirrorFile);
  assert.ok(row, 'the cache row for the still-present nested file must survive reconcileDeletions');
});

// Regression coverage for a real bug: an attachment saved with a .md extension (e.g.
// "attachment-1.md") lives on folderfoo at "<stem>/attachments/attachment-1.md" - a real file,
// indistinguishable from a memory doc by matchesFile (any .md). pullFile mirrored it to disk AND
// indexed it into memory_docs as a standalone doc, so it showed up as a top-level item in the UI
// (surfaced by the window-focus handler's forced resync, which is the only path that re-walks the
// full remote listing). walkMarkdownFiles/chokidar already exclude attachments/ on the LOCAL
// scan/watch paths; pullFile now applies the same exclusion before indexing.
test('pollOne: does not index an attachment file (nested under attachments/) as a standalone memory doc', async (t) => {
  const credsDir = tmpDir('mb-remote-sync-creds-');
  const mirrorDir = tmpDir('mb-remote-sync-mirror-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const spec = memorySyncSpec([{ name: 'team-qa', path: mirrorDir }]);
  const folder = makeFolder(mirrorDir); // folder.folderPath === 'plans'

  t.mock.method(
    globalThis,
    'fetch',
    mockFolderfoo({
      lastChanged: 100,
      files: [
        { name: 'TODO-PERSONAL-copy2.md', folderPath: 'plans', mtime: 100, content: '---\nkey: todo\ndescription: Todo\n---\nbody' },
        {
          name: 'attachment-1.md',
          folderPath: 'plans/TODO-PERSONAL-copy2/attachments',
          mtime: 100,
          content: '# Some attachment content',
        },
      ],
    })
  );
  await pollOne(db, spec, folder, credsDir);

  // The attachment is still mirrored to disk (it's a real, live attachment)...
  const attachmentMirrorFile = path.join(mirrorDir, 'TODO-PERSONAL-copy2', 'attachments', 'attachment-1.md');
  assert.ok(fs.existsSync(attachmentMirrorFile));

  // ...but must NOT be indexed as a standalone memory_docs row.
  const attachmentRow = db.prepare(`SELECT * FROM memory_docs WHERE source_path = ?`).get(attachmentMirrorFile);
  assert.equal(attachmentRow, undefined, 'an attachment file must never be indexed as a top-level memory doc');

  // The real memory doc is indexed as usual.
  const docRow = db.prepare(`SELECT * FROM memory_docs WHERE source_path = ?`).get(path.join(mirrorDir, 'TODO-PERSONAL-copy2.md'));
  assert.ok(docRow);
});

// Regression coverage for a real bug reported live: a doc's attachments/ dir in the local mirror
// accumulated every attachment ever pulled down, even ones long since deleted from folderfoo — the
// UI kept showing 5 declared attachments for a doc that genuinely only had 2 files left on
// folderfoo. Root cause: reconcileDeletions' remote-vs-local diff only ever walked
// walkMarkdownFiles (which deliberately EXCLUDES attachments/ so they're never indexed as docs), so
// a stale attachment file was never detected as "gone remotely" and never pruned from the mirror —
// combined with AttachmentRepository.reconcileToDisk trusting the mirror as truth, the stale files
// kept getting re-declared in frontmatter forever. Fixed via a second, attachment-specific walk
// (walkAttachmentFiles) that prunes any local attachments/ file no longer in folderfoo's listing.
test('pollOne: prunes a stale attachment file from the mirror once it is gone from folderfoo\'s own listing', async (t) => {
  const credsDir = tmpDir('mb-remote-sync-creds-');
  const mirrorDir = tmpDir('mb-remote-sync-mirror-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const spec = memorySyncSpec([{ name: 'team-qa', path: mirrorDir }]);
  const folder = makeFolder(mirrorDir); // folder.folderPath === 'plans'

  // First poll: doc plus two attachments, all present remotely — both get pulled into the mirror.
  t.mock.method(
    globalThis,
    'fetch',
    mockFolderfoo({
      lastChanged: 100,
      files: [
        { name: 'TODO-PERSONAL-copy2.md', folderPath: 'plans', mtime: 100, content: '---\nkey: todo\ndescription: Todo\n---\nbody' },
        { name: 'attachment.md', folderPath: 'plans/TODO-PERSONAL-copy2/attachments', mtime: 100, content: 'one' },
        { name: 'attachment2.md', folderPath: 'plans/TODO-PERSONAL-copy2/attachments', mtime: 100, content: 'two' },
      ],
    })
  );
  await pollOne(db, spec, folder, credsDir);
  const attachDir = path.join(mirrorDir, 'TODO-PERSONAL-copy2', 'attachments');
  assert.ok(fs.existsSync(path.join(attachDir, 'attachment.md')));
  assert.ok(fs.existsSync(path.join(attachDir, 'attachment2.md')));

  // Second poll (forced): folderfoo now only reports attachment.md — attachment2.md was
  // trashed/removed on the folderfoo side and never restored.
  t.mock.method(
    globalThis,
    'fetch',
    mockFolderfoo({
      lastChanged: 200,
      files: [
        { name: 'TODO-PERSONAL-copy2.md', folderPath: 'plans', mtime: 100, content: '---\nkey: todo\ndescription: Todo\n---\nbody' },
        { name: 'attachment.md', folderPath: 'plans/TODO-PERSONAL-copy2/attachments', mtime: 100, content: 'one' },
      ],
    })
  );
  await pollOne(db, spec, folder, credsDir, { force: true });

  assert.ok(fs.existsSync(path.join(attachDir, 'attachment.md')), 'the still-present attachment must survive');
  assert.ok(!fs.existsSync(path.join(attachDir, 'attachment2.md')), 'the remotely-deleted attachment must be pruned from the mirror');
});

// Same bug, but covering cleanup of a row that was ALREADY wrongly indexed before this fix (e.g. by
// a prior pollOne run against unpatched code) - reconcileDeletions must sweep it out on the next
// forced resync, since walkMarkdownFiles skips attachments/ and would otherwise never revisit it.
test('pollOne: force resync evicts a pre-existing misindexed attachment row from memory_docs', async (t) => {
  const credsDir = tmpDir('mb-remote-sync-creds-');
  const mirrorDir = tmpDir('mb-remote-sync-mirror-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const spec = memorySyncSpec([{ name: 'team-qa', path: mirrorDir }]);
  const folder = makeFolder(mirrorDir);

  // Simulate the pre-fix bug directly: write the parent doc plus its attachment mirror file, and
  // insert a stray memory_docs row for the attachment, bypassing pullFile entirely.
  const docMirrorFile = path.join(mirrorDir, 'TODO-PERSONAL-copy2.md');
  fs.writeFileSync(docMirrorFile, '---\nkey: todo\ndescription: Todo\n---\nbody');
  const attachmentMirrorFile = path.join(mirrorDir, 'TODO-PERSONAL-copy2', 'attachments', 'attachment-1.md');
  fs.mkdirSync(path.dirname(attachmentMirrorFile), { recursive: true });
  fs.writeFileSync(attachmentMirrorFile, '# Some attachment content');
  db.prepare(
    `INSERT INTO memory_docs (source_path, folder, key, key_type, description, doc_type, tags, status, body, mtime_ms)
     VALUES (?, ?, ?, 'freeform', 'stray attachment row', 'other', '[]', 'active', ?, ?)`
  ).run(attachmentMirrorFile, 'team-qa', 'attachment-1', '# Some attachment content', Date.now());
  assert.ok(db.prepare(`SELECT * FROM memory_docs WHERE source_path = ?`).get(attachmentMirrorFile));

  t.mock.method(
    globalThis,
    'fetch',
    mockFolderfoo({
      lastChanged: 100,
      // Attachment file is listed too (still genuinely present remotely) - this test is only
      // about the misindexed DB ROW getting cleaned up, not about attachment pruning (covered
      // separately below), so the mock must report it present or reconcileDeletions' own
      // (correct, separate) attachment-pruning sweep would delete the mirror file too.
      files: [
        { name: 'TODO-PERSONAL-copy2.md', folderPath: 'plans', mtime: 100, content: '---\nkey: todo\ndescription: Todo\n---\nbody' },
        { name: 'attachment-1.md', folderPath: 'plans/TODO-PERSONAL-copy2/attachments', mtime: 100, content: '# Some attachment content' },
      ],
    })
  );
  await pollOne(db, spec, folder, credsDir, { force: true });

  const row = db.prepare(`SELECT * FROM memory_docs WHERE source_path = ?`).get(attachmentMirrorFile);
  assert.equal(row, undefined, 'a pre-existing misindexed attachment row must be evicted by a forced resync');
  // The mirror file itself is untouched - it's still a real, live attachment on disk.
  assert.ok(fs.existsSync(attachmentMirrorFile));
});
