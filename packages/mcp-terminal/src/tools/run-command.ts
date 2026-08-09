// The highest-risk tool in the registry: arbitrary shell execution. Scoped
// as tightly as it can be while still being useful for scaffolding (install
// deps, run a compiler/build, git init, run tests) - the thing that makes
// this tool feel close to a real terminal instead of just a file editor.
import { spawn } from 'node:child_process';
import type { Sandbox } from '../sandbox.js';
import type { ToolDef } from '../types.js';

const MAX_OUTPUT_BYTES = 100_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

export interface RunCommandOptions {
  /** Absolute confirmation gate: if false, run_command always throws instead of executing. Off by default. */
  enabled: boolean;
}

export function buildRunCommandTool(sandbox: Sandbox, opts: RunCommandOptions): ToolDef {
  return {
    name: 'run_command',
    description: 'Runs a shell command inside the sandbox root (cwd is always the sandbox root, or a ' +
      'subdirectory if "cwd" is given - never outside it). Use this for scaffolding/build workflows a ' +
      'plain file-edit tool cannot do: installing dependencies (npm/pnpm/yarn/pip install), running a ' +
      'compiler/bundler/test suite, git init/add/commit, creating a project with a CLI generator, etc. ' +
      `Output (stdout+stderr combined) is capped at ${MAX_OUTPUT_BYTES} bytes and the process is killed ` +
      `after "timeoutMs" (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}). Commands that read stdin ` +
      'will hang until the timeout - prefer non-interactive flags (e.g. "npm init -y", "--yes", "-y"). ' +
      'This tool must be explicitly enabled by whoever started mcp-terminal (--allow-exec); if it was not, ' +
      'every call throws immediately - if that happens, tell the human running this session to restart ' +
      'with --allow-exec if they want you to be able to run commands.',
    params: {
      command: { type: 'string', description: 'The shell command to run, e.g. "npm install" or "git init && git add -A && git commit -m init"' },
      cwd: { type: 'string', description: 'Subdirectory (relative to sandbox root) to run the command in, defaults to the sandbox root', optional: true },
      timeoutMs: { type: 'number', description: `Max time to allow before killing the process (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`, optional: true },
    },
    example: { command: 'npm install' },
    destructive: true,
    fn: async (args) => {
      if (!opts.enabled) {
        throw new Error('run_command is disabled for this session - restart mcp-terminal with --allow-exec to enable it.');
      }
      let command = args.command as string;
      if (!command || !command.trim()) throw new Error('command must not be empty');
      let cwd = args.cwd ? sandbox.resolve(args.cwd as string) : sandbox.root;
      let timeoutMs = Math.min(Number(args.timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

      return runShell(command, cwd, timeoutMs);
    },
  };
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<{
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}> {
  return new Promise((resolve) => {
    let shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    let shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];

    let child = spawn(shell, shellArgs, { cwd, env: process.env, windowsHide: true });
    let chunks: Buffer[] = [];
    let byteCount = 0;
    let truncated = false;
    let timedOut = false;

    let timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    function onData(chunk: Buffer) {
      if (byteCount >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      let remaining = MAX_OUTPUT_BYTES - byteCount;
      let slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(slice);
      byteCount += slice.length;
      if (slice.length < chunk.length) truncated = true;
    }

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('close', (code) => {
      clearTimeout(timer);
      let output = Buffer.concat(chunks).toString('utf8');
      if (truncated) output += `\n\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
      if (timedOut) output += `\n\n[process killed - exceeded ${timeoutMs}ms timeout]`;
      resolve({ command, exitCode: code, timedOut, output });
    });
  });
}
