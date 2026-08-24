import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

function tmpBaseDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mb-config-remote-test-'));
}

function writeConfig(baseDir: string, contents: unknown): void {
  fs.writeFileSync(path.join(baseDir, 'memory-bucket.config.json'), JSON.stringify(contents));
}

test('a remote skill_sources entry resolves to a NamedFolder whose path is a local mirror dir, not the raw config value', () => {
  const baseDir = tmpBaseDir();
  writeConfig(baseDir, {
    skill_sources: [{ name: 'team-qa', remote: { server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'work/qa' } }],
  });

  const config = loadConfig(baseDir, []);
  assert.equal(config.skillFolders.length, 1);
  assert.equal(config.skillFolders[0].name, 'team-qa');
  // The resolved path must be a real local directory under baseDir, NOT
  // folderfoo's server URL or folder path - every downstream consumer
  // (chokidar, upsertFile's readMarkdownFile) needs a real filesystem path.
  assert.ok(config.skillFolders[0].path.startsWith(baseDir));
  assert.ok(config.skillFolders[0].path.includes('.memory-bucket-remote-cache'));
});

test('a remote entry populates remoteSkillFolders/remoteMemoryFolders with its folderfoo coordinates', () => {
  const baseDir = tmpBaseDir();
  writeConfig(baseDir, {
    skill_sources: [{ name: 'team-qa', remote: { server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'work/qa' } }],
    memory_sources: [{ name: 'team-plans', remote: { server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'plans' } }],
  });

  const config = loadConfig(baseDir, []);
  assert.equal(config.remoteSkillFolders.length, 1);
  assert.deepEqual(config.remoteSkillFolders[0], {
    name: 'team-qa',
    server: 'https://folderfoo.example.com',
    tenantId: 't1',
    folderPath: 'work/qa',
    mirrorDir: config.skillFolders[0].path,
  });
  assert.equal(config.remoteMemoryFolders.length, 1);
  assert.equal(config.remoteMemoryFolders[0].name, 'team-plans');
});

test('a local (non-remote) source entry produces an empty remoteSkillFolders list', () => {
  const baseDir = tmpBaseDir();
  fs.mkdirSync(path.join(baseDir, 'skills'));
  writeConfig(baseDir, { skill_sources: ['./skills'] });

  const config = loadConfig(baseDir, []);
  assert.equal(config.remoteSkillFolders.length, 0);
  assert.equal(config.skillFolders[0].path, path.join(baseDir, 'skills'));
});

test('local and remote sources coexist in the same skill_sources list', () => {
  const baseDir = tmpBaseDir();
  fs.mkdirSync(path.join(baseDir, 'skills'));
  writeConfig(baseDir, {
    skill_sources: ['./skills', { name: 'team-qa', remote: { server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'work/qa' } }],
  });

  const config = loadConfig(baseDir, []);
  assert.equal(config.skillFolders.length, 2);
  assert.equal(config.remoteSkillFolders.length, 1);
  assert.equal(config.remoteSkillFolders[0].name, 'team-qa');
});

test('two remote entries for the same name produce distinct mirror dirs from distinct sanitized names', () => {
  const baseDir = tmpBaseDir();
  writeConfig(baseDir, {
    skill_sources: [
      { name: 'Team QA!', remote: { server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'a' } },
      { name: 'team-backend', remote: { server: 'https://folderfoo.example.com', tenantId: 't1', folderPath: 'b' } },
    ],
  });

  const config = loadConfig(baseDir, []);
  const paths = config.skillFolders.map((f) => f.path);
  assert.equal(new Set(paths).size, 2);
});

test('folderfooMode defaults to "off" with no host, when no flag/env var is set', () => {
  const baseDir = tmpBaseDir();
  const originalEnv = process.env.FOLDERFOO_MODE;
  delete process.env.FOLDERFOO_MODE;
  try {
    const config = loadConfig(baseDir, []);
    assert.equal(config.folderfooMode, 'off');
    assert.equal(config.folderfooHost, null);
  } finally {
    if (originalEnv !== undefined) process.env.FOLDERFOO_MODE = originalEnv;
  }
});

test('--folderfoo-mode dev resolves to the localhost:3000 dev host', () => {
  const baseDir = tmpBaseDir();
  const config = loadConfig(baseDir, ['node', 'server.js', '--folderfoo-mode', 'dev']);
  assert.equal(config.folderfooMode, 'dev');
  assert.equal(config.folderfooHost, 'http://localhost:3000');
});

test('--folderfoo-mode cloud resolves to the hosted files.cuul.cc host', () => {
  const baseDir = tmpBaseDir();
  const config = loadConfig(baseDir, ['node', 'server.js', '--folderfoo-mode', 'cloud']);
  assert.equal(config.folderfooMode, 'cloud');
  assert.equal(config.folderfooHost, 'https://files.cuul.cc');
});

test('FOLDERFOO_MODE env var is used when no --folderfoo-mode flag is passed', () => {
  const baseDir = tmpBaseDir();
  const originalEnv = process.env.FOLDERFOO_MODE;
  process.env.FOLDERFOO_MODE = 'dev';
  try {
    const config = loadConfig(baseDir, []);
    assert.equal(config.folderfooMode, 'dev');
    assert.equal(config.folderfooHost, 'http://localhost:3000');
  } finally {
    if (originalEnv === undefined) delete process.env.FOLDERFOO_MODE;
    else process.env.FOLDERFOO_MODE = originalEnv;
  }
});

test('--folderfoo-mode flag takes precedence over FOLDERFOO_MODE env var', () => {
  const baseDir = tmpBaseDir();
  const originalEnv = process.env.FOLDERFOO_MODE;
  process.env.FOLDERFOO_MODE = 'cloud';
  try {
    const config = loadConfig(baseDir, ['node', 'server.js', '--folderfoo-mode', 'dev']);
    assert.equal(config.folderfooMode, 'dev');
  } finally {
    if (originalEnv === undefined) delete process.env.FOLDERFOO_MODE;
    else process.env.FOLDERFOO_MODE = originalEnv;
  }
});

test('an unrecognized --folderfoo-mode value falls back to "off" rather than throwing', () => {
  const baseDir = tmpBaseDir();
  const config = loadConfig(baseDir, ['node', 'server.js', '--folderfoo-mode', 'nonsense']);
  assert.equal(config.folderfooMode, 'off');
  assert.equal(config.folderfooHost, null);
});
