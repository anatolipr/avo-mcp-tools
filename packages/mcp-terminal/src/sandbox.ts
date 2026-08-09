// Every filesystem/command tool routes paths through here first. The sandbox
// root defaults to process.cwd() at launch (see cli-args.ts) - deliberately
// NOT configurable by the agent itself via a tool call, only by whoever
// starts the process, so a malicious/confused agent can never widen its own
// jail from inside a tool call.
import { realpathSync, existsSync } from 'node:fs';
import path from 'node:path';

export class SandboxViolation extends Error {
  constructor(requested: string, root: string) {
    super(`"${requested}" is outside the sandboxed directory (${root}) - refusing. ` +
      `This tool only operates inside the directory mcp-terminal was started in.`);
    this.name = 'SandboxViolation';
  }
}

export class Sandbox {
  readonly root: string;

  constructor(root: string = process.cwd()) {
    // Resolve the root itself through realpath once at startup so every
    // later comparison is symlink-resolved on both sides consistently.
    this.root = existsSync(root) ? realpathSync(root) : path.resolve(root);
  }

  /**
   * Resolves a (possibly relative) agent-supplied path against the sandbox
   * root and throws SandboxViolation if it escapes - via "..", an absolute
   * path outside root, OR a symlink that points outside root. Existing paths
   * are checked with realpathSync (resolves symlinks); paths that don't
   * exist yet (e.g. a file about to be created) are checked by resolving
   * their nearest existing ancestor instead, so a symlinked parent directory
   * can't be used to escape either.
   */
  resolve(requested: string): string {
    let candidate = path.isAbsolute(requested)
      ? path.normalize(requested)
      : path.resolve(this.root, requested);

    let real = this._realpathOfNearestAncestor(candidate);
    if (real !== this.root && !real.startsWith(this.root + path.sep)) {
      throw new SandboxViolation(requested, this.root);
    }
    return candidate;
  }

  private _realpathOfNearestAncestor(candidate: string): string {
    let current = candidate;
    while (true) {
      if (existsSync(current)) {
        return realpathSync(current);
      }
      let parent = path.dirname(current);
      if (parent === current) return current; // reached filesystem root without finding anything real
      current = parent;
    }
  }

  relative(absPath: string): string {
    return path.relative(this.root, absPath) || '.';
  }
}
