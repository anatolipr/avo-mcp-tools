// MAIN-world half of inject_persistent_script - listens for the CustomEvent
// persistent-script-runner.ts (ISOLATED world) dispatches once it has
// fetched this page's registered code from the background script, and evals
// each snippet with the same window/document access a directly-pasted
// DevTools snippet would have.
window.addEventListener('__mcp_persistent_script_run__', (event: Event) => {
  const { code } = (event as CustomEvent).detail as { code: string };
  try {
    new Function(code)();
  } catch (err) {
    console.error('[js-bridge-mcp extension] persistent script failed:', err);
  }
});
