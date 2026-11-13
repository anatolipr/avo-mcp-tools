import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalServer, serverNames } from '../src/remote/hosts.js';
import { getCredential, setCredential, clearCredential } from '../src/remote/credentials.js';

test('files.cuul.cc is an alias of the scaffoldify.com cloud host', () => {
  assert.equal(canonicalServer('https://files.cuul.cc'), 'https://scaffoldify.com');
  assert.equal(canonicalServer('https://files.cuul.cc/'), 'https://scaffoldify.com');
  assert.equal(canonicalServer('http://localhost:3000'), 'http://localhost:3000');
  assert.deepEqual(serverNames('http://localhost:3000'), ['http://localhost:3000']);
  assert.ok(serverNames('https://files.cuul.cc').includes('https://files.cuul.cc'));
});

test('a token saved under files.cuul.cc is found under scaffoldify.com and moved on write', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-hosts-test-'));
  fs.writeFileSync(path.join(baseDir, '.memory-bucket-credentials.json'), JSON.stringify({ 'https://files.cuul.cc': { jwt: 'old' } }));
  assert.equal(getCredential(baseDir, 'https://scaffoldify.com')?.jwt, 'old');
  assert.equal(getCredential(baseDir, 'https://files.cuul.cc')?.jwt, 'old');
  setCredential(baseDir, 'https://scaffoldify.com', 'new');
  const store = JSON.parse(fs.readFileSync(path.join(baseDir, '.memory-bucket-credentials.json'), 'utf8'));
  assert.deepEqual(Object.keys(store), ['https://scaffoldify.com']);
  clearCredential(baseDir, 'https://files.cuul.cc');
  assert.equal(getCredential(baseDir, 'https://scaffoldify.com'), undefined);
});
