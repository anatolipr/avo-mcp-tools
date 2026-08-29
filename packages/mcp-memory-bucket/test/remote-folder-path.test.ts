import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openCache } from '../src/store/db.js';
import { MemoryRepository } from '../src/memory/repository.js';
import { SkillRepository } from '../src/skills/repository.js';
import { setCredential } from '../src/remote/credentials.js';
import { mirrorDirFor } from '../src/config.js';
import type { RemoteFolder } from '../src/config.js';
import { IdentityTracker } from '../src/remote/identity.js';
import { AttachmentRepository } from '../src/attachments/repository.js';
import { startRemotePolling } from '../src/remote/remote-sync.js';
import { memorySyncSpec } from '../src/store/sync.js';

function loggedInIdentity(): IdentityTracker {
  const identity = new IdentityTracker('dev');
  identity.setUsername('testuser');
  return identity;
}

// Regression coverage for a real bug: every remote write/read dropped the
// RemoteFolder's own `folderPath` (its actual location on folderfoo, e.g.
// "memz") entirely, writing to the user's folderfoo ROOT instead of the
// connected folder - existing tests never caught this because they all
// happened to use folderPath: '' (root), the one case where the bug is
// invisible (buggy and correct code agree when folderPath is empty).
// These tests use a NON-EMPTY folderPath, mocking fetch and asserting the
// actual request URL sent to folderfoo includes it.

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// assertRemoteFolderExists() (folderfoo-client.ts) calls GET /folders before any write to a
// non-empty folderPath, to catch a folder deleted server-side since connect - every mock here
// must answer it with a list containing whatever folderPath the test under it writes to.
function mockFolderList(folders: string[]) {
  return { ok: true, status: 200, json: async () => folders.map((path) => ({ path, createdAt: new Date().toISOString() })) } as Response;
}

function mockFolderfoo(calls: string[], folders: string[] = ['memz', 'work/qa']) {
  return async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.endsWith('/folders')) {
      return mockFolderList(folders);
    }
    // pollOne's own two listing calls (see remote-sync.test.ts's mock) — only exercised by tests
    // that actually call startRemotePolling/pollOne, not the repo-level tests above. Reports
    // "nothing new" (lastChanged: 0, empty changed-since) so a poll finds no remote file changes to
    // pull — those tests set up the local mirror state directly rather than via a simulated pull.
    if (url.includes('/folders/last-changed')) {
      return { ok: true, status: 200, json: async () => ({ lastChanged: 0 }) } as Response;
    }
    if (url.includes('/folders/changed-since')) {
      return { ok: true, status: 200, json: async () => ({ files: [], serverTime: Date.now() }) } as Response;
    }
    if (url.includes('/save/')) {
      return { ok: true, status: 200, json: async () => ({ message: 'saved' }) } as Response;
    }
    if (url.includes('/rename/')) {
      return { ok: true, status: 200, json: async () => ({ name: 'renamed' }) } as Response;
    }
    if (url.includes('/trash/')) {
      return { ok: true, status: 200, json: async () => ({ message: 'archived' }) } as Response;
    }
    if (/\/folders\/.+/.test(url) && init?.method === 'DELETE') {
      return { ok: true, status: 200, json: async () => ({ message: 'trashed folder' }) } as Response;
    }
    if (url.includes('/data/')) {
      return { ok: true, status: 200, text: async () => 'live body' } as Response;
    }
    throw new Error(`unexpected mocked fetch call: ${url} ${JSON.stringify(init)}`);
  };
}

test('MemoryRepository.create against a remote folder with a non-empty folderPath addresses the write inside that folder, not root', async (t) => {
  const credsDir = tmpDir('mb-remote-path-creds-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [], [], credsDir, loggedInIdentity());

  const mirrorDir = mirrorDirFor(credsDir, 'dev', 'testuser', 'memz');
  const remote: RemoteFolder = { name: 'memz', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'memz', mirrorDir, mode: 'dev', username: 'testuser' };
  repo.registerRemoteFolder(remote);

  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', mockFolderfoo(calls));

  const doc = await repo.create({ filename: 'ideaz-ideas-list', key: 'ideaz', key_type: 'freeform', doc_type: 'other', description: 'ideas list', body: 'body', folder: 'memz' });

  const saveCall = calls.find((c) => c.includes('/save/'));
  assert.ok(saveCall, `expected a /save/ call, got: ${calls.join(', ')}`);
  // The 3-part unambiguous grammar (":folderPath:name") must carry "memz",
  // not just the (empty, since this doc has no subfolder within memz) bare filename.
  assert.ok(saveCall!.includes(encodeURIComponent('memz')), `expected the save URL to reference the remote folder "memz", got: ${saveCall}`);
  assert.ok(saveCall!.startsWith('https://folderfoo.example.com/save/:memz:'), `expected root-of-memz addressing, got: ${saveCall}`);
  assert.equal(doc.folder, 'memz');
});

test('MemoryRepository.get against a remote folder with a non-empty folderPath reads from inside that folder', async (t) => {
  const credsDir = tmpDir('mb-remote-path-creds-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [], [], credsDir, loggedInIdentity());

  const mirrorDir = mirrorDirFor(credsDir, 'dev', 'testuser', 'memz');
  const remote: RemoteFolder = { name: 'memz', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'memz', mirrorDir, mode: 'dev', username: 'testuser' };
  repo.registerRemoteFolder(remote);

  const createCalls: string[] = [];
  t.mock.method(globalThis, 'fetch', mockFolderfoo(createCalls));
  const doc = await repo.create({ filename: 'ideaz-ideas-list', key: 'ideaz', key_type: 'freeform', doc_type: 'other', description: 'ideas list', body: 'body', folder: 'memz' });
  const filename = path.basename(doc.source_path);

  const getCalls: string[] = [];
  t.mock.method(globalThis, 'fetch', mockFolderfoo(getCalls));
  const fetched = await repo.get('memz', filename);

  const dataCall = getCalls.find((c) => c.includes('/data/'));
  assert.ok(dataCall, `expected a /data/ call, got: ${getCalls.join(', ')}`);
  assert.ok(dataCall!.startsWith('https://folderfoo.example.com/data/:memz:'), `expected root-of-memz addressing, got: ${dataCall}`);
  assert.equal(fetched?.body, 'live body');
});

test('MemoryRepository.update against a remote folder with a non-empty folderPath writes back to the SAME path get() would read - no 404 mismatch', async (t) => {
  const credsDir = tmpDir('mb-remote-path-creds-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [], [], credsDir, loggedInIdentity());

  const mirrorDir = mirrorDirFor(credsDir, 'dev', 'testuser', 'memz');
  const remote: RemoteFolder = { name: 'memz', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'memz', mirrorDir, mode: 'dev', username: 'testuser' };
  repo.registerRemoteFolder(remote);

  t.mock.method(globalThis, 'fetch', mockFolderfoo([]));
  const doc = await repo.create({ filename: 'ideaz-ideas-list', key: 'ideaz', key_type: 'freeform', doc_type: 'other', description: 'ideas list', body: 'body', folder: 'memz' });
  const filename = path.basename(doc.source_path);

  const updateCalls: string[] = [];
  t.mock.method(globalThis, 'fetch', mockFolderfoo(updateCalls));
  await repo.update('memz', filename, { description: 'updated' });

  const saveCall = updateCalls.find((c) => c.includes('/save/'));
  assert.ok(saveCall, `expected a /save/ call, got: ${updateCalls.join(', ')}`);
  assert.ok(saveCall!.startsWith('https://folderfoo.example.com/save/:memz:'), `update must target the same remote path create() used, got: ${saveCall}`);
});

test('SkillRepository.create against a remote folder with a non-empty folderPath addresses the write inside that folder, not root', async (t) => {
  const credsDir = tmpDir('mb-remote-path-creds-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const repo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }], [], credsDir, loggedInIdentity());

  const mirrorDir = mirrorDirFor(credsDir, 'dev', 'testuser', 'team-qa');
  const remote: RemoteFolder = { name: 'team-qa', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'work/qa', mirrorDir, mode: 'dev', username: 'testuser' };
  repo.registerRemoteFolder(remote);

  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', mockFolderfoo(calls));

  await repo.create(
    { name: 'demo-skill', description: 'Demo. Use when testing.', owner: null, status: 'unreviewed', tags: [], trigger_phrases: [] },
    'Body.',
    undefined,
    'team-qa'
  );

  const saveCall = calls.find((c) => c.includes('/save/'));
  assert.ok(saveCall, `expected a /save/ call, got: ${calls.join(', ')}`);
  assert.ok(
    saveCall!.startsWith(`https://folderfoo.example.com/save/:${encodeURIComponent('work/qa/demo-skill')}:SKILL`),
    `expected the save URL to route into work/qa/demo-skill, got: ${saveCall}`
  );
});

// Regression coverage for a real bug the old id-based design had: a memory doc's remote filename
// used to be its opaque id with the .md extension STRIPPED (to match folderfoo's old stricter
// filename charset), while the local mirror kept the .md extension - so the doc's own remote file
// and its attachments' remote directory (named after the local filename stem) could collide, and
// the local "what folderfoo stored this as" name permanently diverged from the true remote name.
// The fix removes id entirely: the doc's on-disk filename (agent-chosen, e.g. via `filename` on
// create()) is now pushed to folderfoo VERBATIM, extension included - local and remote names are
// always identical by construction, so there's nothing left to diverge or collide.
test('MemoryRepository.create for a REMOTE folder pushes the file under its own filename UNCHANGED, extension included - local and remote names never diverge', async (t) => {
  const credsDir = tmpDir('mb-remote-path-creds-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [], [], credsDir, loggedInIdentity());

  const mirrorDir = mirrorDirFor(credsDir, 'dev', 'testuser', 'memz');
  const remote: RemoteFolder = { name: 'memz', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'memz', mirrorDir, mode: 'dev', username: 'testuser' };
  repo.registerRemoteFolder(remote);

  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', mockFolderfoo(calls));

  const doc = await repo.create({
    filename: 'Ideaz-Placeholder-for-ideas',
    key: 'ideaz',
    key_type: 'freeform',
    doc_type: 'other',
    description: 'Placeholder for ideas to be added later',
    body: 'body',
    folder: 'memz',
  });

  const filename = path.basename(doc.source_path);
  assert.equal(filename, 'Ideaz-Placeholder-for-ideas.md', 'the local filename keeps whatever the caller chose, .md appended');

  const saveCall = calls.find((c) => c.includes('/save/'));
  assert.ok(saveCall, `expected a /save/ call, got: ${calls.join(', ')}`);
  // The address sent to folderfoo must exactly match the doc's own local filename, extension
  // included - no stripping, no divergence between what mem-bucket thinks the file is called and
  // what folderfoo actually stored it as.
  assert.ok(saveCall!.endsWith(`:${filename}`), `expected the save URL to end with the doc's own filename unchanged, got: ${saveCall}`);
});

// Same doc, but in a LOCAL (non-remote) folder - filename behavior is identical either way now
// (no id-driven divergence to guard against), confirming create() doesn't do anything
// remote-specific to the filename itself.
test('MemoryRepository.create for a LOCAL folder keeps the caller-chosen filename unchanged', async () => {
  const localDir = tmpDir('mb-local-');
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'local', path: localDir }], [], undefined);

  const doc = await repo.create({
    filename: 'Ideaz-Placeholder-for-ideas',
    key: 'ideaz',
    key_type: 'freeform',
    doc_type: 'other',
    description: 'Placeholder for ideas to be added later',
    body: 'body',
    folder: 'local',
  });

  assert.equal(path.basename(doc.source_path), 'Ideaz-Placeholder-for-ideas.md');
});

// Regression coverage for a real, confirmed-in-production bug: folderfoo's
// GET /data/:filename returns the RAW file content it stored - the whole
// markdown file, frontmatter block included, since folderfoo has no
// concept of frontmatter/body separation. get() was using that raw content
// directly as `body` with no gray-matter parsing, so every subsequent
// update() wrapped a FRESH frontmatter block around an already-
// frontmattered blob, nesting one level deeper on every single edit. A
// real doc was found with 3 levels of self-nested frontmatter+body after
// 3 edits, with tags reverting to "[]" in the corrupted inner copies while
// only the outermost (least-nested) layer's own tags field ever actually
// changed - which is exactly the "edit doesn't seem to reach the cloud"
// symptom that surfaced this bug (the LOCAL mirror looked edited, but each
// edit's real tags value got buried one layer deeper instead of updating
// what folderfoo already had).
function mockFolderfooWithFrontmatteredContent(calls: string[], fileContent: { current: string }, folders: string[] = ['memz']) {
  return async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.endsWith('/folders')) {
      return mockFolderList(folders);
    }
    if (url.includes('/save/')) {
      fileContent.current = String(init?.body ?? '');
      return { ok: true, status: 200, json: async () => ({ message: 'saved' }) } as Response;
    }
    if (url.includes('/data/')) {
      return { ok: true, status: 200, text: async () => fileContent.current } as Response;
    }
    throw new Error(`unexpected mocked fetch call: ${url} ${JSON.stringify(init)}`);
  };
}

test('MemoryRepository.get strips the frontmatter block from a live-fetched remote file before returning it as body', async (t) => {
  const credsDir = tmpDir('mb-remote-path-creds-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [], [], credsDir, loggedInIdentity());

  const mirrorDir = mirrorDirFor(credsDir, 'dev', 'testuser', 'memz');
  const remote: RemoteFolder = { name: 'memz', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'memz', mirrorDir, mode: 'dev', username: 'testuser' };
  repo.registerRemoteFolder(remote);

  const fileContent = { current: '' };
  t.mock.method(globalThis, 'fetch', mockFolderfooWithFrontmatteredContent([], fileContent));
  const doc = await repo.create({ filename: 'ideaz-test-ideas', key: 'ideaz', key_type: 'freeform', doc_type: 'other', description: 'Test ideas', body: '# Test ideas\n\n- one', folder: 'memz' });
  const filename = path.basename(doc.source_path);

  // Sanity check: what folderfoo "stored" (captured from the save POST body) is a REAL markdown
  // file with a frontmatter block, not a bare body string - this is what a real folderfoo GET
  // /data/:filename response actually looks like.
  assert.match(fileContent.current, /^---\n/);
  assert.match(fileContent.current, /tags: \[\]/);

  const fetched = await repo.get('memz', filename);
  // The bug: fetched.body would be the ENTIRE fileContent.current (frontmatter block included).
  // The fix: it must be exactly the body content, frontmatter stripped.
  assert.equal(fetched?.body, '# Test ideas\n\n- one');
  assert.ok(!fetched?.body.includes('---'), `body must not contain a frontmatter delimiter, got: ${JSON.stringify(fetched?.body)}`);
});

test('MemoryRepository.update after get() does not nest a second frontmatter block into the body (regression for the real corrupted-doc bug)', async (t) => {
  const credsDir = tmpDir('mb-remote-path-creds-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [], [], credsDir, loggedInIdentity());

  const mirrorDir = mirrorDirFor(credsDir, 'dev', 'testuser', 'memz');
  const remote: RemoteFolder = { name: 'memz', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'memz', mirrorDir, mode: 'dev', username: 'testuser' };
  repo.registerRemoteFolder(remote);

  const fileContent = { current: '' };
  t.mock.method(globalThis, 'fetch', mockFolderfooWithFrontmatteredContent([], fileContent));
  const doc = await repo.create({ filename: 'ideaz-test-ideas', key: 'ideaz', key_type: 'freeform', doc_type: 'other', description: 'Test ideas', body: '# Test ideas', folder: 'memz' });
  const filename = path.basename(doc.source_path);

  // Three edits in a row, each changing tags - mirrors the real bug report exactly
  // (editing frontmatter tags via the UI, repeatedly, and the cloud copy never
  // reflecting the latest value because it kept getting buried one layer deeper).
  await repo.update('memz', filename, { tags: ['design'] });
  await repo.update('memz', filename, { tags: ['design', 'urgent'] });
  const final = await repo.update('memz', filename, { tags: ['final'] });

  // The body must still be exactly the original body - no accumulated nested
  // frontmatter+body copies from prior edits.
  assert.equal(final.body, '# Test ideas');
  assert.ok(!final.body.includes('---'), `body must not accumulate frontmatter delimiters across repeated edits, got: ${JSON.stringify(final.body)}`);
  // What was actually sent to folderfoo on the last save must have exactly ONE
  // frontmatter block (one pair of "---" delimiter lines), not nested copies.
  const delimiterLines = fileContent.current.split('\n').filter((line) => line === '---').length;
  assert.equal(delimiterLines, 2, `expected exactly one frontmatter block (2 "---" lines) in the saved file, got ${delimiterLines}:\n${fileContent.current}`);
  assert.match(fileContent.current, /tags:\n\s+- final/, `expected the final tags value ["final"] to actually reach the saved file, got:\n${fileContent.current}`);
});

// Regression coverage for a real bug reported live: MemoryRepository.rename() used to push the
// renamed doc's content to folderfoo via POST /save/:newName (a plain write under the new name)
// and never deleted the old name, leaving a stale DUPLICATE copy behind on folderfoo forever.
// Fixed to use folderfoo's real POST /rename/:filename endpoint (a true in-place rename, handling
// the raw+.meta.json sidecar pair together) instead.
test('MemoryRepository.rename against a remote folder uses folderfoo\'s real rename endpoint, not save-under-new-name (which left a stale duplicate)', async (t) => {
  const credsDir = tmpDir('mb-remote-path-creds-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [], [], credsDir, loggedInIdentity());

  const mirrorDir = mirrorDirFor(credsDir, 'dev', 'testuser', 'memz');
  const remote: RemoteFolder = { name: 'memz', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'memz', mirrorDir, mode: 'dev', username: 'testuser' };
  repo.registerRemoteFolder(remote);

  t.mock.method(globalThis, 'fetch', mockFolderfoo([]));
  const doc = await repo.create({ filename: 'test-ideas-mem2', key: 'K1', key_type: 'freeform', doc_type: 'plan', description: 'd', body: 'b', folder: 'memz' });
  const filename = path.basename(doc.source_path);

  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', mockFolderfoo(calls));
  const renamed = await repo.rename('memz', filename, 'test-ideas-mem2a.md');

  assert.equal(path.basename(renamed.source_path), 'test-ideas-mem2a.md');
  const renameCall = calls.find((c) => c.includes('/rename/'));
  assert.ok(renameCall, `expected a /rename/ call, got: ${calls.join(', ')}`);
  assert.ok(renameCall!.endsWith(`:${filename}`), `expected the rename URL to address the OLD filename, got: ${renameCall}`);
  assert.ok(!calls.some((c) => c.includes('/save/')), `must not write under the new name via /save/ (that's what left the stale duplicate) — calls: ${calls.join(', ')}`);
});

// Regression coverage for a real bug reported live: MemoryRepository.delete() never touched the
// remote copy at all — the doc reappeared on the very next poll (pullFile finds it still on
// folderfoo, since nothing ever told folderfoo it was deleted). Fixed to archive the remote copy
// to folderfoo's trash via POST /trash/:filename BEFORE removing anything locally.
test('MemoryRepository.delete against a remote folder archives the remote copy via /trash/, so it cannot silently reappear on the next poll', async (t) => {
  const credsDir = tmpDir('mb-remote-path-creds-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [], [], credsDir, loggedInIdentity());

  const mirrorDir = mirrorDirFor(credsDir, 'dev', 'testuser', 'memz');
  const remote: RemoteFolder = { name: 'memz', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'memz', mirrorDir, mode: 'dev', username: 'testuser' };
  repo.registerRemoteFolder(remote);

  t.mock.method(globalThis, 'fetch', mockFolderfoo([]));
  const doc = await repo.create({ filename: 'del-test', key: 'K1', key_type: 'freeform', doc_type: 'plan', description: 'd', body: 'b', folder: 'memz' });
  const filename = path.basename(doc.source_path);

  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', mockFolderfoo(calls));
  await repo.delete('memz', filename);

  const trashCall = calls.find((c) => c.includes('/trash/'));
  assert.ok(trashCall, `expected a /trash/ call, got: ${calls.join(', ')}`);
  assert.ok(trashCall!.endsWith(`:${filename}`), `expected the trash URL to address the doc's filename, got: ${trashCall}`);
  assert.ok(!fs.existsSync(doc.source_path), 'local mirror file must be gone too');
});

// Same bug, but for removing a single ATTACHMENT rather than the whole doc: AttachmentRepository.
// remove() only deleted the local file + frontmatter entry, leaving the attachment's remote copy
// (under <stem>/attachments/ on folderfoo) behind forever — reported live as "I removed an
// attachment via the UI but still see it in folderfoo". Fixed via
// MemoryRepository.trashAttachmentIfNeeded, mirroring delete()'s own trashRemoteFile call.
test('AttachmentRepository.remove against a remote-backed memory doc archives the attachment via /trash/', async (t) => {
  const credsDir = tmpDir('mb-remote-path-creds-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const memoryRepo = new MemoryRepository(db, [], [], credsDir, loggedInIdentity());
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }], [], credsDir, loggedInIdentity());
  const attachRepo = new AttachmentRepository(memoryRepo, skillRepo);

  const mirrorDir = mirrorDirFor(credsDir, 'dev', 'testuser', 'memz');
  const remote: RemoteFolder = { name: 'memz', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'memz', mirrorDir, mode: 'dev', username: 'testuser' };
  memoryRepo.registerRemoteFolder(remote);

  t.mock.method(globalThis, 'fetch', mockFolderfoo([]));
  const doc = await memoryRepo.create({ filename: 'attach-del-test', key: 'K1', key_type: 'freeform', doc_type: 'plan', description: 'd', body: 'b', folder: 'memz' });
  const filename = path.basename(doc.source_path);
  await attachRepo.add('memory', 'memz', filename, 'notes.json', Buffer.from('{}'));

  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', mockFolderfoo(calls));
  await attachRepo.remove('memory', 'memz', filename, 'notes.json');

  const trashCall = calls.find((c) => c.includes('/trash/'));
  assert.ok(trashCall, `expected a /trash/ call for the attachment, got: ${calls.join(', ')}`);
  assert.ok(trashCall!.endsWith(':notes.json'), `expected the trash URL to address the attachment's filename, got: ${trashCall}`);

  const updated = await memoryRepo.get('memz', filename);
  assert.equal(updated?.attachments?.length ?? 0, 0, 'the removed attachment must no longer be declared in frontmatter');
});

// Follow-up to the /trash/ fix above: reverting a trashed attachment on folderfoo's own side does
// NOT re-declare it on the doc (folderfoo has no concept of "this file belongs to that doc's
// attachment list" — it only knows the file exists again). Fixed via
// AttachmentRepository.repairUnlistedInFolder, wired as startRemotePolling's onSynced hook (see
// server.ts) — so the next resync that pulls the restored file back into the local mirror also
// re-declares it via the normal remote-first update() path, pushing the healed frontmatter back to
// folderfoo too.
test('a file that reappears in a remote-backed doc\'s attachments/ dir (e.g. restored from folderfoo trash) is re-declared on next resync', async (t) => {
  const credsDir = tmpDir('mb-remote-path-creds-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const memoryRepo = new MemoryRepository(db, [], [], credsDir, loggedInIdentity());
  const skillRepo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }], [], credsDir, loggedInIdentity());
  const attachRepo = new AttachmentRepository(memoryRepo, skillRepo, db);

  const mirrorDir = mirrorDirFor(credsDir, 'dev', 'testuser', 'memz');
  const remote: RemoteFolder = { name: 'memz', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'memz', mirrorDir, mode: 'dev', username: 'testuser' };
  memoryRepo.registerRemoteFolder(remote);

  t.mock.method(globalThis, 'fetch', mockFolderfoo([]));
  const doc = await memoryRepo.create({ filename: 'attach-heal-test', key: 'K1', key_type: 'freeform', doc_type: 'plan', description: 'd', body: 'b', folder: 'memz' });
  const filename = path.basename(doc.source_path);
  await attachRepo.add('memory', 'memz', filename, 'notes.json', Buffer.from('{}'));
  await attachRepo.remove('memory', 'memz', filename, 'notes.json');
  let mid = await memoryRepo.get('memz', filename);
  assert.equal(mid?.attachments?.length ?? 0, 0, 'sanity check: removed and no longer declared');

  // Simulate "restored from folderfoo's trash, then pulled back down by a resync": write the file
  // straight onto the local mirror's attachments/ dir, bypassing AttachmentRepository entirely —
  // this is what pollOne's pullFile would do on finding it in a live changed-since listing.
  const attachDir = path.join(path.dirname(doc.source_path), filename.replace(/\.md$/, ''), 'attachments');
  fs.mkdirSync(attachDir, { recursive: true });
  fs.writeFileSync(path.join(attachDir, 'notes.json'), '{}');

  const memorySpec = memorySyncSpec([{ name: 'memz', path: mirrorDir }]);
  const calls: string[] = [];
  // reconcileDeletions treats anything absent from a live changed-since listing as remotely
  // deleted — for BOTH doc files (walkMarkdownFiles) and, since the attachment-pruning fix, ATTACHMENT
  // files too (walkAttachmentFiles). The doc's own .md file and the reappeared attachment must both
  // be reported present, or the poll would delete them out from under this test before the heal
  // step ever runs — realistic, since a file genuinely restored from folderfoo's trash IS back in
  // folderfoo's live listing, which is how it gets pulled back into the local mirror at all.
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.includes('/folders/last-changed')) return { ok: true, status: 200, json: async () => ({ lastChanged: 1 }) } as Response;
    if (url.includes('/folders/changed-since')) {
      // mtime: 0 on both entries keeps them out of pollOne's re-pull set (getChangedSince filters
      // strictly by mtime > since, and this test forces since=0) while still counting as "present"
      // for reconcileDeletions' plain set-membership checks — so the doc's real local content (with
      // its already-mutated attachments field) and the manually-written attachment file are never
      // overwritten/deleted by this poll.
      return {
        ok: true,
        status: 200,
        json: async () => ({
          files: [
            { name: filename, folderPath: 'memz', mtime: 0 },
            { name: 'notes.json', folderPath: `memz/${filename.replace(/\.md$/, '')}/attachments`, mtime: 0 },
          ],
          serverTime: Date.now(),
        }),
      } as Response;
    }
    return mockFolderfoo(calls)(url, init);
  });
  const poller = startRemotePolling(db, memorySpec, [remote], credsDir, (folder) => attachRepo.repairUnlistedInFolder('memory_docs', folder.name));
  try {
    await poller.resyncNow('memz');
  } finally {
    poller.stop();
  }

  const healed = await memoryRepo.get('memz', filename);
  assert.deepEqual(
    healed?.attachments?.map((a) => a.filename),
    ['notes.json'],
    'the reappeared file must be re-declared in the doc\'s attachments list'
  );
  assert.ok(
    calls.some((c) => c.includes('/save/')),
    `expected the healed frontmatter to be pushed back to folderfoo via /save/, got: ${calls.join(', ')}`
  );
});

// Same bug, for SkillRepository.delete() — skills are directory-based on the remote side
// (<remoteFolderPath>/<skillName>/SKILL.md), so the fix uses DELETE /folders/<skillDir> (trashing
// the whole directory) rather than /trash/:filename (which addresses a single file).
test('SkillRepository.delete against a remote folder archives the remote skill DIRECTORY via DELETE /folders/*', async (t) => {
  const credsDir = tmpDir('mb-remote-path-creds-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const repo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }], [], credsDir, loggedInIdentity());

  const mirrorDir = mirrorDirFor(credsDir, 'dev', 'testuser', 'team-qa');
  const remote: RemoteFolder = { name: 'team-qa', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'work/qa', mirrorDir, mode: 'dev', username: 'testuser' };
  repo.registerRemoteFolder(remote);

  t.mock.method(globalThis, 'fetch', mockFolderfoo([]));
  await repo.create(
    { name: 'del-test-skill', description: 'Demo. Use when testing.', owner: null, status: 'unreviewed', tags: [], trigger_phrases: [] },
    'Body.',
    undefined,
    'team-qa'
  );

  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', mockFolderfoo(calls));
  await repo.delete('del-test-skill', 'team-qa');

  assert.ok(
    calls.some((c) => c.includes('/folders/work/qa/del-test-skill')),
    `expected a DELETE /folders/work/qa/del-test-skill call, got: ${calls.join(', ')}`
  );
});

// Regression coverage for the "remote is the source of truth" ordering: every create/update/rename
// against a remote folder must call folderfoo FIRST and only touch the local mirror on success —
// a remote failure (outage, 4xx, whatever) must leave ZERO local trace, not a local write that
// then gets rolled back. These tests simulate an outage (every fetch call throws) and assert
// nothing local changed at all, rather than asserting a rollback happened.
test('MemoryRepository.create against a remote folder leaves NO local trace when the remote call fails (outage)', async (t) => {
  const credsDir = tmpDir('mb-remote-path-creds-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [], [], credsDir, loggedInIdentity());

  const mirrorDir = mirrorDirFor(credsDir, 'dev', 'testuser', 'memz');
  const remote: RemoteFolder = { name: 'memz', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'memz', mirrorDir, mode: 'dev', username: 'testuser' };
  repo.registerRemoteFolder(remote);

  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('simulated folderfoo outage');
  });

  await assert.rejects(() =>
    repo.create({ filename: 'outage-test', key: 'K1', key_type: 'freeform', doc_type: 'plan', description: 'd', body: 'b', folder: 'memz' })
  );
  assert.ok(!fs.existsSync(path.join(mirrorDir, 'outage-test.md')), 'no local .md file must exist after a failed remote create');
});

test('MemoryRepository.update against a remote folder leaves the local file UNCHANGED when the remote call fails (outage)', async (t) => {
  const credsDir = tmpDir('mb-remote-path-creds-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [], [], credsDir, loggedInIdentity());

  const mirrorDir = mirrorDirFor(credsDir, 'dev', 'testuser', 'memz');
  const remote: RemoteFolder = { name: 'memz', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'memz', mirrorDir, mode: 'dev', username: 'testuser' };
  repo.registerRemoteFolder(remote);

  t.mock.method(globalThis, 'fetch', mockFolderfoo([]));
  const doc = await repo.create({ filename: 'update-outage', key: 'K1', key_type: 'freeform', doc_type: 'plan', description: 'original', body: 'original body', folder: 'memz' });
  const before = fs.readFileSync(doc.source_path, 'utf-8');

  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('simulated folderfoo outage');
  });
  await assert.rejects(() => repo.update('memz', 'update-outage.md', { description: 'CHANGED DURING OUTAGE' }));

  const after = fs.readFileSync(doc.source_path, 'utf-8');
  assert.equal(before, after, 'local file must be byte-for-byte unchanged after a failed remote update');
});
