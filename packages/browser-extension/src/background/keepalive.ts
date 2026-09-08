// MV3 service workers are suspended after ~30s of inactivity; a live
// WebSocket held by a suspended worker is not guaranteed to survive.
// A chrome.alarms periodic wake (well under the 30s idle threshold) keeps
// the worker - and therefore the extension-channel socket - alive. This is
// distinct from connectStateSocket's own message-level reconnect/backoff,
// which handles the socket actually dropping (e.g. server restart).
const KEEPALIVE_ALARM_NAME = 'js-bridge-mcp-keepalive';
const KEEPALIVE_PERIOD_MINUTES = 0.4; // 24s, under the ~30s MV3 idle threshold

export function startKeepalive(onWake: () => void): void {
  chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: KEEPALIVE_PERIOD_MINUTES });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEPALIVE_ALARM_NAME) onWake();
  });
}
