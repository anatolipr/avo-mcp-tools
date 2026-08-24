import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFolderfooAddress } from '../src/client/folderfoo-address.js';

test('parseFolderfooAddress: bare name, own file, root folder', () => {
  assert.deepEqual(parseFolderfooAddress('notes'), { folderPath: '', name: 'notes' });
});

test('parseFolderfooAddress: nested own file (folder path contains "/", unambiguous)', () => {
  assert.deepEqual(parseFolderfooAddress('work/project-x:notes'), { folderPath: 'work/project-x', name: 'notes' });
});

test('parseFolderfooAddress: single-segment folder is ambiguous with owner - parsed as owner per the 2-part grammar', () => {
  // Matches folders.js's own documented ambiguity: a bare 2-part split
  // with no "/" is always treated as owner:name, never folder:name.
  assert.deepEqual(parseFolderfooAddress('work:notes'), { owner: 'work', folderPath: '', name: 'notes' });
});

test('parseFolderfooAddress: single-segment OWN folder uses the explicit empty-owner 3-part form', () => {
  assert.deepEqual(parseFolderfooAddress(':work:notes'), { owner: undefined, folderPath: 'work', name: 'notes' });
});

test('parseFolderfooAddress: shared file, root folder', () => {
  assert.deepEqual(parseFolderfooAddress('alice:notes'), { owner: 'alice', folderPath: '', name: 'notes' });
});

test('parseFolderfooAddress: shared file, nested folder', () => {
  assert.deepEqual(parseFolderfooAddress('alice:work/project-x:notes'), { owner: 'alice', folderPath: 'work/project-x', name: 'notes' });
});

test('parseFolderfooAddress: a name containing ":" survives via rejoin', () => {
  assert.deepEqual(parseFolderfooAddress(':work:name:with:colons'), { owner: undefined, folderPath: 'work', name: 'name:with:colons' });
});
