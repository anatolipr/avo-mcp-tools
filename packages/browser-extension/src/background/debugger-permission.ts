// Human confirmation gate + attach/detach bookkeeping for chrome.debugger
// (Phase 4). debugger is Chrome-only (see Firefox note in the plan) -
// declared as a required permission in manifests/chrome.manifest.json
// (Chrome rejects "debugger" in optional_permissions outright - it's one of
// a handful of permissions only grantable at install time, confirmed via
// Chrome's own "Permission 'debugger' cannot be listed as optional" warning)
// - every function here still feature-detects chrome.debugger and
// no-ops/errors clearly on Firefox rather than assuming it exists, and the
// Firefox manifest never declares the permission at all.
//
// Since debugger is now install-time-granted (not something
// chrome.permissions.request can meaningfully gate), the actual
// user-visible moment worth confirming isn't "is the permission granted"
// (trivially yes) but "is it OK to attach right now" - attaching is what
// triggers Chrome's own intrusive "extension is debugging this browser"
// banner on the target tab. The chrome.notifications approval flow below
// exists for THAT confirmation, not a permissions.request() call.
const APPROVAL_NOTIFICATION_ID = 'mcp-debugger-attach-request';
const CDP_VERSION = '1.3';

export function isDebuggerApiAvailable(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.debugger !== 'undefined';
}

// Resolves once the human clicks Approve or Dismiss/closes the notification -
// never rejects, since "not approved" is a normal outcome the caller
// surfaces as a clear tool error, not a crash.
function waitForApprovalClick(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (approved: boolean) => {
      if (settled) return;
      settled = true;
      chrome.notifications.onButtonClicked.removeListener(onButtonClicked);
      chrome.notifications.onClosed.removeListener(onClosed);
      chrome.notifications.clear(APPROVAL_NOTIFICATION_ID);
      resolve(approved);
    };
    function onButtonClicked(notificationId: string, buttonIndex: number) {
      if (notificationId !== APPROVAL_NOTIFICATION_ID) return;
      finish(buttonIndex === 0);
    }
    function onClosed(notificationId: string) {
      if (notificationId === APPROVAL_NOTIFICATION_ID) finish(false);
    }
    chrome.notifications.onButtonClicked.addListener(onButtonClicked);
    chrome.notifications.onClosed.addListener(onClosed);
  });
}

// Called the first time a debugger-needing tool is invoked in a session (see
// builtin-tools.ts). Shows the approval notification and waits for the
// human's click - the agent's tool call blocks on this, surfacing a clear
// "waiting for approval" delay rather than a silent failure, and a clear
// tool error afterward if the human declines.
export async function requestDebuggerApproval(reason: string): Promise<boolean> {
  if (!isDebuggerApiAvailable()) return false;

  await chrome.notifications.create(APPROVAL_NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'js-bridge-mcp Connector wants to debug this tab',
    message: reason,
    buttons: [{ title: 'Approve' }, { title: 'Dismiss' }],
    requireInteraction: true,
  });

  return waitForApprovalClick();
}

const attachedTabs = new Set<number>();

export async function ensureDebuggerAttached(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) return;
  await new Promise<void>((resolve, reject) => {
    chrome.debugger.attach({ tabId }, CDP_VERSION, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      attachedTabs.add(tabId);
      resolve();
    });
  });
}

export function isDebuggerAttached(tabId: number): boolean {
  return attachedTabs.has(tabId);
}

export function startDebuggerDetachTracking(onDetach: (tabId: number) => void): void {
  if (!isDebuggerApiAvailable()) return;
  chrome.debugger.onDetach.addListener((source) => {
    if (typeof source.tabId !== 'number') return;
    attachedTabs.delete(source.tabId);
    onDetach(source.tabId);
  });
}
