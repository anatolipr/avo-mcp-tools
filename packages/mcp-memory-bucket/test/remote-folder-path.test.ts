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

function mockFolderfoo(calls: string[]) {
  return async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.includes('/save/')) {
      return { ok: true, status: 200, json: async () => ({ message: 'saved' }) } as Response;
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
  const repo = new MemoryRepository(db, [], [], credsDir);

  const mirrorDir = mirrorDirFor(credsDir, 'memz');
  const remote: RemoteFolder = { name: 'memz', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'memz', mirrorDir };
  repo.registerRemoteFolder(remote);

  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', mockFolderfoo(calls));

  const doc = await repo.create({ key: 'ideaz', key_type: 'freeform', doc_type: 'other', description: 'ideas list', body: 'body', folder: 'memz' });

  const saveCall = calls.find((c) => c.includes('/save/'));
  assert.ok(saveCall, `expected a /save/ call, got: ${calls.join(', ')}`);
  // The 3-part unambiguous grammar (":folderPath:name") must carry "memz",
  // not just the (empty, since this doc has no subfolder within memz) bare id.
  assert.ok(saveCall!.includes(encodeURIComponent('memz')), `expected the save URL to reference the remote folder "memz", got: ${saveCall}`);
  assert.ok(saveCall!.startsWith('https://folderfoo.example.com/save/:memz:'), `expected root-of-memz addressing, got: ${saveCall}`);
  assert.equal(doc.folder, 'memz');
});

test('MemoryRepository.get against a remote folder with a non-empty folderPath reads from inside that folder', async (t) => {
  const credsDir = tmpDir('mb-remote-path-creds-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [], [], credsDir);

  const mirrorDir = mirrorDirFor(credsDir, 'memz');
  const remote: RemoteFolder = { name: 'memz', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'memz', mirrorDir };
  repo.registerRemoteFolder(remote);

  const createCalls: string[] = [];
  t.mock.method(globalThis, 'fetch', mockFolderfoo(createCalls));
  const doc = await repo.create({ key: 'ideaz', key_type: 'freeform', doc_type: 'other', description: 'ideas list', body: 'body', folder: 'memz' });

  const getCalls: string[] = [];
  t.mock.method(globalThis, 'fetch', mockFolderfoo(getCalls));
  const fetched = await repo.get(doc.id);

  const dataCall = getCalls.find((c) => c.includes('/data/'));
  assert.ok(dataCall, `expected a /data/ call, got: ${getCalls.join(', ')}`);
  assert.ok(dataCall!.startsWith('https://folderfoo.example.com/data/:memz:'), `expected root-of-memz addressing, got: ${dataCall}`);
  assert.equal(fetched?.body, 'live body');
});

test('MemoryRepository.update against a remote folder with a non-empty folderPath writes back to the SAME path get() would read - no 404 mismatch', async (t) => {
  const credsDir = tmpDir('mb-remote-path-creds-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [], [], credsDir);

  const mirrorDir = mirrorDirFor(credsDir, 'memz');
  const remote: RemoteFolder = { name: 'memz', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'memz', mirrorDir };
  repo.registerRemoteFolder(remote);

  t.mock.method(globalThis, 'fetch', mockFolderfoo([]));
  const doc = await repo.create({ key: 'ideaz', key_type: 'freeform', doc_type: 'other', description: 'ideas list', body: 'body', folder: 'memz' });

  const updateCalls: string[] = [];
  t.mock.method(globalThis, 'fetch', mockFolderfoo(updateCalls));
  await repo.update(doc.id, { description: 'updated' });

  const saveCall = updateCalls.find((c) => c.includes('/save/'));
  assert.ok(saveCall, `expected a /save/ call, got: ${updateCalls.join(', ')}`);
  assert.ok(saveCall!.startsWith('https://folderfoo.example.com/save/:memz:'), `update must target the same remote path create() used, got: ${saveCall}`);
});

test('SkillRepository.create against a remote folder with a non-empty folderPath addresses the write inside that folder, not root', async (t) => {
  const credsDir = tmpDir('mb-remote-path-creds-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const repo = new SkillRepository(db, [{ name: 'builtin', path: '/nonexistent' }], [], credsDir);

  const mirrorDir = mirrorDirFor(credsDir, 'team-qa');
  const remote: RemoteFolder = { name: 'team-qa', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'work/qa', mirrorDir };
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

// Regression coverage for a real bug: folderfoo's POST /save/:filename
// silently strips every character outside [0-9a-zA-Z_] from the final
// filename segment - hyphens included. MemoryRepository.create()'s
// generated id is `${slugify(key)}-${slugify(description)}-${uuid8}`,
// which always contains hyphens - if the id is used as-is for a REMOTE
// doc's filename, the name mem-bucket thinks the file is called (with
// hyphens) permanently diverges from what folderfoo actually stored it as
// (without hyphens) the instant it's written, and every subsequent get/
// update 404s trying to address the hyphenated name that was never real.
test('MemoryRepository.create for a REMOTE folder generates a hyphen-free id, so the id matches what folderfoo will actually store the file as', async (t) => {
  const credsDir = tmpDir('mb-remote-path-creds-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [], [], credsDir);

  const mirrorDir = mirrorDirFor(credsDir, 'memz');
  const remote: RemoteFolder = { name: 'memz', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'memz', mirrorDir };
  repo.registerRemoteFolder(remote);

  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', mockFolderfoo(calls));

  const doc = await repo.create({
    key: 'ideaz',
    key_type: 'freeform',
    doc_type: 'other',
    description: 'Placeholder for ideas to be added later',
    body: 'body',
    folder: 'memz',
  });

  assert.ok(!doc.id.includes('-'), `remote doc id must not contain hyphens (folderfoo strips them), got: ${doc.id}`);

  const saveCall = calls.find((c) => c.includes('/save/'));
  assert.ok(saveCall, `expected a /save/ call, got: ${calls.join(', ')}`);
  // The address sent to folderfoo must exactly match the doc's own id -
  // no hyphen anywhere in the outgoing filename segment.
  assert.ok(saveCall!.endsWith(`:${doc.id}`), `expected the save URL to end with the doc's own (hyphen-free) id, got: ${saveCall}`);
  assert.ok(!saveCall!.split(':').pop()!.includes('-'), `save URL's filename segment must not contain a hyphen, got: ${saveCall}`);
});

// Same doc, but in a LOCAL (non-remote) folder - the id should keep its
// normal, more-readable hyphenated form. Confirms the hyphen-stripping
// fix is scoped to remote-bound docs only, not a global behavior change.
test('MemoryRepository.create for a LOCAL folder keeps the normal hyphenated id unchanged', async () => {
  const localDir = tmpDir('mb-local-');
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [{ name: 'local', path: localDir }], [], undefined);

  const doc = await repo.create({
    key: 'ideaz',
    key_type: 'freeform',
    doc_type: 'other',
    description: 'Placeholder for ideas to be added later',
    body: 'body',
    folder: 'local',
  });

  assert.ok(doc.id.includes('-'), `local doc id should keep its normal hyphenated form, got: ${doc.id}`);
  assert.match(doc.id, /^ideaz-placeholder-for-ideas-to-be-added-later-[0-9a-f]{8}$/);
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
function mockFolderfooWithFrontmatteredContent(calls: string[], fileContent: { current: string }) {
  return async (url: string, init?: RequestInit) => {
    calls.push(url);
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
  const repo = new MemoryRepository(db, [], [], credsDir);

  const mirrorDir = mirrorDirFor(credsDir, 'memz');
  const remote: RemoteFolder = { name: 'memz', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'memz', mirrorDir };
  repo.registerRemoteFolder(remote);

  const fileContent = { current: '' };
  t.mock.method(globalThis, 'fetch', mockFolderfooWithFrontmatteredContent([], fileContent));
  const doc = await repo.create({ key: 'ideaz', key_type: 'freeform', doc_type: 'other', description: 'Test ideas', body: '# Test ideas\n\n- one', folder: 'memz' });

  // Sanity check: what folderfoo "stored" (captured from the save POST body) is a REAL markdown
  // file with a frontmatter block, not a bare body string - this is what a real folderfoo GET
  // /data/:filename response actually looks like.
  assert.match(fileContent.current, /^---\n/);
  assert.match(fileContent.current, /tags: \[\]/);

  const fetched = await repo.get(doc.id);
  // The bug: fetched.body would be the ENTIRE fileContent.current (frontmatter block included).
  // The fix: it must be exactly the body content, frontmatter stripped.
  assert.equal(fetched?.body, '# Test ideas\n\n- one');
  assert.ok(!fetched?.body.includes('---'), `body must not contain a frontmatter delimiter, got: ${JSON.stringify(fetched?.body)}`);
});

test('MemoryRepository.update after get() does not nest a second frontmatter block into the body (regression for the real corrupted-doc bug)', async (t) => {
  const credsDir = tmpDir('mb-remote-path-creds-');
  setCredential(credsDir, 'https://folderfoo.example.com', 'jwt-1');
  const db = openCache(':memory:');
  const repo = new MemoryRepository(db, [], [], credsDir);

  const mirrorDir = mirrorDirFor(credsDir, 'memz');
  const remote: RemoteFolder = { name: 'memz', server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'memz', mirrorDir };
  repo.registerRemoteFolder(remote);

  const fileContent = { current: '' };
  t.mock.method(globalThis, 'fetch', mockFolderfooWithFrontmatteredContent([], fileContent));
  const doc = await repo.create({ key: 'ideaz', key_type: 'freeform', doc_type: 'other', description: 'Test ideas', body: '# Test ideas', folder: 'memz' });

  // Three edits in a row, each changing tags - mirrors the real bug report exactly
  // (editing frontmatter tags via the UI, repeatedly, and the cloud copy never
  // reflecting the latest value because it kept getting buried one layer deeper).
  await repo.update(doc.id, { tags: ['design'] });
  await repo.update(doc.id, { tags: ['design', 'urgent'] });
  const final = await repo.update(doc.id, { tags: ['final'] });

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
