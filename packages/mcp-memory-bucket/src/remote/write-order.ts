/**
 * Enforces "remote is the source of truth" ordering for a create/update/rename touching a
 * remote (folderfoo-backed) folder: the remote call runs FIRST, and the local mirror write only
 * happens once that succeeds. If the remote call throws, `localWrite` never runs at all — nothing
 * local changes, so a remote outage (or any other remote failure) can't leave the local mirror and
 * folderfoo disagreeing. There is deliberately no rollback path here, unlike the old local-first
 * pattern this replaces (which wrote locally, pushed remotely, and unwound the local write in a
 * catch block on failure) — remote-first means there is nothing to unwind.
 *
 * Every doc/skill create/update/rename builds its new content (or resolves its new path) entirely
 * in memory before touching disk, so `remoteWrite` never needs to read anything back off disk —
 * callers pass it the already-serialized string/bytes directly, not a file to read.
 */
export async function writeRemoteThenLocal<T>(remoteWrite: () => Promise<void>, localWrite: () => T): Promise<T> {
  await remoteWrite();
  return localWrite();
}
