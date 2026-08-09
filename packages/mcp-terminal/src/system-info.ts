// Baked into the very first thing a connecting agent sees (the MCP server's
// `instructions` field, and the human-relay primer) so it never has to guess
// "am I on macOS or Linux, bash or zsh, which node" before proposing a
// run_command call - answering that question via trial and error is exactly
// the kind of round-trip this tool exists to save.
import os from 'node:os';
import process from 'node:process';

export interface SystemInfo {
  platform: NodeJS.Platform;
  platformLabel: string;
  release: string;
  arch: string;
  shell: string;
  nodeVersion: string;
  homeDir: string;
  cwd: string;
}

function platformLabel(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'darwin': return 'macOS';
    case 'linux': return 'Linux';
    case 'win32': return 'Windows';
    default: return platform;
  }
}

export function getSystemInfo(sandboxRoot: string): SystemInfo {
  return {
    platform: process.platform,
    platformLabel: platformLabel(process.platform),
    release: os.release(),
    arch: os.arch(),
    shell: process.env.SHELL || (process.platform === 'win32' ? 'cmd.exe/powershell' : 'sh'),
    nodeVersion: process.version,
    homeDir: os.homedir(),
    cwd: sandboxRoot,
  };
}

export function formatSystemInfo(info: SystemInfo): string {
  let shellName = info.shell.split('/').pop() || info.shell;
  let posix = info.platform !== 'win32';
  return [
    `Host: ${info.platformLabel} (${info.release}, ${info.arch}), shell: ${shellName}, node ${info.nodeVersion}.`,
    `Sandbox root: ${info.cwd} - every path tool ONLY operates inside this directory; absolute paths ` +
      `and ".." that would escape it are rejected. Use paths relative to the sandbox root.`,
    posix
      ? 'POSIX host: use forward slashes, POSIX shell syntax (e.g. "rm -rf", "&&", "export X=1") in run_command.'
      : 'Windows host: use backslashes or forward slashes, and PowerShell/cmd syntax in run_command (not POSIX-only flags).',
  ].join(' ');
}
