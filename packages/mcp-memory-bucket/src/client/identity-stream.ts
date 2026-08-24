import { Signal } from 'avosignals';
import type { FolderfooMode } from './server-config.js';

export interface CurrentIdentity {
  mode: FolderfooMode;
  username: string | null;
}

// A single shared EventSource for the whole page - every component that
// cares about "is my remote folder still visible" (the folder list,
// add-folder-modal) reads this same Signal rather than each opening its own
// stream. Lazily connected on first read, since most page loads never touch
// folderfoo at all.
export const currentIdentity = new Signal<CurrentIdentity>({ mode: 'off', username: null });

let started = false;

/** Opens the identity-stream SSE connection once per page load. Safe to call from multiple components. */
export function startIdentityStream(): void {
  if (started) return;
  started = true;
  const source = new EventSource('/api/folderfoo/identity-stream');
  source.onmessage = (event) => {
    try {
      currentIdentity.set(JSON.parse(event.data) as CurrentIdentity);
    } catch {
      // malformed event - ignore, next one will self-correct
    }
  };
  // EventSource auto-reconnects on error per the standard, so nothing extra
  // needed here beyond letting it retry.
}
