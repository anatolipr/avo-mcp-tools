import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tenants } from '../src/tenant.js';
import { enablePersistence } from '../src/persistence.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'persist-test-')), 'tenants.json');
}

test('enablePersistence seeds a recently-active tenant from disk', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    fresh: {
      schema: undefined,
      values: {},
      submitted: false,
      lastStateChangeAt: Date.now(),
      lastActivityAt: Date.now() - 1000,
    },
  }));

  const { seededIds } = enablePersistence(file);
  try {
    assert.deepEqual(seededIds, ['fresh']);
    assert.ok(tenants.has('fresh'));
  } finally {
    tenants.delete('fresh');
  }
});

test('enablePersistence drops a tenant idle for more than a day instead of seeding it', () => {
  const file = tmpFile();
  const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
  fs.writeFileSync(file, JSON.stringify({
    stale: {
      schema: undefined,
      values: {},
      submitted: false,
      lastStateChangeAt: twoDaysAgo,
      lastActivityAt: twoDaysAgo,
    },
  }));

  const { seededIds } = enablePersistence(file);
  try {
    assert.deepEqual(seededIds, []);
    assert.equal(tenants.has('stale'), false);
  } finally {
    tenants.delete('stale');
  }
});
