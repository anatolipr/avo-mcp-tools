import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { applyPatch, parsePatch } from 'diff';
import type { Sandbox } from '../sandbox.js';
import type { ToolDef } from '../types.js';

const MAX_READ_BYTES = 200_000; // ~ a couple thousand lines of code; big enough for source files, small enough to not blow out a chat context
const MAX_FIND_RESULTS = 500;
const MAX_BULK_READ_FILES = 50;

// Directories that get skipped by default in find/grep/list_dir(recursive) -
// crawling into these is almost never what an agent wants and node_modules
// alone can be hundreds of thousands of files.
const DEFAULT_IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', '__pycache__']);

function truncateNote(bytes: number): string {
  return `\n\n[truncated - file is ${bytes} bytes, only the first ${MAX_READ_BYTES} shown; ` +
    `use offset/limit params to read further in]`;
}

export function buildFilesystemTools(sandbox: Sandbox): ToolDef[] {
  return [
    {
      name: 'list_dir',
      description: 'Lists entries in a directory (relative to the sandbox root). Each entry reports ' +
        'name, type (file/dir/symlink), and size in bytes for files. Set recursive:true to walk ' +
        'subdirectories (node_modules/.git/dist/build/.venv/__pycache__ are skipped automatically). ' +
        'Use this before read_file/write_file if you do not already know the exact path.',
      params: {
        path: { type: 'string', description: 'Directory path, relative to sandbox root. "." for the root itself.', optional: true },
        recursive: { type: 'boolean', description: 'Walk subdirectories too (default false)', optional: true },
      },
      example: { path: '.', recursive: false },
      fn: async (args) => {
        let rel = (args.path as string) || '.';
        let dir = sandbox.resolve(rel);
        return listDir(dir, sandbox, Boolean(args.recursive));
      },
    },
    {
      name: 'stat',
      description: 'Checks whether a path exists and reports its type (file/dir/symlink), size in bytes ' +
        '(files only), and modified time, without reading its content. Cheaper than list_dir or read_file ' +
        'when you only need to know whether something exists before writing/moving/deleting it. Does not ' +
        'throw for a missing path - check the "exists" field instead.',
      params: { path: { type: 'string', description: 'Path to check, relative to sandbox root' } },
      example: { path: 'src/index.ts' },
      fn: async (args) => {
        let target = sandbox.resolve(args.path as string);
        let st = await fs.lstat(target).catch(() => null);
        if (!st) return { path: sandbox.relative(target), exists: false };
        let type = st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : 'file';
        return {
          path: sandbox.relative(target),
          exists: true,
          type,
          size: type === 'file' ? st.size : undefined,
          mtime: st.mtime.toISOString(),
        };
      },
    },
    {
      name: 'read_file',
      description: `Reads a text file's contents. Returns up to ${MAX_READ_BYTES} bytes starting at ` +
        '"offset" (default 0); if the file is larger, the result is marked truncated and you should ' +
        'call again with a larger offset to continue. Throws if the path does not exist or is a directory.',
      params: {
        path: { type: 'string', description: 'File path, relative to sandbox root' },
        offset: { type: 'number', description: 'Byte offset to start reading from (default 0)', optional: true },
      },
      example: { path: 'src/index.ts' },
      fn: async (args) => {
        let file = sandbox.resolve(args.path as string);
        let offset = Number(args.offset) || 0;
        return readOneFile(file, sandbox, offset);
      },
    },
    {
      name: 'read_files',
      description: 'Reads many text files in one call - a whole set of files at once instead of one ' +
        `read_file round-trip per file. Each file is capped at ${MAX_READ_BYTES} bytes starting at offset ` +
        `0 (use read_file with an offset if one is truncated). Reads up to ${MAX_BULK_READ_FILES} paths per ` +
        'call. Results are returned in the same order as the input paths; if one path fails (e.g. missing ' +
        'file or sandbox violation) its entry contains an "error" field instead of "content", and the rest ' +
        'of the paths are still read.',
      params: {
        paths: {
          type: 'string',
          description: 'JSON-encoded array of file path strings, relative to sandbox root, e.g. ' +
            '\'["src/a.ts","src/b.ts"]\'',
        },
      },
      example: { paths: JSON.stringify(['src/a.ts', 'src/b.ts']) },
      fn: async (args) => {
        let paths = parsePathsArg(args.paths as string);
        if (paths.length > MAX_BULK_READ_FILES) {
          throw new Error(`"paths" has ${paths.length} entries, max is ${MAX_BULK_READ_FILES} per call`);
        }
        let results: Array<Record<string, unknown>> = [];
        for (let p of paths) {
          if (typeof p !== 'string') {
            results.push({ path: p, error: '"paths" entries must be strings' });
            continue;
          }
          try {
            let file = sandbox.resolve(p);
            results.push(await readOneFile(file, sandbox, 0));
          } catch (err) {
            results.push({ path: p, error: (err as Error).message });
          }
        }
        return { files: results, count: results.length };
      },
    },
    {
      name: 'write_file',
      description: 'Writes (overwrites, or creates if missing) a text file with the given content. ' +
        'Creates parent directories automatically. This OVERWRITES the whole file - to append, first ' +
        'read_file and pass back the combined content.',
      params: {
        path: { type: 'string', description: 'File path, relative to sandbox root' },
        content: { type: 'string', description: 'New full file content' },
      },
      example: { path: 'src/hello.js', content: 'console.log("hello");\n' },
      destructive: true,
      fn: async (args) => {
        let file = sandbox.resolve(args.path as string);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, args.content as string, 'utf8');
        return `wrote ${Buffer.byteLength(args.content as string, 'utf8')} bytes to ${sandbox.relative(file)}`;
      },
    },
    {
      name: 'write_files',
      description: 'Writes (overwrites, or creates if missing) many text files in one call - a whole tree ' +
        'at once instead of one write_file round-trip per file. Creates parent directories automatically. ' +
        'Each entry OVERWRITES its whole file, same as write_file. Files are written in array order; if one ' +
        'fails (e.g. a sandbox violation) the error names which entry it was and files written before it ' +
        'are NOT rolled back - check the returned "written" list to see what succeeded.',
      params: {
        files: {
          type: 'string',
          description: 'JSON-encoded array of {"path": string, "content": string} objects, e.g. ' +
            '\'[{"path":"src/a.ts","content":"..."},{"path":"src/b.ts","content":"..."}]\'',
        },
      },
      example: { files: JSON.stringify([{ path: 'src/a.ts', content: 'export const a = 1;\n' }, { path: 'src/b.ts', content: 'export const b = 2;\n' }]) },
      destructive: true,
      fn: async (args) => {
        let entries = parseFilesArg(args.files as string);
        let written: string[] = [];
        for (let i = 0; i < entries.length; i++) {
          let entry = entries[i];
          if (typeof entry.path !== 'string' || typeof entry.content !== 'string') {
            throw new Error(`files[${i}] must have string "path" and "content" fields`);
          }
          let file: string;
          try {
            file = sandbox.resolve(entry.path);
          } catch (err) {
            throw new Error(`files[${i}] ("${entry.path}"): ${(err as Error).message}`);
          }
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, entry.content, 'utf8');
          written.push(sandbox.relative(file));
        }
        return { written, count: written.length };
      },
    },
    {
      name: 'apply_patch',
      description: 'Applies a unified diff (as produced by `diff -u` or `git diff`) to one or more files ' +
        'already in the sandbox. Supports multi-file patches (multiple "--- a/... +++ b/..." hunks in one ' +
        'string). Paths in the patch headers are resolved relative to the sandbox root (a/, b/ prefixes are ' +
        'stripped automatically). Fails the whole call if any hunk does not apply cleanly (no partial/fuzzy ' +
        'apply) - re-read the current file content and regenerate the diff if context has drifted. Hunk line ' +
        'counts (the "@@ -a,b +c,d @@" numbers and the count of context/+/- lines) are validated strictly, so ' +
        'hand-written hunks with more than ~10-15 changed lines - especially with nested braces/strings - ' +
        'commonly miscount and fail with an "Unknown line" error that looks like a tool bug but is just a ' +
        'malformed hunk. If a large insertion fails more than once, stop hand-counting: use read_file to get ' +
        'the current content, construct the new full content yourself, and call write_file (or write_files) ' +
        'instead - then verify with read_file or grep rather than assuming it applied. Prefer apply_patch for ' +
        'small, precisely-counted edits; fall back to write_file for large or repeatedly-failing patches.',
      params: {
        patch: { type: 'string', description: 'Unified diff text, one or more files' },
      },
      example: { patch: '--- a/src/hello.js\n+++ b/src/hello.js\n@@ -1 +1 @@\n-console.log("hi");\n+console.log("hello");\n' },
      destructive: true,
      fn: async (args) => {
        let patchText = args.patch as string;
        let files = parsePatch(patchText);
        if (files.length === 0) throw new Error('patch text did not contain any recognizable unified-diff hunks');
        let applied: string[] = [];
        for (let filePatch of files) {
          let rawPath = filePatch.newFileName ?? filePatch.oldFileName;
          if (!rawPath) throw new Error('a hunk in the patch is missing both old and new file names');
          let relPath = stripDiffPrefix(rawPath);
          let file = sandbox.resolve(relPath);
          let original = existsSync(file) ? await fs.readFile(file, 'utf8') : '';
          let patched = applyPatch(original, filePatch);
          if (patched === false) {
            throw new Error(`patch for "${relPath}" did not apply cleanly against the current file content ` +
              '(context mismatch) - re-read the file and regenerate the diff');
          }
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, patched, 'utf8');
          applied.push(sandbox.relative(file));
        }
        return { applied, count: applied.length };
      },
    },
    {
      name: 'mkdir',
      description: 'Creates a directory, including any missing parent directories (like "mkdir -p").',
      params: { path: { type: 'string', description: 'Directory path, relative to sandbox root' } },
      example: { path: 'src/components' },
      fn: async (args) => {
        let dir = sandbox.resolve(args.path as string);
        await fs.mkdir(dir, { recursive: true });
        return `created ${sandbox.relative(dir)}`;
      },
    },
    {
      name: 'move_path',
      description: 'Moves or renames a file or directory. Both source and destination must resolve ' +
        'inside the sandbox root. Fails if the destination already exists.',
      params: {
        from: { type: 'string', description: 'Source path, relative to sandbox root' },
        to: { type: 'string', description: 'Destination path, relative to sandbox root' },
      },
      example: { from: 'old-name.js', to: 'new-name.js' },
      destructive: true,
      fn: async (args) => {
        let src = sandbox.resolve(args.from as string);
        let dest = sandbox.resolve(args.to as string);
        if (existsSync(dest)) throw new Error(`"${args.to}" already exists - refusing to overwrite via move_path`);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.rename(src, dest);
        return `moved ${sandbox.relative(src)} -> ${sandbox.relative(dest)}`;
      },
    },
    {
      name: 'delete_path',
      description: 'Deletes a file or directory (recursively, if a directory). DESTRUCTIVE and ' +
        'irreversible - there is no trash/undo. Double-check the path with list_dir first if unsure.',
      params: { path: { type: 'string', description: 'Path to delete, relative to sandbox root' } },
      example: { path: 'tmp/scratch.txt' },
      destructive: true,
      fn: async (args) => {
        let target = sandbox.resolve(args.path as string);
        if (target === sandbox.root) throw new Error('refusing to delete the sandbox root itself');
        await fs.rm(target, { recursive: true, force: false });
        return `deleted ${sandbox.relative(target)}`;
      },
    },
    {
      name: 'find_files',
      description: `Recursively searches for files whose name matches a glob-like substring/pattern ` +
        `(simple "*" wildcard supported, e.g. "*.test.ts" or "abc*"). Returns up to ${MAX_FIND_RESULTS} ` +
        'matches, paths relative to sandbox root. Skips node_modules/.git/dist/build/.venv/__pycache__.',
      params: {
        pattern: { type: 'string', description: 'Filename pattern, "*" wildcard supported, e.g. "*.json" or "abc.txt"' },
        path: { type: 'string', description: 'Directory to search under, relative to sandbox root (default ".")', optional: true },
      },
      example: { pattern: '*.test.ts' },
      fn: async (args) => {
        let start = sandbox.resolve((args.path as string) || '.');
        let regex = globToRegex(args.pattern as string);
        let results: string[] = [];
        await walk(start, (entryPath, name) => {
          if (results.length >= MAX_FIND_RESULTS) return false;
          if (regex.test(name)) results.push(sandbox.relative(entryPath));
          return true;
        });
        return { matches: results, truncated: results.length >= MAX_FIND_RESULTS };
      },
    },
    {
      name: 'grep',
      description: `Searches file contents for a substring or regex, recursively. Returns matching ` +
        `lines with file path + line number, up to ${MAX_FIND_RESULTS} matches. Skips node_modules/.git/` +
        'dist/build/.venv/__pycache__ and binary-looking files.',
      params: {
        query: { type: 'string', description: 'Substring or JS-flavored regex pattern to search for' },
        path: { type: 'string', description: 'Directory to search under, relative to sandbox root (default ".")', optional: true },
        regex: { type: 'boolean', description: 'Treat query as a regex instead of a plain substring (default false)', optional: true },
      },
      example: { query: 'TODO' },
      fn: async (args) => {
        let start = sandbox.resolve((args.path as string) || '.');
        let query = args.query as string;
        let pattern = args.regex ? new RegExp(query) : null;
        let results: { path: string; line: number; text: string }[] = [];
        await walk(start, async (entryPath) => {
          if (results.length >= MAX_FIND_RESULTS) return false;
          let stat = await fs.stat(entryPath).catch(() => null);
          if (!stat || !stat.isFile() || stat.size > MAX_READ_BYTES) return true;
          let text = await fs.readFile(entryPath, 'utf8').catch(() => null);
          if (text === null || text.includes('\0')) return true; // skip binary
          let lines = text.split('\n');
          for (let i = 0; i < lines.length && results.length < MAX_FIND_RESULTS; i++) {
            let hit = pattern ? pattern.test(lines[i]) : lines[i].includes(query);
            if (hit) results.push({ path: sandbox.relative(entryPath), line: i + 1, text: lines[i].trim().slice(0, 300) });
          }
          return true;
        }, /* filesOnly */ true);
        return { matches: results, truncated: results.length >= MAX_FIND_RESULTS };
      },
    },
  ];
}

function parseFilesArg(raw: string): { path: string; content: string }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`"files" is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('"files" must be a JSON array of {path, content} objects');
  return parsed as { path: string; content: string }[];
}

function parsePathsArg(raw: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`"paths" is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error('"paths" must be a JSON array of file path strings');
  return parsed;
}

async function readOneFile(file: string, sandbox: Sandbox, offset: number) {
  let stat = await fs.stat(file).catch(() => null);
  if (!stat) throw new Error(`no such file: "${sandbox.relative(file)}"`);
  if (stat.isDirectory()) throw new Error(`"${sandbox.relative(file)}" is a directory - use list_dir instead`);
  let fh = await fs.open(file, 'r');
  try {
    let buf = Buffer.alloc(Math.min(MAX_READ_BYTES, Math.max(0, stat.size - offset)));
    let { bytesRead } = await fh.read(buf, 0, buf.length, offset);
    let text = buf.subarray(0, bytesRead).toString('utf8');
    let truncated = offset + bytesRead < stat.size;
    return {
      path: sandbox.relative(file),
      size: stat.size,
      offset,
      bytesRead,
      truncated,
      content: truncated ? text + truncateNote(stat.size) : text,
    };
  } finally {
    await fh.close();
  }
}

// Strips git-style "a/"/"b/" diff prefixes so patch headers written the way
// `git diff`/`diff -u` emit them ("a/src/foo.ts") resolve to the real path.
function stripDiffPrefix(p: string): string {
  return p.replace(/^[ab]\//, '');
}

function globToRegex(pattern: string): RegExp {
  let escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

async function listDir(dir: string, sandbox: Sandbox, recursive: boolean) {
  let entries: { path: string; type: string; size?: number }[] = [];
  let dirents = await fs.readdir(dir, { withFileTypes: true });
  for (let d of dirents) {
    if (DEFAULT_IGNORE_DIRS.has(d.name)) continue;
    let full = path.join(dir, d.name);
    let type = d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'symlink' : 'file';
    let size: number | undefined;
    if (type === 'file') {
      size = (await fs.stat(full).catch(() => undefined))?.size;
    }
    entries.push({ path: sandbox.relative(full), type, size });
    if (recursive && type === 'dir') {
      entries.push(...(await listDir(full, sandbox, true)));
    }
  }
  return entries;
}

async function walk(
  dir: string,
  visit: (entryPath: string, name: string) => boolean | void | Promise<boolean | void>,
  filesOnly = false,
): Promise<void> {
  let dirents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (let d of dirents) {
    if (DEFAULT_IGNORE_DIRS.has(d.name)) continue;
    let full = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (!filesOnly) {
        let keepGoing = await visit(full, d.name);
        if (keepGoing === false) return;
      }
      await walk(full, visit, filesOnly);
    } else {
      let keepGoing = await visit(full, d.name);
      if (keepGoing === false) return;
    }
  }
}
