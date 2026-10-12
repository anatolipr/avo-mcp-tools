import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';

const launchers = ['js-bridge-mcp', 'mcp-form', 'mcp-memory-bucket', 'screenmarker', 'mcp-terminal'];
const runner = `
  import { readFile } from 'node:fs/promises';
  import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

  const [filename, settings] = process.argv.slice(1);
  const { isTTY, args } = JSON.parse(settings);
  const output = { stdout: '', stderr: '', serverStarted: false, stderrAtStartup: '' };
  const exited = new Error('exited');
  const context = createContext({
    process: {
      argv: ['node', filename, ...args],
      env: {},
      stdout: { write: text => { output.stdout += text; } },
      stderr: { isTTY, write: text => { output.stderr += text; } },
      exit: () => { throw exited; },
    },
    console: {
      log: text => { output.stdout += text; },
      error: text => { output.stderr += text; },
    },
  });
  async function load(specifier) {
    let dependency;
    if (specifier === 'node:child_process') {
      dependency = new SyntheticModule(['execSync'], function () {
        this.setExport('execSync', () => { throw new Error('no server running'); });
      }, { context });
    } else if (specifier.startsWith('../dist/src/')) {
      dependency = new SyntheticModule([], function () {
        output.serverStarted = true;
        output.stderrAtStartup = output.stderr;
      }, { context });
    } else {
      throw new Error('Unexpected import: ' + specifier);
    }
    await dependency.link(load);
    await dependency.evaluate();
    return dependency;
  }
  const launcher = new SourceTextModule(await readFile(filename, 'utf8'), {
    context,
    importModuleDynamically: load,
  });
  await launcher.link(load);
  try {
    await launcher.evaluate();
  } catch (error) {
    if (error !== exited) throw error;
  }
  process.stdout.write(JSON.stringify(output));
`;

function runLauncher(name: string, isTTY: boolean | undefined, args: string[] = []) {
  const filename = new URL(`../../${name}/bin/${name}.js`, import.meta.url);
  const result = spawnSync(process.execPath, [
    '--experimental-vm-modules', '--input-type=module', '--eval', runner,
    filename.pathname, JSON.stringify({ isTTY, args }),
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as {
    stdout: string;
    stderr: string;
    serverStarted: boolean;
    stderrAtStartup: string;
  };
}

for (const name of launchers) {
  test(`${name}: sets the interactive terminal title before starting the server`, () => {
    const output = runLauncher(name, true);
    assert.equal(output.serverStarted, true);
    assert.equal(output.stderrAtStartup, `\x1b]0;${name}\x07`);
    assert.equal(output.stdout, '');
  });

  test(`${name}: leaves piped MCP streams untouched`, () => {
    for (const isTTY of [false, undefined]) {
      const output = runLauncher(name, isTTY);
      assert.equal(output.serverStarted, true);
      assert.equal(output.stderr, '');
      assert.equal(output.stdout, '');
    }
  });

  test(`${name}: help flags do not change the terminal title`, () => {
    for (const flag of ['--help', '-h']) {
      const output = runLauncher(name, true, [flag]);
      assert.equal(output.stderr.includes('\x1b]0;'), false);
      assert.equal(output.stdout.includes('\x1b]0;'), false);
    }
  });

  if (name !== 'mcp-terminal') {
    test(`${name}: stop does not change the terminal title or start a server`, () => {
      const output = runLauncher(name, true, ['stop']);
      assert.equal(output.serverStarted, false);
      assert.equal(output.stderr.includes('\x1b]0;'), false);
      assert.equal(output.stdout.includes('\x1b]0;'), false);
    });
  }
}

test('screenmarker: npm start sets the interactive terminal title', { timeout: 15000 }, async () => {
  const child = spawn('npm', ['run', 'start', '--ignore-scripts'], {
    cwd: new URL('../../screenmarker/', import.meta.url),
    detached: true,
    env: {
      ...process.env,
      PORT: '0',
      SCREENMARKER_NO_OPEN: '1',
      NODE_OPTIONS: '--import=data:text/javascript,Object.defineProperty(process.stderr,%22isTTY%22,{value:true})',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  try {
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => reject(new Error(`npm start exited with ${code}: ${stderr}`)));
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        if (stderr.includes('[screenmarker] running at')) resolve();
      });
    });
    assert.ok(stderr.includes('\x1b]0;screenmarker\x07'), 'npm start should emit the screenmarker title');
  } finally {
    if (child.pid) {
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      process.kill(-child.pid, 'SIGTERM');
      await closed;
    }
  }
});