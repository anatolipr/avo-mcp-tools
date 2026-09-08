// Registered via chrome.scripting.registerContentScripts with world: 'MAIN'
// (see console-log.ts) so it patches the PAGE's own console, not an
// isolated-world copy. Cannot use chrome.runtime directly (no chrome.* bridge
// in the MAIN world) - relays via a CustomEvent on window instead, picked up
// by console-capture-relay.ts running in the ISOLATED world alongside it.
(function patchConsole() {
  const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
  for (const level of levels) {
    const original = (console as any)[level];
    (console as any)[level] = (...args: unknown[]) => {
      try {
        window.dispatchEvent(
          new CustomEvent('__mcp_console_capture__', {
            detail: {
              level,
              args: args.map((a) => {
                try {
                  return typeof a === 'string' ? a : JSON.stringify(a);
                } catch {
                  return String(a);
                }
              }),
            },
          })
        );
      } catch {
        // never let capture itself break the page's own logging
      }
      original(...args);
    };
  }
})();
