// Generic, provider-agnostic tool registry shared by any page embedding
// js-bridge-mcp. Deliberately NOT part of main.ts's build (see vite.config.ts's
// copy-tool-bus plugin) - this is infrastructure any embeddable provider
// (folderfoo today, others later) and any host app (bulletino today) can
// import by URL, independent of js-bridge-mcp's own bundle.
//
// Solves the load-order problem plain `window.__mcpTools` has: main.ts reads
// that array once, synchronously, at import time, so a provider script that
// finishes loading even a tick later is invisible to it. A host page that
// wants late-registering providers to work should:
//   1. import this file first,
//   2. import every provider script (each one calls registerProvider()),
//   3. merge window.__mcpToolBus.getTools() into window.__mcpTools itself,
//   4. only then import main.js.
// Usage: <script type="module" src="http://<js-bridge-mcp host>/tool-bus.js"></script>
window.__mcpToolBus ??= (() => {
  const providers = new Map(); // providerName -> tool[]
  const listeners = new Set();

  function notify() {
    for (const cb of listeners) cb();
  }

  function getTools() {
    // Auto-prefix on name collision across providers, mirroring
    // js-bridge-mcp's own slug-suffix-on-collision pattern for connections.
    const claimedBy = new Map(); // tool name -> providerName that claimed it first
    const out = [];
    for (const [providerName, tools] of providers) {
      for (const tool of tools) {
        let name = tool.name;
        if (claimedBy.has(name)) {
          name = `${providerName}__${tool.name}`;
        } else {
          claimedBy.set(name, providerName);
        }
        out.push({ ...tool, name });
      }
    }
    return out;
  }

  return {
    // Re-registering under the same providerName replaces its previous tool
    // set (no manual unregister needed for e.g. a folder-switch refresh).
    registerProvider(providerName, tools) {
      providers.set(providerName, tools);
      notify();
      return () => {
        providers.delete(providerName);
        notify();
      };
    },
    getTools,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
})();
