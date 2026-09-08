// Service worker entry point. Runs once when the worker starts (fresh
// install/update, browser restart, or wake from suspension) - all setup
// here must be idempotent, since MV3 can restart this worker at any time.
//
// CORRECTION (found during manual testing): top-level `await` here caused
// "Service worker registration failed. Status code: 3" in Chrome, with no
// stack trace surfaced anywhere (confirmed by bisection: a trivial
// background.js with no top-level await registered fine; restoring the real
// bundle but removing just the `await` on registerBuiltinTools() also
// registered fine). Chrome's MV3 service worker environment does not
// reliably support top-level await even with "type": "module" declared -
// wrapped in an async function and invoked without awaiting it at module
// scope instead. registerBuiltinTools() populating host-tools.ts is not a
// hard prerequisite for the other startXxx() calls below - the extension's
// WS connection (startExtensionConnection) sends its first register_tools
// only once the socket's onConnect fires, which takes a real network
// round-trip and so already runs after this microtask-scheduled async
// function has resolved in every observed case; host-tools.ts's
// onHostToolsChange resend covers the case even if that assumption ever
// breaks.
import { startExtensionConnection } from './extension-connection.js';
import { startAutoReconnect } from './auto-reconnect.js';
import { startMessageHandler } from './message-handler.js';
import { startKeepalive } from './keepalive.js';
import { registerBuiltinTools } from './builtin-tools.js';
import { recordConsoleCapture } from './console-log.js';
import { startConnectionBadge } from './connection-badge.js';

console.log('[browser-extension] service worker starting');

startAutoReconnect();
startMessageHandler(recordConsoleCapture);
startExtensionConnection();
startConnectionBadge();
startKeepalive(() => {
  // The alarm firing is enough to wake/keep the worker alive; connectStateSocket
  // already owns its own reconnect loop for an actually-dropped socket, so
  // there's nothing else to do here beyond having woken up.
});

async function init() {
  await registerBuiltinTools();
}
void init();
