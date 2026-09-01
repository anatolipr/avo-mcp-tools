import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { attachmentsDirFor, writeAttachmentFile, ATTACHMENT_MAX_BYTES } from '../src/attachments/storage.js';
import { openCache } from '../src/store/db.js';
import { MemoryRepository } from '../src/memory/repository.js';
import { SkillRepository } from '../src/skills/repository.js';
import { AttachmentRepository } from '../src/attachments/repository.js';
import { walkMarkdownFiles } from '../src/store/sync.js';
import { registerAttachmentTools } from '../src/attachments/tools.js';

function setupMemoryRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-repo-test-'));
  const db = openCache(':memory:');
  const folders = [{ name: 'mem', path: dir }];
  const memoryRepo = new MemoryRepository(db, folders);
  return { dir, memoryRepo };
}

function setupSkillRepo() {
  const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-skill-repo-test-'));
  const db = openCache(':memory:');
  const folders = [{ name: 'builtin', path: '/nonexistent' }, { name: 'folder', path: skillDir }];
  const skillRepo = new SkillRepository(db, folders);
  return { skillDir, skillRepo };
}

test('attachmentsDirFor: skill doc uses <skillDir>/attachments', () => {
  const sourcePath = '/base/my-skill/SKILL.md';
  assert.equal(attachmentsDirFor(sourcePath, 'skill'), path.join('/base/my-skill', 'attachments'));
});

test('attachmentsDirFor: memory doc uses <memoryFolder>/<filename>/attachments', () => {
  const sourcePath = '/base/abc123.md';
  assert.equal(attachmentsDirFor(sourcePath, 'memory'), path.join('/base', 'abc123', 'attachments'));
});

test('writeAttachmentFile: writes file and returns entry metadata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-test-'));
  const entry = writeAttachmentFile(dir, 'foo.json', Buffer.from('{"a":1}'));
  assert.equal(entry.filename, 'foo.json');
  assert.equal(entry.path, path.join('attachments', 'foo.json'));
  assert.ok(fs.existsSync(path.join(dir, 'foo.json')));
});

test('writeAttachmentFile: auto-renames on collision', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-test-'));
  writeAttachmentFile(dir, 'foo.json', Buffer.from('first'));
  const second = writeAttachmentFile(dir, 'foo.json', Buffer.from('second'));
  assert.equal(second.filename, 'foo-2.json');
  assert.equal(fs.readFileSync(path.join(dir, 'foo-2.json'), 'utf-8'), 'second');
});

test('writeAttachmentFile: supports a nested relative filename, creating intermediate directories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-test-'));
  const entry = writeAttachmentFile(dir, 'references/foo.md', Buffer.from('nested content'));
  assert.equal(entry.filename, 'references/foo.md');
  assert.equal(entry.path, path.join('attachments', 'references', 'foo.md'));
  assert.ok(fs.existsSync(path.join(dir, 'references', 'foo.md')));
  assert.equal(fs.readFileSync(path.join(dir, 'references', 'foo.md'), 'utf-8'), 'nested content');
});

test('writeAttachmentFile: auto-renames a nested path on collision, keeping the subdirectory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-test-'));
  writeAttachmentFile(dir, 'references/foo.md', Buffer.from('first'));
  const second = writeAttachmentFile(dir, 'references/foo.md', Buffer.from('second'));
  assert.equal(second.filename, path.join('references', 'foo-2.md'));
  assert.ok(fs.existsSync(path.join(dir, 'references', 'foo-2.md')));
  assert.equal(fs.readFileSync(path.join(dir, 'references', 'foo-2.md'), 'utf-8'), 'second');
});

test('writeAttachmentFile: rejects files over the size limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-test-'));
  const tooBig = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1);
  assert.throws(() => writeAttachmentFile(dir, 'big.bin', tooBig), /exceeds/);
});

test('writeAttachmentFile: rejects path-traversal attempts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-test-'));
  assert.throws(() => writeAttachmentFile(dir, '../../evil.txt', Buffer.from('malicious')), /escapes/);
  assert.throws(() => writeAttachmentFile(dir, '../evil.txt', Buffer.from('malicious')), /escapes/);
});

test('AttachmentRepository.add: creates file and updates doc frontmatter', async () => {
  const { memoryRepo } = setupMemoryRepo();
  const doc = await memoryRepo.create({ filename: 'test-1', key: 'TEST-1', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const filename = path.basename(doc.source_path);
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any); // skillRepo unused in this test
  const entry = await attachRepo.add('memory', 'mem', filename, 'data.json', Buffer.from('{}'));
  assert.equal(entry.filename, 'data.json');
  const updated = (await memoryRepo.get('mem', filename))!;
  assert.deepEqual(updated.attachments, [entry]);
});

test('AttachmentRepository.list: returns frontmatter-declared attachments', async () => {
  const { memoryRepo } = setupMemoryRepo();
  const doc = await memoryRepo.create({ filename: 'test-2', key: 'TEST-2', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const filename = path.basename(doc.source_path);
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  await attachRepo.add('memory', 'mem', filename, 'a.json', Buffer.from('{}'));
  await attachRepo.add('memory', 'mem', filename, 'b.json', Buffer.from('{}'));
  assert.equal((await attachRepo.list('memory', 'mem', filename)).length, 2);
});

test('AttachmentRepository.update: replaces content in place', async () => {
  const { memoryRepo } = setupMemoryRepo();
  const doc = await memoryRepo.create({ filename: 'test-3', key: 'TEST-3', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const filename = path.basename(doc.source_path);
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  await attachRepo.add('memory', 'mem', filename, 'data.json', Buffer.from('{"v":1}'));
  const updated = await attachRepo.update('memory', 'mem', filename, 'data.json', Buffer.from('{"v":2}'));
  assert.equal(updated.filename, 'data.json');
  const dir = attachmentsDirFor((await memoryRepo.get('mem', filename))!.source_path, 'memory');
  assert.equal(fs.readFileSync(path.join(dir, 'data.json'), 'utf-8'), '{"v":2}');
});

test('AttachmentRepository.remove: deletes file and frontmatter entry', async () => {
  const { memoryRepo } = setupMemoryRepo();
  const doc = await memoryRepo.create({ filename: 'test-4', key: 'TEST-4', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const filename = path.basename(doc.source_path);
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  await attachRepo.add('memory', 'mem', filename, 'data.json', Buffer.from('{}'));
  await attachRepo.remove('memory', 'mem', filename, 'data.json');
  assert.equal((await memoryRepo.get('mem', filename))!.attachments?.length, 0);
});

test('AttachmentRepository.reconcile: flags orphans and unlisted files', async () => {
  const { memoryRepo } = setupMemoryRepo();
  const doc = await memoryRepo.create({ filename: 'test-5', key: 'TEST-5', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const filename = path.basename(doc.source_path);
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  await attachRepo.add('memory', 'mem', filename, 'tracked.json', Buffer.from('{}'));
  const dir = attachmentsDirFor((await memoryRepo.get('mem', filename))!.source_path, 'memory');
  fs.rmSync(path.join(dir, 'tracked.json'));
  fs.writeFileSync(path.join(dir, 'stray.json'), '{}');
  const result = await attachRepo.reconcile('memory', 'mem', filename);
  assert.deepEqual(result.orphans, ['tracked.json']);
  assert.deepEqual(result.unlisted, ['stray.json']);
});

test('AttachmentRepository.reconcileToDisk: drops orphans and adds unlisted files in one pass', async () => {
  const { memoryRepo } = setupMemoryRepo();
  const doc = await memoryRepo.create({ filename: 'test-5b', key: 'TEST-5B', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const filename = path.basename(doc.source_path);
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  await attachRepo.add('memory', 'mem', filename, 'tracked.json', Buffer.from('{}'));
  const dir = attachmentsDirFor((await memoryRepo.get('mem', filename))!.source_path, 'memory');
  fs.rmSync(path.join(dir, 'tracked.json'));
  fs.writeFileSync(path.join(dir, 'stray.json'), '{}');

  const result = await attachRepo.reconcileToDisk('memory', 'mem', filename);
  assert.deepEqual(result.removed, ['tracked.json']);
  assert.deepEqual(result.added.map((a) => a.filename), ['stray.json']);

  const updated = await memoryRepo.get('mem', filename);
  assert.deepEqual(updated?.attachments?.map((a) => a.filename), ['stray.json'], 'declared list must exactly match disk after reconcileToDisk');
});

test('AttachmentRepository.reconcileToDisk: no-op (no update() call) when declared already matches disk', async () => {
  const { memoryRepo } = setupMemoryRepo();
  const doc = await memoryRepo.create({ filename: 'test-5c', key: 'TEST-5C', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const filename = path.basename(doc.source_path);
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  await attachRepo.add('memory', 'mem', filename, 'tracked.json', Buffer.from('{}'));

  const result = await attachRepo.reconcileToDisk('memory', 'mem', filename);
  assert.deepEqual(result, { added: [], removed: [] });
});

// Regression coverage for a real bug: repairUnlistedInFolder resolved a memory doc's identity via
// path.basename(row.source_path) — just the bare filename, dropping any subfolder. For a doc
// living in a subfolder of the configured folder (e.g. "sub/DOC.md"), that reconstructs the WRONG
// (nonexistent) path at the folder root and 404s in getDoc, logged as "failed to repair
// attachments... not found" for every such doc on every resync. Fixed to use
// memoryRepo.splitSourcePath() (the same helper the web UI's splitMemoryId route handler already
// uses for this identical problem), which correctly preserves the subfolder.
test('AttachmentRepository.repairUnlistedInFolder: resolves a memory doc living in a SUBFOLDER of the configured folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-repo-test-'));
  const db = openCache(':memory:');
  const memoryRepo = new MemoryRepository(db, [{ name: 'mem', path: dir }]);
  const { initialScan, memorySyncSpec } = await import('../src/store/sync.js');

  const doc = await memoryRepo.create({
    filename: 'sub-doc',
    key: 'SUB-1',
    key_type: 'ticket',
    doc_type: 'other',
    description: 'd',
    body: 'b',
    subfolder: 'sub',
  });
  assert.ok(doc.source_path.includes(`${path.sep}sub${path.sep}`), 'sanity check: doc really is in a subfolder');
  initialScan(db, memorySyncSpec([{ name: 'mem', path: dir }]));

  // Drop a file straight onto disk under the doc's attachments/ dir, bypassing AttachmentRepository
  // entirely — same as a file reappearing via an external sync, which is what repairUnlistedInFolder
  // exists to catch.
  const attachDir = attachmentsDirFor(doc.source_path, 'memory');
  fs.mkdirSync(attachDir, { recursive: true });
  fs.writeFileSync(path.join(attachDir, 'notes.json'), '{}');

  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any, db);
  await attachRepo.repairUnlistedInFolder('memory_docs', 'mem');

  const updated = await memoryRepo.get('mem', path.relative(dir, doc.source_path));
  assert.deepEqual(updated?.attachments?.map((a) => a.filename), ['notes.json'], 'the subfolder doc must be correctly resolved and healed, not 404');
});

test('MemoryRepository.delete: cascades to attachments directory', async () => {
  const { memoryRepo } = setupMemoryRepo();
  const doc = await memoryRepo.create({ filename: 'test-6', key: 'TEST-6', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const filename = path.basename(doc.source_path);
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  await attachRepo.add('memory', 'mem', filename, 'data.json', Buffer.from('{}'));
  const dir = attachmentsDirFor((await memoryRepo.get('mem', filename))!.source_path, 'memory');
  assert.ok(fs.existsSync(dir));
  await memoryRepo.delete('mem', filename);
  assert.ok(!fs.existsSync(dir));
});

test('walkMarkdownFiles: skips attachments directories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-test-'));
  fs.writeFileSync(path.join(dir, 'doc.md'), '---\nkey: X\n---\nbody');
  fs.mkdirSync(path.join(dir, 'doc-id', 'attachments'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'doc-id', 'attachments', 'nested.md'), '---\n---\nshould not be indexed');
  const found = [...walkMarkdownFiles(dir)];
  assert.ok(found.some((f) => f.endsWith('doc.md')));
  assert.ok(!found.some((f) => f.includes('attachments')));
});

test('registerAttachmentTools: registers all six attachment tools', () => {
  const registered: string[] = [];
  const fakeMcp = { tool: (name: string) => registered.push(name) } as any;
  const { memoryRepo } = setupMemoryRepo();
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  registerAttachmentTools(fakeMcp, attachRepo);
  assert.deepEqual(registered.sort(), [
    'attachment_add', 'attachment_get', 'attachment_list',
    'attachment_reconcile', 'attachment_remove', 'attachment_update',
  ]);
});

test('AttachmentRepository.absolutePathFor: joins the attachments dir with the filename', async () => {
  const { memoryRepo } = setupMemoryRepo();
  const doc = await memoryRepo.create({ filename: 'test-7', key: 'TEST-7', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const filename = path.basename(doc.source_path);
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  await attachRepo.add('memory', 'mem', filename, 'data.json', Buffer.from('{}'));
  const dir = attachmentsDirFor((await memoryRepo.get('mem', filename))!.source_path, 'memory');
  const absolutePath = await attachRepo.absolutePathFor('memory', 'mem', filename, 'data.json');
  assert.equal(absolutePath, path.join(dir, 'data.json'));
  assert.ok(path.isAbsolute(absolutePath));
  assert.ok(fs.existsSync(absolutePath));
});

function collectTools(attachRepo: AttachmentRepository) {
  const handlers: Record<string, (args: any) => Promise<any>> = {};
  const fakeMcp = { tool: (name: string, _desc: string, _schema: any, handler: any) => { handlers[name] = handler; } } as any;
  registerAttachmentTools(fakeMcp, attachRepo);
  return handlers;
}

test('attachment_add tool: response absolute_path is absolute and resolves to the written file', async () => {
  const { dir, memoryRepo } = setupMemoryRepo();
  const doc = await memoryRepo.create({ filename: 'test-8', key: 'TEST-8', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const filename = path.basename(doc.source_path);
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  const handlers = collectTools(attachRepo);

  const srcFile = path.join(dir, 'source.json');
  fs.writeFileSync(srcFile, '{"v":1}');

  const result = await handlers.attachment_add({ kind: 'memory', folder: 'mem', doc: filename, filename: 'data.json', file_path: srcFile });
  const entry = JSON.parse(result.content[0].text);
  assert.ok(path.isAbsolute(entry.absolute_path));
  assert.ok(fs.existsSync(entry.absolute_path));
  assert.equal(fs.readFileSync(entry.absolute_path, 'utf-8'), '{"v":1}');
});

test('attachment_get tool: response absolute_path matches the known attachments dir and resolves on disk', async () => {
  const { dir, memoryRepo } = setupMemoryRepo();
  const doc = await memoryRepo.create({ filename: 'test-9', key: 'TEST-9', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const filename = path.basename(doc.source_path);
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  await attachRepo.add('memory', 'mem', filename, 'data.json', Buffer.from('{"v":1}'));
  const handlers = collectTools(attachRepo);

  const result = await handlers.attachment_get({ kind: 'memory', folder: 'mem', doc: filename, filename: 'data.json' });
  const entry = JSON.parse(result.content[0].text);
  const expectedDir = attachmentsDirFor((await memoryRepo.get('mem', filename))!.source_path, 'memory');
  assert.equal(entry.absolute_path, path.join(expectedDir, 'data.json'));
  assert.ok(path.isAbsolute(entry.absolute_path));
  assert.ok(fs.existsSync(entry.absolute_path));
  void dir;
});

test('attachment_update tool: response absolute_path resolves to the updated file', async () => {
  const { dir, memoryRepo } = setupMemoryRepo();
  const doc = await memoryRepo.create({ filename: 'test-10', key: 'TEST-10', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const filename = path.basename(doc.source_path);
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  await attachRepo.add('memory', 'mem', filename, 'data.json', Buffer.from('{"v":1}'));
  const handlers = collectTools(attachRepo);

  const srcFile = path.join(dir, 'updated.json');
  fs.writeFileSync(srcFile, '{"v":2}');
  const result = await handlers.attachment_update({ kind: 'memory', folder: 'mem', doc: filename, filename: 'data.json', file_path: srcFile });
  const entry = JSON.parse(result.content[0].text);
  assert.ok(path.isAbsolute(entry.absolute_path));
  assert.equal(fs.readFileSync(entry.absolute_path, 'utf-8'), '{"v":2}');
});

test('attachment_list tool: every entry includes a resolvable absolute_path', async () => {
  const { memoryRepo } = setupMemoryRepo();
  const doc = await memoryRepo.create({ filename: 'test-11', key: 'TEST-11', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const filename = path.basename(doc.source_path);
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  await attachRepo.add('memory', 'mem', filename, 'a.json', Buffer.from('{}'));
  await attachRepo.add('memory', 'mem', filename, 'b.json', Buffer.from('{}'));
  const handlers = collectTools(attachRepo);

  const result = await handlers.attachment_list({ kind: 'memory', folder: 'mem', doc: filename });
  const entries = JSON.parse(result.content[0].text);
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.ok(path.isAbsolute(entry.absolute_path));
    assert.ok(fs.existsSync(entry.absolute_path));
  }
});

// --- C1: path-traversal hardening on remove()/update() ---

test('AttachmentRepository.remove: throws on path-traversal filename and does not delete outside files', async () => {
  const { dir, memoryRepo } = setupMemoryRepo();
  const doc = await memoryRepo.create({ filename: 'test-12', key: 'TEST-12', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const filename = path.basename(doc.source_path);
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  await attachRepo.add('memory', 'mem', filename, 'data.json', Buffer.from('{}'));

  // A real file outside the attachments dir, at the same relative depth a
  // '../../evil.txt' traversal from <memFolder>/<filename>/attachments would reach.
  const victim = path.join(dir, 'VICTIM.txt');
  fs.writeFileSync(victim, 'do not delete me');

  await assert.rejects(() => attachRepo.remove('memory', 'mem', filename, '../../VICTIM.txt'), /escapes/);
  assert.ok(fs.existsSync(victim), 'victim file outside the attachments dir must survive');
  // The legitimate attachment must be untouched too.
  assert.equal((await memoryRepo.get('mem', filename))!.attachments?.length, 1);
});

test('AttachmentRepository.update: throws on path-traversal filename and does not delete outside files', async () => {
  const { dir, memoryRepo } = setupMemoryRepo();
  const doc = await memoryRepo.create({ filename: 'test-13', key: 'TEST-13', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const filename = path.basename(doc.source_path);
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);

  // Directly inject a malicious declared filename into the doc's attachments list — this is the
  // shape update()'s "existing entry" lookup needs to proceed past its not-found guard and reach
  // the vulnerable rmSync call, mirroring how an already-declared attachment with a traversal-y
  // name (e.g. synced in from disk, or added before this fix existed) could be updated.
  await memoryRepo.update('mem', filename, {
    attachments: [{ filename: '../../VICTIM2.txt', path: 'attachments/VICTIM2.txt', added_at: new Date().toISOString() }],
  } as any);

  const victim = path.join(dir, 'VICTIM2.txt');
  fs.writeFileSync(victim, 'do not delete me');

  await assert.rejects(() => attachRepo.update('memory', 'mem', filename, '../../VICTIM2.txt', Buffer.from('new')), /escapes/);
  assert.ok(fs.existsSync(victim), 'victim file outside the attachments dir must survive');
});

// --- I2: memory doc delete removes the wrapper directory, not just attachments/ ---

test('MemoryRepository.delete: removes the wrapper directory entirely, not just attachments/', async () => {
  const { memoryRepo } = setupMemoryRepo();
  const doc = await memoryRepo.create({ filename: 'test-14', key: 'TEST-14', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const filename = path.basename(doc.source_path);
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  await attachRepo.add('memory', 'mem', filename, 'data.json', Buffer.from('{}'));

  const attachmentsDir = attachmentsDirFor((await memoryRepo.get('mem', filename))!.source_path, 'memory');
  const wrapperDir = path.dirname(attachmentsDir);
  assert.ok(fs.existsSync(wrapperDir));

  await memoryRepo.delete('mem', filename);

  assert.ok(!fs.existsSync(attachmentsDir));
  assert.ok(!fs.existsSync(wrapperDir), 'wrapper directory must not be left behind');
});

// --- I3: attachment_add/update stat-check before reading full file bytes ---

test('attachment_add tool: rejects an oversized file via stat check without reading its bytes', async () => {
  const { dir, memoryRepo } = setupMemoryRepo();
  const doc = await memoryRepo.create({ filename: 'test-15', key: 'TEST-15', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const filename = path.basename(doc.source_path);
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  const handlers = collectTools(attachRepo);

  const bigFile = path.join(dir, 'huge.bin');
  // Sparse file: seek past the limit and write one byte, so the file *reports* as
  // over-limit-sized without actually consuming that much disk or memory.
  const fd = fs.openSync(bigFile, 'w');
  fs.writeSync(fd, Buffer.from('x'), 0, 1, ATTACHMENT_MAX_BYTES + 1);
  fs.closeSync(fd);
  assert.ok(fs.statSync(bigFile).size > ATTACHMENT_MAX_BYTES);

  const originalReadFileSync = fs.readFileSync;
  let readFileSyncCalled = false;
  (fs as any).readFileSync = (...args: any[]) => {
    readFileSyncCalled = true;
    return originalReadFileSync.apply(fs, args as any);
  };
  try {
    const result = await handlers.attachment_add({ kind: 'memory', folder: 'mem', doc: filename, filename: 'huge.bin', file_path: bigFile });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /exceeds/);
    assert.equal(readFileSyncCalled, false, 'readFileSync must not be called once the stat check rejects the file');
  } finally {
    (fs as any).readFileSync = originalReadFileSync;
  }
});

test('attachment_update tool: rejects an oversized file via stat check without reading its bytes', async () => {
  const { dir, memoryRepo } = setupMemoryRepo();
  const doc = await memoryRepo.create({ filename: 'test-16', key: 'TEST-16', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const filename = path.basename(doc.source_path);
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  await attachRepo.add('memory', 'mem', filename, 'data.json', Buffer.from('{}'));
  const handlers = collectTools(attachRepo);

  const bigFile = path.join(dir, 'huge2.bin');
  const fd = fs.openSync(bigFile, 'w');
  fs.writeSync(fd, Buffer.from('x'), 0, 1, ATTACHMENT_MAX_BYTES + 1);
  fs.closeSync(fd);

  const originalReadFileSync = fs.readFileSync;
  let readFileSyncCalled = false;
  (fs as any).readFileSync = (...args: any[]) => {
    readFileSyncCalled = true;
    return originalReadFileSync.apply(fs, args as any);
  };
  try {
    const result = await handlers.attachment_update({ kind: 'memory', folder: 'mem', doc: filename, filename: 'data.json', file_path: bigFile });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /exceeds/);
    assert.equal(readFileSyncCalled, false, 'readFileSync must not be called once the stat check rejects the file');
  } finally {
    (fs as any).readFileSync = originalReadFileSync;
  }
});

// --- skill-kind coverage: end-to-end via SkillRepository (previously untested) ---

test('AttachmentRepository: skill-kind add/list/cascade-delete end-to-end', async () => {
  const { skillRepo } = setupSkillRepo();
  const skill = await skillRepo.create(
    { name: 'demo-skill-attach', description: 'Demo skill for attachment coverage. Use when testing.', owner: null, status: 'unreviewed', tags: [], trigger_phrases: [] },
    'Body text.'
  );
  const attachRepo = new AttachmentRepository(undefined as any, skillRepo);

  const entry = await attachRepo.add('skill', skill.folder, skill.name, 'notes.txt', Buffer.from('hello'));
  assert.equal(entry.filename, 'notes.txt');

  const listed = await attachRepo.list('skill', skill.folder, skill.name);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.filename, 'notes.txt');

  const attachmentsDir = attachmentsDirFor((await skillRepo.get(skill.name))!.source_path, 'skill');
  assert.ok(fs.existsSync(path.join(attachmentsDir, 'notes.txt')));

  await skillRepo.delete(skill.name);

  assert.ok(!fs.existsSync(attachmentsDir), 'skill delete must cascade-remove the attachments dir');
  assert.equal(await skillRepo.get(skill.name), null);
});

test('AttachmentRepository: nested attachment path round-trips through add/list/remove, cleaning up its now-empty subdirectory', async () => {
  const { skillRepo } = setupSkillRepo();
  const skill = await skillRepo.create(
    { name: 'demo-skill-nested-attach', description: 'Demo skill for nested attachment coverage. Use when testing.', owner: null, status: 'unreviewed', tags: [], trigger_phrases: [] },
    'Body text.'
  );
  const attachRepo = new AttachmentRepository(undefined as any, skillRepo);

  const entry = await attachRepo.add('skill', skill.folder, skill.name, 'references/foo.md', Buffer.from('nested'));
  assert.equal(entry.filename, 'references/foo.md');

  const attachmentsDir = attachmentsDirFor((await skillRepo.get(skill.name))!.source_path, 'skill');
  const nestedFile = path.join(attachmentsDir, 'references', 'foo.md');
  assert.ok(fs.existsSync(nestedFile));

  const listed = await attachRepo.list('skill', skill.folder, skill.name);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.filename, 'references/foo.md');

  await attachRepo.remove('skill', skill.folder, skill.name, 'references/foo.md');
  assert.ok(!fs.existsSync(nestedFile), 'the file itself must be removed');
  assert.ok(!fs.existsSync(path.join(attachmentsDir, 'references')), 'the now-empty references/ subdirectory must be cleaned up');
  assert.ok(!fs.existsSync(attachmentsDir), 'attachments/ itself must be removed once fully empty');
});
