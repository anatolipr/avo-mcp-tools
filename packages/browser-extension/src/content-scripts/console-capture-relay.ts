// Runs in the ISOLATED world (has chrome.runtime access) alongside
// console-capture-main.ts's MAIN-world patch - relays the CustomEvent that
// script dispatches on window back to the background service worker.
window.addEventListener('__mcp_console_capture__', (event: Event) => {
  const detail = (event as CustomEvent).detail as { level: string; args: string[] };
  chrome.runtime.sendMessage({ type: 'mcp-console-capture', level: detail.level, args: detail.args });
});
