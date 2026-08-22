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

test('attachmentsDirFor: memory doc uses <memoryFolder>/<id>/attachments', () => {
  const sourcePath = '/base/abc123.md';
  assert.equal(attachmentsDirFor(sourcePath, 'memory'), path.join('/base', 'abc123', 'attachments'));
});

test('writeAttachmentFile: writes file and returns entry with computed size/mime', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-test-'));
  const entry = writeAttachmentFile(dir, 'foo.json', Buffer.from('{"a":1}'));
  assert.equal(entry.filename, 'foo.json');
  assert.equal(entry.path, path.join('attachments', 'foo.json'));
  assert.equal(entry.mime_type, 'application/json');
  assert.equal(entry.size, Buffer.byteLength('{"a":1}'));
  assert.ok(fs.existsSync(path.join(dir, 'foo.json')));
});

test('writeAttachmentFile: auto-renames on collision', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-test-'));
  writeAttachmentFile(dir, 'foo.json', Buffer.from('first'));
  const second = writeAttachmentFile(dir, 'foo.json', Buffer.from('second'));
  assert.equal(second.filename, 'foo-2.json');
  assert.equal(fs.readFileSync(path.join(dir, 'foo-2.json'), 'utf-8'), 'second');
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

test('AttachmentRepository.add: creates file and updates doc frontmatter', () => {
  const { memoryRepo } = setupMemoryRepo();
  const doc = memoryRepo.create({ key: 'TEST-1', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any); // skillRepo unused in this test
  const entry = attachRepo.add('memory', doc.id, 'data.json', Buffer.from('{}'));
  assert.equal(entry.filename, 'data.json');
  const updated = memoryRepo.get(doc.id)!;
  assert.deepEqual(updated.attachments, [entry]);
});

test('AttachmentRepository.list: returns frontmatter-declared attachments', () => {
  const { memoryRepo } = setupMemoryRepo();
  const doc = memoryRepo.create({ key: 'TEST-2', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  attachRepo.add('memory', doc.id, 'a.json', Buffer.from('{}'));
  attachRepo.add('memory', doc.id, 'b.json', Buffer.from('{}'));
  assert.equal(attachRepo.list('memory', doc.id).length, 2);
});

test('AttachmentRepository.update: replaces content and re-detects mime', () => {
  const { memoryRepo } = setupMemoryRepo();
  const doc = memoryRepo.create({ key: 'TEST-3', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  attachRepo.add('memory', doc.id, 'data.json', Buffer.from('{"v":1}'));
  const updated = attachRepo.update('memory', doc.id, 'data.json', Buffer.from('{"v":2}'));
  assert.equal(updated.size, Buffer.byteLength('{"v":2}'));
  const dir = attachmentsDirFor(memoryRepo.get(doc.id)!.source_path, 'memory');
  assert.equal(fs.readFileSync(path.join(dir, 'data.json'), 'utf-8'), '{"v":2}');
});

test('AttachmentRepository.remove: deletes file and frontmatter entry', () => {
  const { memoryRepo } = setupMemoryRepo();
  const doc = memoryRepo.create({ key: 'TEST-4', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  attachRepo.add('memory', doc.id, 'data.json', Buffer.from('{}'));
  attachRepo.remove('memory', doc.id, 'data.json');
  assert.equal(memoryRepo.get(doc.id)!.attachments?.length, 0);
});

test('AttachmentRepository.reconcile: flags orphans and unlisted files', () => {
  const { memoryRepo } = setupMemoryRepo();
  const doc = memoryRepo.create({ key: 'TEST-5', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  attachRepo.add('memory', doc.id, 'tracked.json', Buffer.from('{}'));
  const dir = attachmentsDirFor(memoryRepo.get(doc.id)!.source_path, 'memory');
  fs.rmSync(path.join(dir, 'tracked.json'));
  fs.writeFileSync(path.join(dir, 'stray.json'), '{}');
  const result = attachRepo.reconcile('memory', doc.id);
  assert.deepEqual(result.orphans, ['tracked.json']);
  assert.deepEqual(result.unlisted, ['stray.json']);
});

test('MemoryRepository.delete: cascades to attachments directory', () => {
  const { memoryRepo } = setupMemoryRepo();
  const doc = memoryRepo.create({ key: 'TEST-6', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  attachRepo.add('memory', doc.id, 'data.json', Buffer.from('{}'));
  const dir = attachmentsDirFor(memoryRepo.get(doc.id)!.source_path, 'memory');
  assert.ok(fs.existsSync(dir));
  memoryRepo.delete(doc.id);
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

test('AttachmentRepository.absolutePathFor: joins the attachments dir with the filename', () => {
  const { memoryRepo } = setupMemoryRepo();
  const doc = memoryRepo.create({ key: 'TEST-7', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  attachRepo.add('memory', doc.id, 'data.json', Buffer.from('{}'));
  const dir = attachmentsDirFor(memoryRepo.get(doc.id)!.source_path, 'memory');
  const absolutePath = attachRepo.absolutePathFor('memory', doc.id, 'data.json');
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
  const doc = memoryRepo.create({ key: 'TEST-8', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  const handlers = collectTools(attachRepo);

  const srcFile = path.join(dir, 'source.json');
  fs.writeFileSync(srcFile, '{"v":1}');

  const result = await handlers.attachment_add({ kind: 'memory', doc: doc.id, filename: 'data.json', file_path: srcFile });
  const entry = JSON.parse(result.content[0].text);
  assert.ok(path.isAbsolute(entry.absolute_path));
  assert.ok(fs.existsSync(entry.absolute_path));
  assert.equal(fs.readFileSync(entry.absolute_path, 'utf-8'), '{"v":1}');
});

test('attachment_get tool: response absolute_path matches the known attachments dir and resolves on disk', async () => {
  const { dir, memoryRepo } = setupMemoryRepo();
  const doc = memoryRepo.create({ key: 'TEST-9', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  attachRepo.add('memory', doc.id, 'data.json', Buffer.from('{"v":1}'));
  const handlers = collectTools(attachRepo);

  const result = await handlers.attachment_get({ kind: 'memory', doc: doc.id, filename: 'data.json' });
  const entry = JSON.parse(result.content[0].text);
  const expectedDir = attachmentsDirFor(memoryRepo.get(doc.id)!.source_path, 'memory');
  assert.equal(entry.absolute_path, path.join(expectedDir, 'data.json'));
  assert.ok(path.isAbsolute(entry.absolute_path));
  assert.ok(fs.existsSync(entry.absolute_path));
  void dir;
});

test('attachment_update tool: response absolute_path resolves to the updated file', async () => {
  const { dir, memoryRepo } = setupMemoryRepo();
  const doc = memoryRepo.create({ key: 'TEST-10', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  attachRepo.add('memory', doc.id, 'data.json', Buffer.from('{"v":1}'));
  const handlers = collectTools(attachRepo);

  const srcFile = path.join(dir, 'updated.json');
  fs.writeFileSync(srcFile, '{"v":2}');
  const result = await handlers.attachment_update({ kind: 'memory', doc: doc.id, filename: 'data.json', file_path: srcFile });
  const entry = JSON.parse(result.content[0].text);
  assert.ok(path.isAbsolute(entry.absolute_path));
  assert.equal(fs.readFileSync(entry.absolute_path, 'utf-8'), '{"v":2}');
});

test('attachment_list tool: every entry includes a resolvable absolute_path', async () => {
  const { memoryRepo } = setupMemoryRepo();
  const doc = memoryRepo.create({ key: 'TEST-11', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  attachRepo.add('memory', doc.id, 'a.json', Buffer.from('{}'));
  attachRepo.add('memory', doc.id, 'b.json', Buffer.from('{}'));
  const handlers = collectTools(attachRepo);

  const result = await handlers.attachment_list({ kind: 'memory', doc: doc.id });
  const entries = JSON.parse(result.content[0].text);
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.ok(path.isAbsolute(entry.absolute_path));
    assert.ok(fs.existsSync(entry.absolute_path));
  }
});

// --- C1: path-traversal hardening on remove()/update() ---

test('AttachmentRepository.remove: throws on path-traversal filename and does not delete outside files', () => {
  const { dir, memoryRepo } = setupMemoryRepo();
  const doc = memoryRepo.create({ key: 'TEST-12', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  attachRepo.add('memory', doc.id, 'data.json', Buffer.from('{}'));

  // A real file outside the attachments dir, at the same relative depth a
  // '../../evil.txt' traversal from <memFolder>/<id>/attachments would reach.
  const victim = path.join(dir, 'VICTIM.txt');
  fs.writeFileSync(victim, 'do not delete me');

  assert.throws(() => attachRepo.remove('memory', doc.id, '../../VICTIM.txt'), /escapes/);
  assert.ok(fs.existsSync(victim), 'victim file outside the attachments dir must survive');
  // The legitimate attachment must be untouched too.
  assert.equal(memoryRepo.get(doc.id)!.attachments?.length, 1);
});

test('AttachmentRepository.update: throws on path-traversal filename and does not delete outside files', () => {
  const { dir, memoryRepo } = setupMemoryRepo();
  const doc = memoryRepo.create({ key: 'TEST-13', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);

  // Directly inject a malicious declared filename into the doc's attachments list — this is the
  // shape update()'s "existing entry" lookup needs to proceed past its not-found guard and reach
  // the vulnerable rmSync call, mirroring how an already-declared attachment with a traversal-y
  // name (e.g. synced in from disk, or added before this fix existed) could be updated.
  memoryRepo.update(doc.id, {
    attachments: [{ filename: '../../VICTIM2.txt', path: 'attachments/VICTIM2.txt', mime_type: 'text/plain', size: 0, added_at: new Date().toISOString() }],
  } as any);

  const victim = path.join(dir, 'VICTIM2.txt');
  fs.writeFileSync(victim, 'do not delete me');

  assert.throws(() => attachRepo.update('memory', doc.id, '../../VICTIM2.txt', Buffer.from('new')), /escapes/);
  assert.ok(fs.existsSync(victim), 'victim file outside the attachments dir must survive');
});

// --- I2: memory doc delete removes the <id>/ wrapper directory, not just attachments/ ---

test('MemoryRepository.delete: removes the <id>/ wrapper directory entirely, not just attachments/', () => {
  const { memoryRepo } = setupMemoryRepo();
  const doc = memoryRepo.create({ key: 'TEST-14', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  attachRepo.add('memory', doc.id, 'data.json', Buffer.from('{}'));

  const attachmentsDir = attachmentsDirFor(memoryRepo.get(doc.id)!.source_path, 'memory');
  const idDir = path.dirname(attachmentsDir);
  assert.ok(fs.existsSync(idDir));

  memoryRepo.delete(doc.id);

  assert.ok(!fs.existsSync(attachmentsDir));
  assert.ok(!fs.existsSync(idDir), '<id>/ wrapper directory must not be left behind');
});

// --- I3: attachment_add/update stat-check before reading full file bytes ---

test('attachment_add tool: rejects an oversized file via stat check without reading its bytes', async () => {
  const { dir, memoryRepo } = setupMemoryRepo();
  const doc = memoryRepo.create({ key: 'TEST-15', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
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
    const result = await handlers.attachment_add({ kind: 'memory', doc: doc.id, filename: 'huge.bin', file_path: bigFile });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /exceeds/);
    assert.equal(readFileSyncCalled, false, 'readFileSync must not be called once the stat check rejects the file');
  } finally {
    (fs as any).readFileSync = originalReadFileSync;
  }
});

test('attachment_update tool: rejects an oversized file via stat check without reading its bytes', async () => {
  const { dir, memoryRepo } = setupMemoryRepo();
  const doc = memoryRepo.create({ key: 'TEST-16', key_type: 'ticket', doc_type: 'other', description: 'd', body: 'b' });
  const attachRepo = new AttachmentRepository(memoryRepo, undefined as any);
  attachRepo.add('memory', doc.id, 'data.json', Buffer.from('{}'));
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
    const result = await handlers.attachment_update({ kind: 'memory', doc: doc.id, filename: 'data.json', file_path: bigFile });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /exceeds/);
    assert.equal(readFileSyncCalled, false, 'readFileSync must not be called once the stat check rejects the file');
  } finally {
    (fs as any).readFileSync = originalReadFileSync;
  }
});

// --- skill-kind coverage: end-to-end via SkillRepository (previously untested) ---

test('AttachmentRepository: skill-kind add/list/cascade-delete end-to-end', () => {
  const { skillRepo } = setupSkillRepo();
  const skill = skillRepo.create(
    { name: 'demo-skill-attach', description: 'Demo skill for attachment coverage. Use when testing.', owner: null, status: 'unreviewed', tags: [], trigger_phrases: [] },
    'Body text.'
  );
  const attachRepo = new AttachmentRepository(undefined as any, skillRepo);

  const entry = attachRepo.add('skill', skill.name, 'notes.txt', Buffer.from('hello'));
  assert.equal(entry.filename, 'notes.txt');

  const listed = attachRepo.list('skill', skill.name);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.filename, 'notes.txt');

  const attachmentsDir = attachmentsDirFor(skillRepo.get(skill.name)!.source_path, 'skill');
  assert.ok(fs.existsSync(path.join(attachmentsDir, 'notes.txt')));

  skillRepo.delete(skill.name);

  assert.ok(!fs.existsSync(attachmentsDir), 'skill delete must cascade-remove the attachments dir');
  assert.equal(skillRepo.get(skill.name), null);
});
