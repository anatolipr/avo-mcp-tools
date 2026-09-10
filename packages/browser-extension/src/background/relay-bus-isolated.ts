// Source of the ISOLATED-world function injected alongside
// relay-chat-loop.ts's MAIN-world loop (same chrome.scripting.executeScript
// call, different `world`). A MAIN-world script has no chrome.* API access,
// so this is the relay half that actually reaches the background - mirrors
// console-capture-relay.ts's MAIN<->ISOLATED CustomEvent shape, but
// request/response instead of fire-and-forget, since the chat loop must
// `await` an actual HUMAN-MCP RESULT coming back from the app tab.
//
// This function (and the background's relay-bus-forward handler it talks
// to) is OPAQUE TRANSPORT ONLY - it never inspects or branches on `code`'s
// contents. It doesn't know about recipes, HUMAN-MCP CALL blocks, or which
// tab is "chat" vs. "app" - it just relays {targetTabId, code} to the
// background and returns whatever comes back.
export function relayBusIsolatedFunction(): void {
  // `window`/`CustomEvent` don't exist as types under this file's own
  // compile context (tsconfig.background.json has no "dom" lib) - go
  // through globalThis, same convention as relay-chat-loop.ts.
  const win = globalThis as any;
  win.addEventListener('__mcp_relay_bus_request__', (event: Event) => {
    const detail = (event as any).detail as { requestId: string; targetTabId: number; code: string };
    chrome.runtime.sendMessage(
      { type: 'relay-bus-forward', targetTabId: detail.targetTabId, code: detail.code },
      (response: { ok: boolean; result?: string; error?: string } | undefined) => {
        win.dispatchEvent(
          new win.CustomEvent('__mcp_relay_bus_response__', {
            detail: {
              requestId: detail.requestId,
              result: response?.ok ? response.result : undefined,
              error: response?.ok === false ? response.error : chrome.runtime.lastError?.message,
            },
          })
        );
      }
    );
  });
}
