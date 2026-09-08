// ISOLATED-world half of inject_persistent_script (see script-injection.ts).
// Registered scripts can't carry per-registration payload data directly, so
// on each run this asks the background script "what code (if any) is
// registered for a page at this URL," then hands each snippet to the
// MAIN-world runner (persistent-script-main-runner.ts) via a CustomEvent -
// the same relay pattern console-capture-relay.ts uses in the other
// direction, since only an ISOLATED-world script has chrome.runtime access.
chrome.runtime.sendMessage({ type: 'mcp-persistent-script-lookup', url: location.href }, (response: { codes?: string[] } | undefined) => {
  for (const code of response?.codes ?? []) {
    window.dispatchEvent(new CustomEvent('__mcp_persistent_script_run__', { detail: { code } }));
  }
});
