# TODO

## Tool coverage gaps (2026-09-10)

Reviewed the current tool set (`list_dir`, `stat`, `read_file`, `read_files`, `write_file`, `write_files`,
`apply_patch`, `mkdir`, `move_path`, `delete_path`, `find_files`, `grep`, `run_command`) for gaps vs. a
typical coding-agent toolset. Biggest ones worth addressing:

1. **No background process management.** `run_command` is fire-and-forget with a hard timeout (default 60s,
   max 10min) - there's no way to start a long-running process (dev server, watch mode), check its output
   later, or kill it. Would need something like `start_process` / `list_processes` / `get_process_output` /
   `kill_process`.
2. **No targeted/exact string-replace edit tool.** Only `apply_patch` (strict unified diff, fails on
   miscounted hunks - a known pain point per its own description) or `write_file` (full overwrite). A simple
   `edit_file(path, old_string, new_string)` would be more robust for small edits than hand-counted diffs.

Smaller/lower-priority gaps noted:

3. No per-call environment variable overrides for `run_command` (inherits `process.env` wholesale).
4. No streaming output for long-running commands - output only returns at exit/timeout.
5. `grep` lacks context lines (-A/-B/-C) and multiline pattern support.
6. No file permission (chmod-equivalent) controls.
7. No persistent shell session - each `run_command` call is a fresh `/bin/sh -c`, so `cd`/exported vars/
   activated venvs don't carry across calls.
