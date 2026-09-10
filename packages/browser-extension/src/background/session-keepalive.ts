// Keeps the MV3 service worker alive for the duration of a long-running
// relay session by holding an open chrome.runtime.Port. A connected Port is
// Chrome's own documented mechanism for preventing MV3 idle-suspension -
// unlike keepalive.ts's chrome.alarms wake, which only resumes an ALREADY-
// suspended worker after the fact and cannot resurrect an in-flight
// chrome.scripting.executeScript call that got orphaned mid-flight. This was
// found to matter in practice: relay-engine.ts's waitForReplyInTab/
// forwardToAppTab calls can take anywhere from ~1.5s to 2 minutes, and a
// worker suspension partway through was observed to silently resolve the
// pending call with a null-ish result instead of a clean error - keeping a
// Port open for the whole session's lifetime prevents that window from
// existing at all.
//
// The service worker connects to ITSELF (chrome.runtime.connect() from the
// background script's own context reaches its own chrome.runtime.onConnect
// listener) - a self-referential Port with no other endpoint, used purely
// as an anti-suspension anchor, not for actual message passing.
//
// FIXME / KNOWN LIMITATION (confirmed via live testing): this self-connected
// Port does NOT reliably keep a relay session running once the extension
// POPUP is closed - a session observed to work correctly while the popup
// stayed open failed/stalled once the popup was closed, even with this Port
// held open the whole time. This suggests Chrome's MV3 idle-timer tracking
// does not treat a service-worker-to-itself Port the same as a Port held by
// a genuinely separate context (popup, content script, external page) - a
// known gray area in MV3 lifecycle semantics that this implementation does
// NOT actually solve, despite matching the commonly-cited pattern. Today,
// the popup must stay open for the full duration of a relay session for it
// to work reliably. Next step: try having the POPUP itself hold the
// long-lived Port (not the background connecting to itself) - a popup
// document is a genuinely external context whose Port SHOULD count toward
// keeping the worker alive per Chrome's own docs - or fall back to a
// dedicated always-open extension page (chrome.windows.create with a small
// hidden/minimized window) as the Port anchor instead of relying on the
// popup, which closes automatically on any outside click. Not yet
// implemented/tested - do not assume this file's mechanism works
// popup-closed until re-verified.
let port: chrome.runtime.Port | undefined;
const activeSessionIds = new Set<string>();

chrome.runtime.onConnect.addListener((p) => {
  if (p.name === 'relay-session-keepalive') {
    // No-op listener - existence of the connection is what matters.
    p.onDisconnect.addListener(() => undefined);
  }
});

export function acquireSessionKeepalive(sessionId: string): void {
  activeSessionIds.add(sessionId);
  if (!port) {
    port = chrome.runtime.connect({ name: 'relay-session-keepalive' });
  }
}

export function releaseSessionKeepalive(sessionId: string): void {
  activeSessionIds.delete(sessionId);
  if (activeSessionIds.size === 0 && port) {
    port.disconnect();
    port = undefined;
  }
}
