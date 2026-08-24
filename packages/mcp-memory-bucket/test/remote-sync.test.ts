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
  return { name: 'team-qa', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'plans', mirrorDir };
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
    return mockFolderfoo({ lastChanged: 100, files: [{ name: 'notes', folderPath: 'plans', mtime: 100, content: '---\nkey: notes\n---\nbody' }] })(url);
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
      files: [{ name: 'roadmap', folderPath: 'plans', mtime: 500, content: '---\nid: roadmap\nkey: roadmap\ndescription: The roadmap\n---\nRoadmap body.' }],
    })
  );

  await pollOne(db, spec, folder, credsDir);

  // folder.mirrorDir already IS the "plans" folder's local mirror root -
  // a root-level file in "plans" lands directly at mirrorDir/roadmap.md,
  // NOT mirrorDir/plans/roadmap.md (that double-nesting was the bug).
  const mirrorFile = path.join(mirrorDir, 'roadmap.md');
  assert.ok(fs.existsSync(mirrorFile));
  assert.match(fs.readFileSync(mirrorFile, 'utf-8'), /Roadmap body\./);

  const row = db.prepare(`SELECT * FROM memory_docs WHERE id = ?`).get('roadmap') as { description: string } | undefined;
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
      files: [{ name: 'todo', folderPath: 'plans', mtime: 100, content: '---\nid: todo\nkey: todo\ndescription: A todo\n---\nbody' }],
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
  const row = db.prepare(`SELECT * FROM memory_docs WHERE id = ?`).get('todo');
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
    mockFolderfoo({ lastChanged: 42, files: [{ name: 'x', folderPath: 'plans', mtime: 42, content: '---\nid: x\nkey: x\ndescription: X\n---\nbody' }] })
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
    mockFolderfoo({ lastChanged: 100, files: [{ name: 'doomed', folderPath: 'plans', mtime: 100, content: '---\nid: doomed\nkey: doomed\ndescription: D\n---\nbody' }] })
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
  const row = db.prepare(`SELECT * FROM memory_docs WHERE id = ?`).get('doomed');
  assert.equal(row, undefined);
});

test('startRemotePolling: resyncAll force-resyncs every remote source, not just one', async (t) => {
  const credsDir = tmpDir('mb-remote-sync-creds-');
  const mirrorDirA = tmpDir('mb-remote-sync-mirror-a-');
  const mirrorDirB = tmpDir('mb-remote-sync-mirror-b-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const folderA: RemoteFolder = { name: 'source-a', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'a', mirrorDir: mirrorDirA };
  const folderB: RemoteFolder = { name: 'source-b', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'b', mirrorDir: mirrorDirB };
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
      files: [{ name: 'roadmap', folderPath: 'plans/q3', mtime: 100, content: '---\nid: roadmap\nkey: roadmap\ndescription: Q3 roadmap\n---\nBody.' }],
    })
  );
  await pollOne(db, spec, folder, credsDir);

  const correctPath = path.join(mirrorDir, 'q3', 'roadmap.md');
  const buggyDoubledPath = path.join(mirrorDir, 'plans', 'q3', 'roadmap.md');
  assert.ok(fs.existsSync(correctPath), `expected the mirror file at ${correctPath}`);
  assert.ok(!fs.existsSync(buggyDoubledPath), `must NOT double-nest under the connected folder's own name (${buggyDoubledPath})`);

  const row = db.prepare(`SELECT * FROM memory_docs WHERE id = ?`).get('roadmap') as { description: string; source_path: string } | undefined;
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
      files: [{ name: 'nested-doc', folderPath: 'plans/q3', mtime: 100, content: '---\nid: nested-doc\nkey: nested-doc\ndescription: N\n---\nBody.' }],
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
      files: [{ name: 'nested-doc', folderPath: 'plans/q3', mtime: 100, content: '---\nid: nested-doc\nkey: nested-doc\ndescription: N\n---\nBody.' }],
    })
  );
  await pollOne(db, spec, folder, credsDir);

  assert.ok(fs.existsSync(mirrorFile), 'the still-present nested file must survive reconcileDeletions');
  const row = db.prepare(`SELECT * FROM memory_docs WHERE id = ?`).get('nested-doc');
  assert.ok(row, 'the cache row for the still-present nested file must survive reconcileDeletions');
});
