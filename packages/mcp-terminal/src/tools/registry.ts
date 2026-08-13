import { Sandbox } from '../sandbox.js';
import { getSystemInfo, formatSystemInfo } from '../system-info.js';
import { buildFilesystemTools } from './filesystem.js';
import { buildRunCommandTool, type RunCommandOptions } from './run-command.js';
import type { ToolDef } from '../types.js';

export interface RegistryOptions {
  sandboxRoot?: string;
  allowExec?: boolean;
}

export class ToolRegistry {
  readonly sandbox: Sandbox;
  readonly tools: ToolDef[];
  readonly summary: string;

  constructor(opts: RegistryOptions = {}) {
    this.sandbox = new Sandbox(opts.sandboxRoot);
    let runCommandOpts: RunCommandOptions = { enabled: Boolean(opts.allowExec) };
    this.tools = [
      ...buildFilesystemTools(this.sandbox),
      buildRunCommandTool(this.sandbox, runCommandOpts),
    ];
    let info = getSystemInfo(this.sandbox.root);
    this.summary =
      `mcp-terminal: sandboxed filesystem + shell access for one local directory. ${formatSystemInfo(info)} ` +
      (runCommandOpts.enabled
        ? 'run_command is ENABLED for this session.'
        : 'run_command is DISABLED for this session (started without --allow-exec) - every call to it will throw; ' +
          'file tools (list_dir/stat/read_file/read_files/write_file/write_files/apply_patch/mkdir/' +
          'move_path/delete_path/find_files/grep) still work.') +
      ' Prefer the specific tool over run_command when one exists (e.g. read_file over "cat", find_files ' +
      'over "find", list_dir over "ls") - it is cheaper and returns structured data instead of raw text ' +
      'you have to parse. Reach for run_command for things with no dedicated tool: installing dependencies, ' +
      'compiling/building, running tests, git operations, or a project scaffolding CLI (e.g. "npm create ' +
      'vite@latest . -- --template react").';
  }

  find(name: string): ToolDef | undefined {
    return this.tools.find((t) => t.name === name);
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    let tool = this.find(name);
    if (!tool) {
      let names = this.tools.map((t) => t.name).join(', ');
      throw new Error(`Unknown tool "${name}". Available tools: ${names}`);
    }
    return tool.fn(args);
  }
}
