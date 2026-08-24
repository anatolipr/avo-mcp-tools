import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCredential, setCredential, clearCredential } from '../src/remote/credentials.js';

function tmpBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mb-credentials-test-'));
}

test('getCredential: undefined when no credentials file exists yet', () => {
  const baseDir = tmpBaseDir();
  assert.equal(getCredential(baseDir, 'https://folderfoo.example.com'), undefined);
});

test('setCredential then getCredential: round-trips the jwt', () => {
  const baseDir = tmpBaseDir();
  setCredential(baseDir, 'https://folderfoo.example.com', 'jwt-abc');
  assert.deepEqual(getCredential(baseDir, 'https://folderfoo.example.com'), { jwt: 'jwt-abc' });
});

test('setCredential: keyed independently per server URL', () => {
  const baseDir = tmpBaseDir();
  setCredential(baseDir, 'https://a.example.com', 'jwt-a');
  setCredential(baseDir, 'https://b.example.com', 'jwt-b');
  assert.equal(getCredential(baseDir, 'https://a.example.com')?.jwt, 'jwt-a');
  assert.equal(getCredential(baseDir, 'https://b.example.com')?.jwt, 'jwt-b');
});

test('setCredential: overwrites a prior credential for the same server without touching others', () => {
  const baseDir = tmpBaseDir();
  setCredential(baseDir, 'https://a.example.com', 'jwt-old');
  setCredential(baseDir, 'https://b.example.com', 'jwt-b');
  setCredential(baseDir, 'https://a.example.com', 'jwt-new');
  assert.equal(getCredential(baseDir, 'https://a.example.com')?.jwt, 'jwt-new');
  assert.equal(getCredential(baseDir, 'https://b.example.com')?.jwt, 'jwt-b');
});

test('clearCredential: removes exactly one server, leaves others intact', () => {
  const baseDir = tmpBaseDir();
  setCredential(baseDir, 'https://a.example.com', 'jwt-a');
  setCredential(baseDir, 'https://b.example.com', 'jwt-b');
  clearCredential(baseDir, 'https://a.example.com');
  assert.equal(getCredential(baseDir, 'https://a.example.com'), undefined);
  assert.equal(getCredential(baseDir, 'https://b.example.com')?.jwt, 'jwt-b');
});

test('clearCredential: no-op when the server has no stored credential', () => {
  const baseDir = tmpBaseDir();
  assert.doesNotThrow(() => clearCredential(baseDir, 'https://never-set.example.com'));
});

test('credentials file is written with 0600 permissions', () => {
  const baseDir = tmpBaseDir();
  setCredential(baseDir, 'https://a.example.com', 'jwt-a');
  const filePath = path.join(baseDir, '.memory-bucket-credentials.json');
  const mode = fs.statSync(filePath).mode & 0o777;
  assert.equal(mode, 0o600);
});
